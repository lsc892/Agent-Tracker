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

test('deleted sources retain known positive usage despite warnings, failed/running status and reparse errors',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');
  const rows=[user('warned'),response('warned'),user('failed'),response('failed'),
    {type:'assistant',promptId:'failed',isApiErrorMessage:true,error:'rate_limit',timestamp:'2026-10-01T00:00:03Z',message:{usage:{input_tokens:0,output_tokens:0}}},
    user('running'),response('running',20,'claude-sonnet-4-6','running',false),
    user('unknown'),response('unknown',30,''),user('empty'),response('empty',0)];
  await writeFile(path,jsonl(rows));assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='failed')?.status,'failed');
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='running')?.status,'in_progress');
  assert.match(db.queryTurns().find(row=>row.root_turn_id==='warned')!.quality_flags!,/duration-approximate/);
  db.setSessionBilling('claude','session','api');
  const warned=db.queryTurns().find(row=>row.root_turn_id==='warned')!;
  db.connection.prepare('INSERT INTO turn_capability_usage VALUES (?,?,?,?)').run(warned.id,'skill','fixture-skill',3);
  db.queryUsage({},'day','UTC'); // Warm rollups before retention changes the stored facts.
  await appendFile(path,'{broken}\n');assert.equal((await refreshSummary(db,options)).failed,1);
  const before=db.queryTurns({includeCosts:true}).filter(row=>['warned','failed','running'].includes(row.root_turn_id));
  assert.ok(before.every(row=>row.last_error==='parse-error'));
  await unlink(path);assert.equal((await refreshSummary(db,options)).failed,0);
  assert.deepEqual(db.queryTurns({includeCosts:true}),before);
  assert.equal(db.queryCapabilities({},'skill').totalUses,3);
  assert.equal(db.queryUsage({},'day','UTC')[0].total_tokens,46);
  assert.equal(db.queryUsage({},'day','UTC',{},'model')[0].total_tokens,46);
  assert.equal(db.findManifest('claude',path)?.source_missing,1);
  assert.equal(db.sessionBilling('claude','session'),'api');
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
  const warm=await refreshSummary(db,options);assert.equal(warm.bodyBytes,0);assert.equal(warm.failed,0);
  db.clearData();assert.equal(db.queryTurnsCount(),0);assert.equal(db.diagnostics().counts.files,0);
}));

test('partial source loss freezes existing requests, collects new requests and a restoration rebuilds without duplicates',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'session.jsonl'),child=join(root,'session','subagents','agent.jsonl');
  await mkdir(join(root,'session','subagents'),{recursive:true});
  await writeFile(main,jsonl([user('one'),response('one')]));
  const childSource=jsonl([response('one',20,'claude-sonnet-4-6','child')]);await writeFile(child,childSource);
  assert.equal((await refreshSummary(db,options)).failed,0);
  const before=db.queryTurns()[0];assert.equal(before.total_tokens,34);
  db.connection.prepare('INSERT INTO turn_capability_usage VALUES (?,?,?,?)').run(before.id,'skill','kept',2);
  db.queryUsage({},'day','UTC');
  await unlink(child);assert.equal((await refreshSummary(db,{...options,collectCapabilities:false})).failed,0);
  assert.deepEqual(db.queryTurns()[0],before);assert.equal(db.queryCapabilities({},'skill').totalUses,2);
  assert.equal(db.findManifest('claude',child)?.source_missing,1);
  const warm=await refreshSummary(db,{...options,collectCapabilities:false});assert.equal(warm.parsed,0);assert.equal(warm.bodyBytes,0);
  await appendFile(main,jsonl([response('one',5,'claude-sonnet-4-6','extra'),user('two'),response('two',30)]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='one')?.total_tokens,34);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='one')?.id,before.id);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='two')?.total_tokens,32);
  assert.equal(db.queryUsage({},'day','UTC')[0].total_tokens,66);
  await writeFile(child,childSource);assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurnsCount(),2);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='one')?.total_tokens,41);
  assert.equal(db.findManifest('claude',child)?.source_missing,0);
  assert.equal(db.queryUsage({},'day','UTC')[0].total_tokens,73);
}));

