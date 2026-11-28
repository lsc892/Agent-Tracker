// 스트리밍 winner 집계·응답별 증분·최종 저장의 원자성을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { SummaryDatabase, type TurnSummaryInput } from '../../src/summary/db';
import { ageLogFixtures } from '../fixtures/summary-mtime';
import { refreshSummary } from '../../src/summary/scanner';
import type { SummaryOptions } from '../../src/summary/types';

const jsonl=(rows:unknown[]):string=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
const user=(root='root')=>({type:'user',sessionId:'session',promptId:root,cwd:'/synthetic/project',
  timestamp:'2026-11-01T00:00:00Z',message:{content:'Fixture request'}});
const response=(input=100,root='root',id='response')=>({type:'assistant',promptId:root,requestId:id,
  timestamp:'2026-11-01T00:00:02Z',message:{id,model:'claude-sonnet-4-6',stop_reason:'end_turn',
    usage:{input_tokens:input,output_tokens:2}}});

async function fixture(run:(db:SummaryDatabase,options:SummaryOptions,root:string)=>Promise<void>):Promise<void>{
  const directory=await mkdtemp(join(tmpdir(),'agent-tracker-memory-incremental-'));
  const root=join(directory,'logs');await mkdir(root);
  const options:SummaryOptions={dbPath:join(directory,'summary.sqlite'),roots:[{provider:'claude',path:root}],retainDeletedSourceUsage:false};
  const db=new SummaryDatabase(options.dbPath);
  try{await run(db,options,root);}finally{db.close();await rm(directory,{recursive:true,force:true});}
}

const finalRow=(input=100):TurnSummaryInput=>({provider:'codex',session_id:'session',root_turn_id:'root',
  project_key:'project',project_name:'Project',started_at_ms:1000,completed_at_ms:2000,duration_ms:1000,
  duration_quality:'derived',status:'completed',input_tokens:input,output_tokens:2,total_tokens:input+2,
  cache_read_input_tokens:0,cache_write_input_tokens:0,model_usage:[{model:'gpt-5.6-sol',input_tokens:input,
    output_tokens:2,cache_read_input_tokens:0,cache_write_input_tokens:0}],
  capability_usage:[{category:'skill',name:'example',usage_count:1}],billing:'api'});

test('final memory replacement creates no TEMP tables, keeps identical facts untouched and rolls back failed writes',()=>{
  const db=new SummaryDatabase(':memory:');
  try{
    const replacement={sessions:[{provider:'codex' as const,session_id:'session'}],files:[],summaries:[finalRow()]};
    db.replaceMemory(replacement);
    const before=db.queryTurns();assert.equal(before.length,1);
    assert.deepEqual(db.connection.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all(),[]);
    db.connection.exec(`CREATE TABLE memory_writes(operation TEXT);
      CREATE TRIGGER memory_update AFTER UPDATE ON turn_summary BEGIN INSERT INTO memory_writes VALUES('update'); END;
      CREATE TRIGGER memory_insert AFTER INSERT ON turn_summary BEGIN INSERT INTO memory_writes VALUES('insert'); END;
      CREATE TRIGGER memory_delete AFTER DELETE ON turn_summary BEGIN INSERT INTO memory_writes VALUES('delete'); END;`);
    db.replaceMemory({...replacement,summaries:[finalRow()]});
    assert.deepEqual(db.queryTurns(),before);
    assert.equal(db.connection.prepare('SELECT count(*) n FROM memory_writes').get()?.n,0);
    db.connection.exec(`CREATE TRIGGER fail_memory_write BEFORE UPDATE ON turn_summary BEGIN SELECT RAISE(ABORT,'blocked final write'); END;`);
    assert.throws(()=>db.replaceMemory({...replacement,summaries:[finalRow(200)]}),/blocked final write/);
    assert.deepEqual(db.queryTurns(),before);assert.equal(db.connection.prepare('SELECT count(*) n FROM memory_writes').get()?.n,0);
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.deepEqual(db.connection.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all(),[]);
  }finally{db.close();}
});

test('refresh rebuilds the affected session once and adds only the new response',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'main.jsonl'),sibling=join(root,'copy.jsonl');
  await writeFile(main,jsonl([user(),response()]));await writeFile(sibling,jsonl([user(),response(50)]));
  ageLogFixtures(main,sibling);
  const initial=await refreshSummary(db,options);assert.equal(initial.failed,0);assert.equal(initial.parsed,2);
  assert.deepEqual(db.connection.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all(),[],
    'the refresh path must not leave event, winner, prepared or replacement staging tables');
  const unchanged=await refreshSummary(db,options);assert.equal(unchanged.failed,0);assert.equal(unchanged.parsed,0);assert.equal(unchanged.bodyBytes,0);
  await appendFile(main,jsonl([user('extra'),response(20,'extra','extra-response')]));
  const changed=await refreshSummary(db,options);assert.equal(changed.failed,0);
  assert.equal(changed.parsed,2);
  assert.equal(changed.bodyBytes,(await stat(main)).size+(await stat(sibling)).size);
  assert.equal(db.queryTurns().reduce((sum,row)=>sum+row.total_tokens,0),124);
  assert.deepEqual(db.connection.prepare("SELECT name FROM sqlite_temp_master WHERE type='table'").all(),[]);
}));

