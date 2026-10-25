// 원본 로그의 이동 검증·이전 manifest 정리·통계 재집계와 실패 시 보존을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, copyFile, mkdir, mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { SummaryDatabase } from '../../src/summary/db';
import { refreshSummary } from '../../src/summary/scanner';
import type { SummaryOptions } from '../../src/summary/types';

const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n')+'\n';
const user = (id = 'one') => ({type:'user',sessionId:'session',promptId:id,cwd:'/synthetic/project',
  timestamp:'2026-10-01T00:00:00Z',message:{content:'synthetic'}});
const response = (root = 'one', input = 10, id = root) => ({type:'assistant',promptId:root,requestId:id,
  timestamp:'2026-10-01T00:00:02Z',message:{id,model:'claude-sonnet-4-6',stop_reason:'end_turn',usage:{input_tokens:input,output_tokens:2}}});

async function fixture(run: (db: SummaryDatabase, options: SummaryOptions, root: string, base: string) => Promise<void>) {
  const base=await mkdtemp(join(tmpdir(),'agent-tracker-reconnection-'));
  const root=join(base,'logs');await mkdir(root);
  const options: SummaryOptions={dbPath:join(base,'stats.sqlite'),roots:[{provider:'claude',path:root}]};
  const db=new SummaryDatabase(options.dbPath);
  try { await run(db,options,root,base); }
  finally {
    db.close();
    const target=resolve(base);
    assert.equal(dirname(target),resolve(tmpdir()));
    assert.ok(basename(target).startsWith('agent-tracker-reconnection-'));
    await rm(target,{recursive:true,force:true});
  }
}

/** Exercise the content proof on every OS, including when a move changes filesystem identity. */
async function relocate(db: SummaryDatabase, oldPath: string, newPath: string): Promise<void> {
  db.connection.exec("UPDATE manifest SET dev='previous-filesystem'");
  await mkdir(dirname(newPath),{recursive:true});
  await copyFile(oldPath,newPath);await unlink(oldPath);
}

