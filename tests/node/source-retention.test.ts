// 원본 삭제·부분 유실·복원 시 사용량 보존과 설정 전환을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { SummaryDatabase } from '../../src/summary/db';
import { SummaryClient } from '../../src/summary/client';
import { refreshSummary } from '../../src/summary/scanner';
import type { SummaryOptions } from '../../src/summary/types';

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n')+'\n';
const user = (id: string) => ({type:'user',sessionId:'session',promptId:id,cwd:'/synthetic/project',timestamp:'2026-10-01T00:00:00Z',message:{content:'fixture'}});
const response = (id: string, input = 10, model: string | undefined = 'claude-sonnet-4-6', responseId = id, complete = true) => ({
  type:'assistant',promptId:id,requestId:responseId,timestamp:'2026-10-01T00:00:02Z',message:{id:responseId,model,
    stop_reason:complete?'end_turn':'tool_use',usage:{input_tokens:input,output_tokens:input?2:0}},
});

async function fixture(run: (db: SummaryDatabase, options: SummaryOptions, root: string) => Promise<void>) {
  const base=await mkdtemp(join(tmpdir(),'agent-tracker-retention-'));
  const root=join(base,'projects');await mkdir(root);
  const options: SummaryOptions={dbPath:join(base,'summary.sqlite'),roots:[{provider:'claude',path:root}]};
  const db=new SummaryDatabase(options.dbPath);
  try { await run(db,options,root); }
  finally { db.close();await rm(base,{recursive:true,force:true}); }
}

test('deleting the main source retains its usable request while ignoring orphan-only replacement data',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'session.jsonl'),child=join(root,'session','subagents','agent.jsonl');
  await mkdir(join(root,'session','subagents'),{recursive:true});
  await writeFile(main,jsonl([user('one'),response('one')]));
  await writeFile(child,jsonl([response('one',20,'claude-sonnet-4-6','child')]));
  await refreshSummary(db,options);const before=db.queryUsage({}, 'session')[0];
  assert.equal(before.total_tokens,34);
  await unlink(main);assert.equal((await refreshSummary(db,options)).failed,0);
  assert.deepEqual(db.queryUsage({}, 'session')[0],before);assert.equal(db.findSourceFile('claude',main)?.source_missing,1);
}));

test('a remaining source parse failure still retains usable deleted-source history',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'session.jsonl'),copy=join(root,'copy.jsonl');
  const source=jsonl([user('one'),response('one')]);await writeFile(main,source);await writeFile(copy,source);
  await refreshSummary(db,options);const before=db.queryUsage();
  await unlink(copy);await appendFile(main,'{broken}\n');
  assert.equal((await refreshSummary(db,options)).failed,1);
  assert.deepEqual(db.queryUsage(),before);assert.equal(db.queryUsage()[0].total_tokens,12);
  assert.equal(db.findSourceFile('claude',main)?.last_error,'parse-error');assert.equal(db.findSourceFile('claude',copy)?.source_missing,1);
}));

test('unknown models and zero usage are removed with their last source and disabling retention removes previously retained data',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');
  await writeFile(path,jsonl([user('unknown'),response('unknown',10,''),user('empty'),response('empty',0)]));
  await refreshSummary(db,options);await unlink(path);await refreshSummary(db,options);
  assert.equal(db.queryTurnsCount(),0);assert.equal(db.findSourceFile('claude',path),undefined);
  await writeFile(path,jsonl([user('known'),response('known')]));await refreshSummary(db,options);
  await unlink(path);await refreshSummary(db,options);assert.equal(db.queryTurnsCount(),1);
  await refreshSummary(db,{...options,retainDeletedSourceUsage:false});
  assert.equal(db.queryTurnsCount(),0);assert.equal(db.findSourceFile('claude',path),undefined);
  assert.equal(db.queryUsage().length,0);
}));