test('a reopened database adds only new child usage and preserves the accepted total after removal', async () => fixture(async (db, options, root) => {
  const main = join(root, 'parent.jsonl');
  const child = join(root, 'child.jsonl');
  const usage = (thread: string, turn: string, id: string, input: number, total: number, model = 'gpt-5.6-sol') => ({
    type: 'token_usage_record', payload: {
      thread_id: thread, turn_id: turn, root_turn_id: 'root', response_id: id, model,
      usage: { input_tokens: input, output_tokens: 0 },
      turn_token_usage: { input_tokens: total, output_tokens: 0 },
    },
  });
  const start = (turn: string) => ({ type: 'turn_context', payload: { turn_id: turn, root_turn_id: 'root' } });
  await writeFile(main, jsonl([
    { type: 'session_meta', payload: { id: 'parent', cwd: '/synthetic/project' } },
    start('shared-turn'), usage('parent', 'shared-turn', 'growing-response', 60, 60),
  ]));
  await writeFile(child, jsonl([
    { type: 'session_meta', payload: { id: 'child', parent_thread_id: 'parent' } },
    start('shared-turn'), usage('child', 'shared-turn', 'growing-response', 40, 40),
  ]));
  ageLogFixtures(main, child);
  const codexOptions: SummaryOptions = { ...options, roots: [{ provider: 'codex', path: root }], retainDeletedSourceUsage: true };
  const accepted = async (database: SummaryDatabase, tokens: number) => {
    const refresh = await refreshSummary(database, codexOptions);
    assert.equal(refresh.failed, 0);
    assert.equal(refresh.interrupted, false);
    const rows = database.queryTurns();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].session_id, 'parent');
    assert.equal(rows[0].root_turn_id, 'root');
    assert.equal(rows[0].total_tokens, tokens);
    assert.doesNotMatch(rows[0].quality_flags ?? '', /token-total-mismatch/);
    return refresh;
  };
  await accepted(db, 100);
  db.close();
  const reopened = new SummaryDatabase(options.dbPath);
  try {
    const appended = [
      usage('child', 'shared-turn', 'growing-response', 55, 55, 'gpt-5.4'),
      usage('child', 'shared-turn', 'new-response', 10, 65),
    ];
    await appendFile(child, jsonl(appended));
    const increment = await accepted(reopened, 125);
    assert.equal(increment.parsed, 2);
    assert.equal(increment.bodyBytes, (await stat(main)).size + (await stat(child)).size);
    await appendFile(child, jsonl(appended));
    await accepted(reopened, 125);
    const applied = () => reopened.connection.prepare(`SELECT summary.root_turn_id, response.response_key, response.input_tokens
      FROM applied_response AS response JOIN turn_summary AS summary ON summary.id=response.turn_id
      ORDER BY response.response_key`).all().map(row => [row.root_turn_id, row.response_key, row.input_tokens]);
    const expected = [
      ['root', JSON.stringify(['growing-response', 'child', 'shared-turn']), 55],
      ['root', JSON.stringify(['growing-response', 'parent', 'shared-turn']), 60],
      ['root', JSON.stringify(['new-response', 'child', 'shared-turn']), 10],
    ];
    assert.deepEqual(applied(), expected);
    assert.deepEqual(reopened.connection.prepare('SELECT model,input_tokens FROM turn_model_usage ORDER BY model').all()
      .map(row => ({ ...row })), [
      { model: 'gpt-5.4', input_tokens: 55 },
      { model: 'gpt-5.6-sol', input_tokens: 70 },
    ]);
    await unlink(child);
    await accepted(reopened, 125);
    assert.deepEqual(applied(), expected);
    assert.deepEqual(reopened.connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { reopened.close(); }
}));