test('repeated moves remove previous paths and rebuild existing requests after appended usage',async()=>fixture(async(db,options,root)=>{
  let current=join(root,'A','session.jsonl');await mkdir(dirname(current));
  await writeFile(current,jsonl([user(),response()]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.match(db.findManifest('claude',current)!.content_hash!,/^[a-f0-9]{64}$/);
  db.setSessionBilling('claude','session','api');
  db.queryUsage({},'day','UTC');
  let expected=12;
  for (const [folder,input] of [['B',20],['C',30]] as const) {
    const next=join(root,folder,'session.jsonl');await relocate(db,current,next);
    await appendFile(next,jsonl([response('one',input,folder)]));expected+=input+2;
    const result=await refreshSummary(db,options);
    assert.equal(result.failed,0);assert.equal(result.interrupted,false);
    assert.equal(db.findManifest('claude',current),undefined);
    assert.equal(db.diagnostics().counts.files,1);
    assert.equal(db.findManifest('claude',next)?.source_missing,0);
    assert.equal(db.queryTurnsCount(),1);assert.equal(db.queryTurns()[0].total_tokens,expected);
    assert.equal(db.queryUsage({},'day','UTC')[0].total_tokens,expected);
    assert.equal(db.sessionBilling('claude','session'),'api');
    current=next;
  }
  const warm=await refreshSummary(db,options);
  assert.equal(warm.parsed,0);assert.equal(warm.bodyBytes,0);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('a later replacement reconnects already retained missing sources',async()=>fixture(async(db,options,root)=>{
  const oldPath=join(root,'old.jsonl'),newPath=join(root,'new.jsonl');
  const source=jsonl([user(),response()]);await writeFile(oldPath,source);
  await refreshSummary(db,options);await unlink(oldPath);await refreshSummary(db,options);
  assert.equal(db.findManifest('claude',oldPath)?.source_missing,1);
  await writeFile(newPath,source+jsonl([response('one',20,'appended')]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.findManifest('claude',oldPath),undefined);
  assert.equal(db.diagnostics().counts.files,1);assert.equal(db.queryTurns()[0].total_tokens,34);
}));

test('changing the selected root reconnects absent sources outside the new scan',async()=>fixture(async(db,options,root,base)=>{
  const oldPath=join(root,'session.jsonl');await writeFile(oldPath,jsonl([user(),response()]));
  await refreshSummary(db,options);db.connection.exec("UPDATE manifest SET dev='previous-filesystem'");
  const newRoot=join(base,'moved-logs');await rename(root,newRoot);
  const result=await refreshSummary(db,{...options,roots:[{provider:'claude',path:newRoot}]});
  assert.equal(result.failed,0);assert.equal(result.interrupted,false);
  assert.equal(db.findManifest('claude',oldPath),undefined);
  assert.equal(db.findManifest('claude',join(newRoot,'session.jsonl'))?.source_root,newRoot);
  assert.equal(db.diagnostics().counts.files,1);assert.equal(db.queryTurns()[0].last_error,null);
}));

test('main and subagent sources reconnect independently when their folder moves',async()=>fixture(async(db,options,root)=>{
  const oldRoot=join(root,'A'),newRoot=join(root,'B');
  const main=join(oldRoot,'session.jsonl'),child=join(oldRoot,'session','subagents','agent.jsonl');
  await mkdir(dirname(child),{recursive:true});
  await writeFile(main,jsonl([user(),response()]));await writeFile(child,jsonl([response('one',20,'child')]));
  assert.equal((await refreshSummary(db,options)).failed,0);assert.equal(db.queryTurns()[0].total_tokens,34);
  const nextMain=join(newRoot,'session.jsonl'),nextChild=join(newRoot,'session','subagents','agent.jsonl');
  await relocate(db,main,nextMain);await relocate(db,child,nextChild);
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.findManifest('claude',main),undefined);assert.equal(db.findManifest('claude',child),undefined);
  assert.equal(db.diagnostics().counts.files,2);assert.equal(db.queryTurns()[0].total_tokens,34);
}));

test('another source with the same session cannot replace a missing source with different contents',async()=>fixture(async(db,options,root)=>{
  const oldPath=join(root,'old.jsonl'),newPath=join(root,'new.jsonl');
  await writeFile(oldPath,jsonl([user(),response()]));await refreshSummary(db,options);
  await unlink(oldPath);await writeFile(newPath,jsonl([user('two'),response('two',20)]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.findManifest('claude',oldPath)?.source_missing,1);
  assert.equal(db.diagnostics().counts.files,2);assert.equal(db.queryTurnsCount(),2);
  assert.equal(db.queryUsage()[0].total_tokens,34);
}));

test('reconnecting one source preserves other missing contributions and remaps retained diagnostics',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'session.jsonl'),child=join(root,'session','subagents','agent.jsonl');
  const nextMain=join(root,'moved','session.jsonl');
  await mkdir(dirname(child),{recursive:true});
  const childSource=jsonl([response('one',20,'child')]);
  await writeFile(main,jsonl([user(),response()]));await writeFile(child,childSource);
  await refreshSummary(db,options);
  const before=db.queryTurns()[0],mainId=db.findManifest('claude',main)!.id;
  db.connection.prepare('UPDATE turn_summary SET diagnostic_file_id=?,last_error=? WHERE id=?').run(mainId,'prior-error',before.id);
  db.connection.prepare('INSERT INTO turn_capability_usage VALUES (?,?,?,?)').run(before.id,'skill','kept',2);
  await relocate(db,main,nextMain);await unlink(child);
  await appendFile(nextMain,jsonl([response('one',20,'extra')]));
  const config={...options,collectCapabilities:false};
  assert.equal((await refreshSummary(db,config)).failed,0);
  assert.equal(db.findManifest('claude',main),undefined);
  assert.equal(db.findManifest('claude',child)?.source_missing,1);
  const retained=db.queryTurns()[0];
  assert.equal(retained.id,before.id);assert.equal(retained.total_tokens,34);
  assert.equal(retained.diagnostic_file_id,db.findManifest('claude',nextMain)!.id);
  assert.equal(db.queryCapabilities({},'skill').totalUses,2);
  await writeFile(child,childSource);assert.equal((await refreshSummary(db,config)).failed,0);
  assert.equal(db.queryTurns()[0].total_tokens,56);assert.equal(db.queryTurns()[0].last_error,null);
  assert.equal(db.queryCapabilities({},'skill').totalUses,2);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('existing sources without fingerprints are backfilled once without discarding usage',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');await writeFile(path,jsonl([user(),response()]));
  await refreshSummary(db,options);
  db.connection.exec('UPDATE manifest SET source_identity=NULL,content_hash=NULL');
  assert.equal((await refreshSummary(db,options)).parsed,1);
  assert.ok(db.findManifest('claude',path)?.source_identity);
  assert.ok(db.findManifest('claude',path)?.content_hash);
  assert.equal(db.queryTurns()[0].total_tokens,12);
  assert.equal((await refreshSummary(db,options)).bodyBytes,0);
}));

test('an empty replacement clears the previous fingerprint and stays reusable',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');await writeFile(path,jsonl([user(),response()]));
  await refreshSummary(db,options);await writeFile(path,'');
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.findManifest('claude',path)?.content_hash,null);
  assert.equal(db.findManifest('claude',path)?.source_identity,null);
  assert.equal(db.queryTurnsCount(),0);
  const warm=await refreshSummary(db,options);
  assert.equal(warm.parsed,0);assert.equal(warm.bodyBytes,0);
}));

test('live copies stay distinct and reconnect only after the former source disappears',async()=>fixture(async(db,options,root)=>{
  const oldPath=join(root,'old.jsonl'),copy=join(root,'copy.jsonl');
  await writeFile(oldPath,jsonl([user(),response()]));await refreshSummary(db,options);await copyFile(oldPath,copy);
  await refreshSummary(db,options);
  assert.equal(db.diagnostics().counts.files,2);assert.equal(db.findManifest('claude',oldPath)?.source_missing,0);
  await unlink(oldPath);assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.findManifest('claude',oldPath),undefined);
  assert.equal(db.diagnostics().counts.files,1);assert.equal(db.queryTurns()[0].total_tokens,12);
}));