test('compressed Codex usage survives deletion and reopening with its model, session and missing timing intact',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'codex.jsonl.zst');
  const source=zstdCompressSync(Buffer.from(jsonl([
    {type:'session_meta',payload:{id:'codex-session',cwd:'/synthetic/project'}},
    {type:'token_usage_record',payload:{turn_id:'one',root_turn_id:'one',response_id:'one',model:'gpt-6.1-sol',usage:{input_tokens:10,output_tokens:3}}},
  ])));
  const config={...options,roots:[{provider:'codex' as const,path:root}]};
  await writeFile(path,source);assert.equal((await refreshSummary(db,config)).failed,0);
  const before=db.queryUsage({}, 'session')[0];assert.equal(before.avg_duration_ms,null);assert.equal(before.session_id,'codex-session');
  await unlink(path);assert.equal((await refreshSummary(db,config)).failed,0);assert.deepEqual(db.queryUsage({}, 'session')[0],before);
  const reopened=new SummaryDatabase(options.dbPath);
  try {
    assert.deepEqual(reopened.queryUsage({}, 'session')[0],before);
    assert.equal(reopened.findSourceFile('codex',path)?.source_missing,1);
    assert.equal(reopened.queryUsagePage({},'total','UTC',{},'model').rows[0].model,'gpt-6.1-sol');
    assert.equal((await refreshSummary(reopened,config)).bodyBytes,0);
    await writeFile(path,source);assert.equal((await refreshSummary(reopened,config)).failed,0);
    assert.equal(reopened.queryTurnsCount(),1);assert.equal(reopened.findSourceFile('codex',path)?.source_missing,0);
  } finally { reopened.close(); }
}));

test('a named model with positive output keeps the full daily summary when the source disappears',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');
  const outputOnly=response('output',0);outputOnly.message.usage.output_tokens=5;
  await writeFile(path,jsonl([user('output'),outputOnly,user('mixed'),response('mixed',0),response('mixed',10,'','unknown')]));
  await refreshSummary(db,options);await unlink(path);assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurnsCount(),2);assert.equal(db.queryUsage()[0].total_tokens,17);
}));

test('the worker applies retention changes on the next explicit refresh and clear removes retained history',async()=>fixture(async(_db,options,root)=>{
  const path=join(root,'session.jsonl');await writeFile(path,jsonl([user('one'),response('one')]));
  const client=new SummaryClient(options);
  try {
    await client.refresh();await unlink(path);await client.refresh();assert.equal((await client.query({groupBy:'turn'})).total,1);
    await client.setDeletedSourceRetentionEnabled(false);assert.equal((await client.query({groupBy:'turn'})).total,1);
    await client.refresh();assert.equal((await client.query({groupBy:'turn'})).total,0);
    await client.setDeletedSourceRetentionEnabled(true);
    await writeFile(path,jsonl([user('two'),response('two')]));await client.refresh();await unlink(path);await client.refresh();
    assert.equal((await client.query({groupBy:'turn'})).total,1);
    await client.clearData();assert.equal((await client.query({groupBy:'turn'})).total,0);
  } finally { await client.dispose(); }
}));

test('retaining a missing source preserves its day while later activity is collected separately', async () => fixture(async (db, options, root) => {
  const old = join(root, 'old.jsonl');
  await writeFile(old, jsonl([user('old'), response('old')]));
  await refreshSummary(db, options);
  db.setSessionBilling('claude', 'session', 'api');
  const firstDay = db.queryUsage({includeCosts:true}, 'day')[0];
  assert.equal(firstDay.total_tokens, 12);
  await unlink(old);
  const next = [user('next'), response('next', 30)].map(row => ({...row, timestamp: row.timestamp.replace('10-01','10-02'), ...('sessionId' in row ? {sessionId:'next-session'} : {})}));
  await writeFile(join(root, 'next.jsonl'), jsonl(next));
  assert.equal((await refreshSummary(db, options)).failed, 0);
  const daily = db.queryUsage({includeCosts:true}, 'day');
  assert.deepEqual(daily.map(row => [row.period,row.total_tokens]), [['2026-10-01',12],['2026-10-02',32]]);
  assert.deepEqual(daily[0],firstDay);
  assert.equal(db.findSourceFile('claude',old)?.source_missing,1);
  assert.equal(db.sessionBilling('claude','session'),'api');
  assert.equal((await refreshSummary(db, options)).bodyBytes,0);
}));