test('reopening and rebuilding after a rewrite or a non-retained removal preserves winner selection',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'main.jsonl'),copy=join(root,'copy.jsonl');
  const strongest=response(200);
  strongest.message.model='claude-opus-4-6';
  await writeFile(main,jsonl([user(),response()]));await writeFile(copy,jsonl([user(),strongest]));
  ageLogFixtures(main,copy);
  assert.equal((await refreshSummary(db,options)).failed,0);assert.equal(db.queryTurns()[0].total_tokens,202);
  assert.equal(db.queryUsage({},'total','UTC',{},'model')[0].model,'claude-opus-4-6');

  const reopened=new SummaryDatabase(options.dbPath);
  try{
    const weaker=response(30);
    weaker.message.model='claude-opus-4-6';
    const replacement=jsonl([user(),weaker]);
    await writeFile(copy,replacement);
    await delay(16);
    const rewritten=await refreshSummary(reopened,options);
    assert.equal(rewritten.failed,0);
    assert.equal(rewritten.parsed,2);
    assert.equal(rewritten.bodyBytes,Buffer.byteLength(replacement)+(await stat(main)).size);
    assert.equal(reopened.queryTurns()[0].total_tokens,102);
    assert.equal(reopened.queryUsage({},'total','UTC',{},'model')[0].model,'claude-sonnet-4-6');

    await unlink(main);
    const deleted=await refreshSummary(reopened,options);
    assert.equal(deleted.failed,0);assert.equal(deleted.parsed,1);assert.equal(deleted.bodyBytes,Buffer.byteLength(replacement));
    assert.equal(reopened.queryTurns()[0].total_tokens,32);
    assert.equal(reopened.queryUsage({},'total','UTC',{},'model')[0].model,'claude-opus-4-6');
    await unlink(copy);assert.equal((await refreshSummary(reopened,options)).failed,0);
    assert.equal(reopened.queryTurns().length,0);
    assert.deepEqual(reopened.connection.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{reopened.close();}
}));

test('a failed final transaction preserves applied responses and facts until a successful retry',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');await writeFile(path,jsonl([user(),response()]));
  assert.equal((await refreshSummary(db,options)).failed,0);const original=db.queryTurns()[0];
  const responses=()=>db.connection.prepare(`SELECT summary.provider,summary.session_id,summary.root_turn_id,response.*
    FROM applied_response AS response JOIN turn_summary AS summary ON summary.id=response.turn_id
    ORDER BY summary.provider,summary.session_id,response.response_key`).all();
  const originalRows=responses();
  assert.equal(originalRows.length,1);
  await appendFile(path,jsonl([user('new'),response(20,'new','new-response')]));
  db.connection.exec(`CREATE TRIGGER reject_new_memory_request BEFORE INSERT ON turn_summary WHEN NEW.root_turn_id='new'
    BEGIN SELECT RAISE(ABORT,'reject candidate'); END;`);
  assert.ok((await refreshSummary(db,options)).failed>0);assert.equal(db.queryTurns().length,1);
  assert.equal(db.queryTurns()[0].total_tokens,original.total_tokens);
  assert.deepEqual(responses(),originalRows);
  db.connection.exec('DROP TRIGGER reject_new_memory_request');
  const retried=await refreshSummary(db,options);assert.equal(retried.failed,0);assert.equal(retried.parsed,1);
  assert.equal(db.queryTurns().length,2);assert.equal(db.queryTurns().reduce((n,row)=>n+row.total_tokens,0),124);
  assert.equal(responses().length,2);
}));

test('partial appends wait for newline and malformed rewrites preserve the last accepted result',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');await writeFile(path,jsonl([user(),response()]));await refreshSummary(db,options);
  const partial=JSON.stringify(response(200));await appendFile(path,partial);
  assert.equal((await refreshSummary(db,options)).failed,0);assert.equal(db.queryTurns()[0].total_tokens,102);
  await appendFile(path,'\n');assert.equal((await refreshSummary(db,options)).failed,0);assert.equal(db.queryTurns()[0].total_tokens,202);
  await writeFile(path,'{invalid json}\n');assert.ok((await refreshSummary(db,options)).failed>0);assert.equal(db.queryTurns()[0].total_tokens,202);
  await writeFile(path,jsonl([user(),response(50)]));assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns()[0].total_tokens,52);
}));

test('state DB titles keep higher priority than a later data home index for the same session',async()=>fixture(async(db,options,root)=>{
  const base=dirname(root),secondRoot=join(base,'second-logs'),firstHome=join(base,'first-home'),secondHome=join(base,'second-home');
  for(const directory of [secondRoot,firstHome,secondHome])await mkdir(directory);
  const names=new DatabaseSync(join(firstHome,'state_5.sqlite'));
  try{names.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT); INSERT INTO threads VALUES('session','automatic title','preferred state title')");}
  finally{names.close();}
  await writeFile(join(secondHome,'session_index.jsonl'),jsonl([{id:'session',thread_name:'lower priority later index'}]));
  const transcript=join(root,'session.jsonl');
  await writeFile(transcript,jsonl([
    {type:'session_meta',payload:{id:'session',cwd:'/synthetic/project'}},
    {type:'event_msg',timestamp:'2026-11-01T00:00:00Z',payload:{type:'task_started',turn_id:'root',root_turn_id:'root'}},
    {type:'token_usage_record',payload:{turn_id:'root',root_turn_id:'root',response_id:'response',model:'gpt-5.6-sol',
      usage:{input_tokens:100,output_tokens:2}}},
  ]));
  const old = new Date('2020-01-01T00:00:00Z');
  await utimes(transcript,old,old);
  const codexOptions:SummaryOptions={...options,roots:[{provider:'codex',path:root,dataHome:firstHome},
    {provider:'codex',path:secondRoot,dataHome:secondHome}]};
  assert.equal((await refreshSummary(db,codexOptions)).failed,0);
  assert.equal(db.queryTurns()[0].session_name,'preferred state title');
  assert.equal((await refreshSummary(db,codexOptions)).parsed,0);
  assert.equal(db.queryTurns()[0].session_name,'preferred state title');
}));