test('deleting the main source retains its usable request while ignoring orphan-only replacement data',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'session.jsonl'),child=join(root,'session','subagents','agent.jsonl');
  await mkdir(join(root,'session','subagents'),{recursive:true});
  await writeFile(main,jsonl([user('one'),response('one')]));
  await writeFile(child,jsonl([response('one',20,'claude-sonnet-4-6','child')]));
  await refreshSummary(db,options);const before=db.queryTurns()[0];
  await unlink(main);assert.equal((await refreshSummary(db,options)).failed,0);
  assert.deepEqual(db.queryTurns()[0],before);assert.equal(db.findManifest('claude',main)?.source_missing,1);
}));

test('a remaining source parse failure still retains usable deleted-source history',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'session.jsonl'),copy=join(root,'copy.jsonl');
  const source=jsonl([user('one'),response('one')]);await writeFile(main,source);await writeFile(copy,source);
  await refreshSummary(db,options);const id=db.queryTurns()[0].id;
  await unlink(copy);await appendFile(main,'{broken}\n');
  assert.equal((await refreshSummary(db,options)).failed,1);
  assert.equal(db.queryTurns()[0].id,id);assert.equal(db.queryTurns()[0].total_tokens,12);
  assert.equal(db.queryTurns()[0].last_error,'parse-error');assert.equal(db.findManifest('claude',copy)?.source_missing,1);
}));

test('unknown models and zero usage are removed with their last source and disabling retention removes previously retained data',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');
  await writeFile(path,jsonl([user('unknown'),response('unknown',10,''),user('empty'),response('empty',0)]));
  await refreshSummary(db,options);await unlink(path);await refreshSummary(db,options);
  assert.equal(db.queryTurnsCount(),0);assert.equal(db.findManifest('claude',path),undefined);
  await writeFile(path,jsonl([user('known'),response('known')]));await refreshSummary(db,options);
  await unlink(path);await refreshSummary(db,options);assert.equal(db.queryTurnsCount(),1);
  await refreshSummary(db,{...options,retainDeletedSourceUsage:false});
  assert.equal(db.queryTurnsCount(),0);assert.equal(db.findManifest('claude',path),undefined);
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
  const before=db.queryTurns()[0];assert.equal(before.duration_quality,'missing');assert.equal(before.session_id,'codex-session');
  await unlink(path);assert.equal((await refreshSummary(db,config)).failed,0);assert.deepEqual(db.queryTurns()[0],before);
  const reopened=new SummaryDatabase(options.dbPath);
  try {
    assert.deepEqual(reopened.queryTurns()[0],before);
    assert.equal(reopened.findManifest('codex',path)?.source_missing,1);
    assert.equal(reopened.queryCumulative({},'model').rows[0].model,'gpt-6.1-sol');
    assert.equal((await refreshSummary(reopened,config)).bodyBytes,0);
    await writeFile(path,source);assert.equal((await refreshSummary(reopened,config)).failed,0);
    assert.equal(reopened.queryTurnsCount(),1);assert.equal(reopened.findManifest('codex',path)?.source_missing,0);
  } finally { reopened.close(); }
}));

test('positive output alone is retainable but a zero-token named model cannot qualify unknown positive usage',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');
  const outputOnly=response('output',0);outputOnly.message.usage.output_tokens=5;
  await writeFile(path,jsonl([user('output'),outputOnly,user('mixed'),response('mixed',0),response('mixed',10,'','unknown')]));
  await refreshSummary(db,options);await unlink(path);assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurnsCount(),1);assert.equal(db.queryTurns()[0].root_turn_id,'output');assert.equal(db.queryTurns()[0].total_tokens,5);
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