test('ambiguous live replacements and legacy missing sources without a fingerprint stay retained',async()=>fixture(async(db,options,root)=>{
  const oldPath=join(root,'old.jsonl'),first=join(root,'first.jsonl'),second=join(root,'second.jsonl');
  await writeFile(oldPath,jsonl([user(),response()]));await refreshSummary(db,options);
  await copyFile(oldPath,first);await copyFile(oldPath,second);await unlink(oldPath);
  await refreshSummary(db,options);
  assert.equal(db.findManifest('claude',oldPath)?.source_missing,1);assert.equal(db.diagnostics().counts.files,3);
  db.connection.exec('UPDATE manifest SET source_identity=NULL,content_hash=NULL WHERE source_missing=1');
  await unlink(second);await refreshSummary(db,options);
  assert.equal(db.findManifest('claude',oldPath)?.source_missing,1);
  assert.equal(db.diagnostics().counts.files,2);assert.equal(db.queryTurns()[0].total_tokens,12);
}));

test('a failed parse or failed cleanup preserves the previous source and retries atomically',async()=>fixture(async(db,options,root)=>{
  const oldPath=join(root,'old.jsonl'),newPath=join(root,'new.jsonl');
  const source=jsonl([user(),response()]);await writeFile(oldPath,source);await refreshSummary(db,options);
  const previous=db.findManifest('claude',oldPath)!;
  await relocate(db,oldPath,newPath);await appendFile(newPath,'{broken}\n');
  assert.equal((await refreshSummary(db,options)).failed,1);
  assert.equal(db.findManifest('claude',oldPath)?.content_hash,previous.content_hash);
  assert.equal(db.queryTurns()[0].total_tokens,12);
  await writeFile(newPath,source+jsonl([response('one',20,'extra')]));
  db.connection.exec(`CREATE TEMP TRIGGER reject_cleanup BEFORE DELETE ON main.manifest
    WHEN old.id=${previous.id} BEGIN SELECT RAISE(ABORT,'synthetic failure'); END;`);
  assert.ok((await refreshSummary(db,options)).failed>0);
  assert.equal(db.findManifest('claude',oldPath)?.content_hash,previous.content_hash);
  assert.equal(db.findManifest('claude',newPath)?.content_hash,null);
  assert.equal(db.queryTurns()[0].total_tokens,12);
  db.connection.exec('DROP TRIGGER reject_cleanup');
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.findManifest('claude',oldPath),undefined);
  assert.equal(db.diagnostics().counts.files,1);assert.equal(db.queryTurns()[0].total_tokens,34);
  assert.equal(db.queryTurns()[0].last_error,null);
}));

test('compressed Codex logs reconnect using raw source fingerprints',async()=>fixture(async(db,options,root)=>{
  const oldPath=join(root,'old.jsonl.zst'),newPath=join(root,'new.jsonl.zst');
  const source=jsonl([{type:'session_meta',payload:{id:'thread',cwd:'/synthetic/project'}},
    {type:'event_msg',payload:{type:'task_started',turn_id:'turn'}},
    {type:'token_usage_record',payload:{thread_id:'thread',turn_id:'turn',root_turn_id:'turn',response_id:'response',
      model:'gpt-5.4',usage:{input_tokens:10,output_tokens:2}}}]);
  await writeFile(oldPath,zstdCompressSync(source));
  const config={...options,roots:[{provider:'codex' as const,path:root}]};
  assert.equal((await refreshSummary(db,config)).failed,0);
  assert.equal(db.queryTurns()[0].total_tokens,12);
  await relocate(db,oldPath,newPath);
  assert.equal((await refreshSummary(db,config)).failed,0);
  assert.equal(db.findManifest('codex',oldPath),undefined);
  assert.equal(db.diagnostics().counts.files,1);assert.equal(db.queryTurns()[0].total_tokens,12);
}));