test('an accepted file rewritten to an incomplete first line waits without stale diagnostics or fact changes',async()=>fixture(async(db,options,root)=>{
  const path=join(root,'session.jsonl');await writeFile(path,jsonl([user(),response()]));
  assert.equal((await refreshSummary(db,options)).failed,0);const before=db.queryTurns();
  await writeFile(path,JSON.stringify(user()));
  const waiting=await refreshSummary(db,options);
  assert.equal(waiting.failed,0);assert.equal(waiting.interrupted,false);
  assert.equal(db.findSourceFile('claude',path)?.processing_status,'done');
  assert.equal(db.findSourceFile('claude',path)?.last_error,null);
  assert.deepEqual(db.queryTurns(),before,'an incomplete replacement cannot invalidate accepted facts');
  await appendFile(path,'\n'+jsonl([response(200)]));
  assert.equal((await refreshSummary(db,options)).failed,0);assert.equal(db.queryTurns()[0].total_tokens,202);
}));

test('new sources and changed sources break equal-score ties by source_file parse order',async()=>fixture(async(db,options,root)=>{
  const existing=join(root,'z-existing.jsonl'),added=join(root,'a-new.jsonl');
  const source=(rootId:string,model:string)=>jsonl([user(rootId),{...response(100,rootId,'shared'),
    message:{...response(100,rootId,'shared').message,model}}]);
  await writeFile(existing,source('existing','claude-sonnet-4-6'));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const firstId=db.findSourceFile('claude',existing)!.id;
  await writeFile(added,source('added','claude-opus-4-7'));
  await writeFile(existing,source('existing','claude-sonnet-4-6')+jsonl([{type:'progress'}]));
  const refreshed=await refreshSummary(db,options);assert.equal(refreshed.failed,0);assert.equal(refreshed.parsed,2);
  assert.ok(db.findSourceFile('claude',added)!.id>firstId);
  const rows=db.queryTurns();
  assert.equal(rows.find(row=>row.root_turn_id==='existing')!.total_tokens,0);
  assert.equal(rows.find(row=>row.root_turn_id==='added')!.total_tokens,102,
    'both changed sources follow accepted source_file order rather than current directory enumeration');
  assert.equal(db.queryTurns({}, {},'model').find(row=>row.root_turn_id==='added')!.model,'claude-opus-4-7');
}));

test('lineage identifiers use SQLite UTF-8 normalization while raw source identity stays reproducible',async()=>fixture(async(db,options,root)=>{
  const parent=join(root,'parent.jsonl'),child=join(root,'child.jsonl');
  const usage=(responseId:string,turn:string,input:number)=>({type:'token_usage_record',payload:{
    root_turn_id:'root',turn_id:turn,response_id:responseId,model:'gpt-5.6-sol',usage:{input_tokens:input,output_tokens:2}}});
  await writeFile(parent,jsonl([{type:'session_meta',payload:{id:'\ud800',cwd:'/synthetic/project'}},
    {type:'event_msg',payload:{type:'task_started',root_turn_id:'root',turn_id:'root'}},usage('parent','root',10)]));
  await writeFile(child,jsonl([{type:'session_meta',payload:{id:'child',parent_thread_id:'\ud801',cwd:'/synthetic/project'}},
    {type:'event_msg',payload:{type:'task_started',root_turn_id:'root',turn_id:'child-turn'}},usage('child','child-turn',20)]));
  const codexOptions:SummaryOptions={...options,roots:[{provider:'codex',path:root,dataHome:root}]};
  const refreshed=await refreshSummary(db,codexOptions);assert.equal(refreshed.failed,0);assert.equal(refreshed.interrupted,false);
  const rows=db.queryTurns();assert.equal(rows.length,1);assert.equal(rows[0].session_id,'\ufffd');assert.equal(rows[0].total_tokens,34);
  assert.doesNotMatch(rows[0].quality_flags??'',/missing-parent-agent/);
  assert.equal(db.findSourceFile('codex',parent)?.source_identity,JSON.stringify(['\ud800',true]));
}));
