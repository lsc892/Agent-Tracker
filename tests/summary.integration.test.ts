import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, appendFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryDatabase } from '../src/summary/db';
import { refreshSummary } from '../src/summary/scanner';
import { SummaryClient } from '../src/summary/client';
import type { SummaryOptions } from '../src/summary/types';
import { acquireRefreshLock } from '../src/summary/lock';

const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const user = (root = 'prompt-one', session = 'session-one') => ({type:'user',sessionId:session,promptId:root,cwd:'/workspace/project',timestamp:'2026-10-01T00:00:00Z',message:{content:'synthetic prompt'}});
const response = (tokens = 100, root = 'prompt-one', id = 'response-one', request: string | undefined = 'req-one') => ({type:'assistant',promptId:root,requestId:request,timestamp:'2026-10-01T00:00:03Z',message:{id,stop_reason:'end_turn',usage:{input_tokens:tokens,cache_creation_input_tokens:30,cache_read_input_tokens:60,output_tokens:10}}});

async function fixture(run: (database: SummaryDatabase, options: SummaryOptions, root: string, base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(),'agent-tracker-summary-'));
  const root = join(base,'projects');await mkdir(root);
  const options: SummaryOptions = {dbPath:join(base,'summary.sqlite'),roots:[{provider:'claude',path:root}],batchSize:2};
  const database = new SummaryDatabase(options.dbPath);
  try { await run(database,options,root,base); }
  finally { database.close();await rm(base,{recursive:true,force:true}); }
}

test('session rebuild deduplicates full vectors, includes subagent tokens, and reuses unchanged bodies',async () => fixture(async (database,options,root) => {
  await mkdir(join(root,'session-one','subagents'),{recursive:true});
  await writeFile(join(root,'session-one.jsonl'),jsonl([user(),response(50),response(100),
    {type:'system',subtype:'turn_duration',promptId:'prompt-one',durationMs:1000,timestamp:'2026-10-01T00:00:03Z'}]));
  await writeFile(join(root,'session-one','subagents','agent-a.jsonl'),jsonl([response(30,'prompt-one','sub-response','sub-request'),
    {type:'system',subtype:'turn_duration',promptId:'prompt-one',durationMs:8000}]));
  const first = await refreshSummary(database,options);
  assert.equal(first.failed,0);assert.equal(first.parsed,2);
  const rows = database.queryTurns();assert.equal(rows.length,1);
  assert.equal(rows[0].total_tokens,330);assert.equal(rows[0].duration_ms,1000);
  const unchanged = await refreshSummary(database,options);
  assert.equal(unchanged.bodyBytes,0);assert.equal(unchanged.reused,2);
}));

test('append, truncated rewrite, winner deletion and fresh rebuild agree',async () => fixture(async (database,options,root,base) => {
  const main = join(root,'session-one.jsonl');const clone = join(root,'clone.jsonl');
  await writeFile(main,jsonl([user(),response(100)]));
  await writeFile(clone,jsonl([user(),response(200)]));
  await refreshSummary(database,options);assert.equal(database.queryTurns()[0].total_tokens,300);
  await unlink(clone);
  await refreshSummary(database,options);assert.equal(database.queryTurns()[0].total_tokens,200);
  await appendFile(main,jsonl([response(80,'prompt-one','response-two','req-two')]));
  await refreshSummary(database,options);assert.equal(database.queryTurns()[0].total_tokens,380);
  await writeFile(main,jsonl([user(),response(20)]));
  await refreshSummary(database,options);assert.equal(database.queryTurns()[0].total_tokens,120);
  const fresh = new SummaryDatabase(join(base,'fresh.sqlite'));
  try {
    await refreshSummary(fresh,{...options,dbPath:join(base,'fresh.sqlite')});
    assert.equal(fresh.queryTurns()[0].total_tokens,database.queryTurns()[0].total_tokens);
  } finally {fresh.close();}
  await unlink(main);await refreshSummary(database,options);
  assert.equal(database.queryTurns().length,0);assert.equal(database.diagnostics().counts.files,0);
}));

test('parse failure preserves accepted metadata and summary; later user refresh retries',async () => fixture(async (database,options,root) => {
  const main = join(root,'session-one.jsonl');
  await writeFile(main,jsonl([user(),response()]));await refreshSummary(database,options);
  const before = database.queryTurns()[0];const manifest = database.findManifest('claude',main)!;
  await appendFile(main,'{bad}\n');
  const result = await refreshSummary(database,options);assert.equal(result.failed,1);
  const stale = database.queryTurns()[0];assert.equal(stale.total_tokens,before.total_tokens);assert.equal(stale.updated_at,before.updated_at);
  assert.equal(stale.last_error,'parse-error');assert.equal(database.findManifest('claude',main)!.size_bytes,manifest.size_bytes);
  await writeFile(main,jsonl([user(),response(50)]));
  await refreshSummary(database,options);assert.equal(database.queryTurns()[0].total_tokens,150);assert.equal(database.queryTurns()[0].last_error,null);
}));

test('partial final lines are deferred without a parse error',async () => fixture(async (database,options,root) => {
  const main = join(root,'session-one.jsonl');
  await writeFile(main,jsonl([user()]) + JSON.stringify(response()));
  const result = await refreshSummary(database,options);assert.equal(result.failed,0);
  const turn = database.queryTurns()[0];assert.equal(turn.total_tokens,0);assert.equal(turn.status,'in_progress');assert.match(turn.quality_flags ?? '',/partial-line/);
  await appendFile(main,'\n');await refreshSummary(database,options);assert.equal(database.queryTurns()[0].total_tokens,200);
}));

test('session reassignment replaces old and new sessions atomically',async () => fixture(async (database,options,root) => {
  const main = join(root,'main.jsonl');await writeFile(main,jsonl([user(),response()]));await refreshSummary(database,options);
  await writeFile(main,jsonl([user('prompt-two','session-two'),response(75,'prompt-two')]));await refreshSummary(database,options);
  assert.equal(database.queryTurns().length,1);assert.equal(database.queryTurns()[0].session_id,'session-two');
}));

test('missing formerly indexed root prevents absence deletion; brand new missing root is empty',async () => fixture(async (database,options,root,base) => {
  await writeFile(join(root,'session-one.jsonl'),jsonl([user(),response()]));await refreshSummary(database,options);
  await rm(root,{recursive:true});const failed = await refreshSummary(database,options);
  assert.equal(failed.interrupted,true);assert.equal(database.queryTurns().length,1);
  const empty = await refreshSummary(database,{...options,roots:[{provider:'codex',path:join(base,'missing')}]});
  assert.equal(empty.interrupted,false);assert.equal(database.queryTurns().length,1);
}));

test('worker initialization creates only schema; refresh is lazy and requests are single flight',async () => {
  const base = await mkdtemp(join(tmpdir(),'agent-tracker-worker-'));const root = join(base,'projects');await mkdir(root);
  await writeFile(join(root,'session-one.jsonl'),jsonl([user(),response()]));
  const client = new SummaryClient({dbPath:join(base,'db.sqlite'),roots:[{provider:'claude',path:root}]});
  try {
    await client.initialize();assert.equal((await client.diagnostics()).counts.files,0);
    const a = client.refresh();const b = client.refresh();assert.equal(a,b);
    assert.equal((await a).failed,0);const query = await client.query({groupBy:'all'});
    assert.equal(query.rows[0].total_tokens,200);assert.equal(query.total,1);
  } finally {await client.dispose();await rm(base,{recursive:true,force:true});}
});

test('session sources outside selected roots survive a shared-session rebuild',async () => fixture(async (database,options,root,base) => {
  const other = join(base,'archive');await mkdir(other);
  const main = join(root,'session-one.jsonl');
  await writeFile(main,jsonl([user(),response(100)]));
  await writeFile(join(other,'copy.jsonl'),jsonl([user(),response(50,'prompt-one','response-two','req-two')]));
  await refreshSummary(database,{...options,roots:[...options.roots,{provider:'claude',path:other}]});
  assert.equal(database.queryTurns()[0].total_tokens,350);
  await appendFile(main,jsonl([response(10,'prompt-one','response-three','req-three')]));
  const result = await refreshSummary(database,options);
  assert.equal(result.failed,0);assert.equal(database.queryTurns()[0].total_tokens,460);
  assert.ok(database.findManifest('claude',join(other,'copy.jsonl')));
}));

const codexMeta = (id:string,parent?:string,fork?:string) => ({type:'session_meta',payload:{id,parent_thread_id:parent,forked_from_id:fork,cwd:'/fixture/project'}});
const codexStart = (turn:string,root=turn) => ({type:'event_msg',timestamp:'2026-10-01T00:00:00Z',payload:{type:'task_started',turn_id:turn,root_turn_id:root}});
const currentUsage = (thread:string,turn:string,root:string,input:number) => ({type:'token_usage_record',payload:{thread_id:thread,turn_id:turn,root_turn_id:root,response_id:`r-${thread}`,usage:{input_tokens:input,output_tokens:0}}});
const legacyUsage = (input:number) => ({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:0},last_token_usage:{input_tokens:input,output_tokens:0}}}});

test('nested Codex descendants resolve to the root and current records supersede legacy snapshots',async () => fixture(async (database,options,root) => {
  const codexOptions = {...options,roots:[{provider:'codex' as const,path:root}]};
  await writeFile(join(root,'main.jsonl'),jsonl([codexMeta('main'),codexStart('root'),legacyUsage(100),currentUsage('main','root','root',100),
    {type:'event_msg',payload:{type:'task_complete',turn_id:'root',duration_ms:500}}]));
  await writeFile(join(root,'child.jsonl'),jsonl([codexMeta('child','main'),codexStart('c','root'),currentUsage('child','c','root',40)]));
  await writeFile(join(root,'grandchild.jsonl'),jsonl([codexMeta('grandchild','child'),codexStart('g','root'),currentUsage('grandchild','g','root',20)]));
  const result = await refreshSummary(database,codexOptions);
  assert.equal(result.failed,0);const turns = database.queryTurns();
  assert.equal(turns.length,1);assert.equal(turns[0].session_id,'main');assert.equal(turns[0].total_tokens,160);assert.equal(turns[0].duration_ms,500);
}));

test('verified legacy fork prefix is excluded while new fork usage remains',async () => fixture(async (database,options,root) => {
  const codexOptions = {...options,roots:[{provider:'codex' as const,path:root}]};
  await writeFile(join(root,'parent.jsonl'),jsonl([codexMeta('parent'),codexStart('old'),legacyUsage(100)]));
  await writeFile(join(root,'fork.jsonl'),jsonl([codexMeta('fork',undefined,'parent'),codexStart('old'),legacyUsage(100),codexStart('new'),legacyUsage(120)]));
  const result = await refreshSummary(database,codexOptions);
  assert.equal(result.failed,0);const turns = database.queryTurns();
  assert.equal(turns.length,2);assert.equal(turns.reduce((sum,row)=>sum+row.total_tokens,0),220);
  assert.deepEqual(turns.map(row=>row.root_turn_id).sort(),['new','old']);
}));

test('cancellation before commit preserves earlier summaries and supports a new explicit refresh',async () => fixture(async (database,options,root) => {
  const main = join(root,'session-one.jsonl');await writeFile(main,jsonl([user(),response()]));await refreshSummary(database,options);
  await appendFile(main,jsonl([response(200,'prompt-one','second','second')]));
  const controller = new AbortController();
  const result = await refreshSummary(database,options,controller.signal,progress=>{if(progress.phase==='committing')controller.abort();});
  assert.equal(result.interrupted,true);assert.equal(database.queryTurns()[0].total_tokens,200);
  const retried = await refreshSummary(database,options);assert.equal(retried.failed,0);assert.equal(database.queryTurns()[0].total_tokens,500);
}));

test('empty and first partial-only files are deferred without parse errors',async () => fixture(async (database,options,root) => {
  const empty = join(root,'empty.jsonl');const partial = join(root,'partial.jsonl');
  await writeFile(empty,'');await writeFile(partial,JSON.stringify(user()));
  const result = await refreshSummary(database,options);
  assert.equal(result.failed,0);assert.equal(database.queryTurns().length,0);
  assert.equal(database.findManifest('claude',partial)?.last_error,null);
  assert.equal(database.findManifest('claude',empty)?.processing_status,'done');
  await appendFile(partial,'\n' + jsonl([response()]));
  assert.equal((await refreshSummary(database,options)).failed,0);
  assert.equal(database.queryTurns()[0].total_tokens,200);
}));

test('new Codex grandchild resolves an unchanged parent using a verified filename candidate',async () => fixture(async (database,options,root) => {
  const codexOptions = {...options,roots:[{provider:'codex' as const,path:root}]};
  await writeFile(join(root,'main.jsonl'),jsonl([codexMeta('main'),codexStart('root'),currentUsage('main','root','root',100)]));
  await writeFile(join(root,'rollout-child.jsonl'),jsonl([codexMeta('child','main'),codexStart('c','root'),currentUsage('child','c','root',40)]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  await writeFile(join(root,'rollout-grandchild.jsonl'),jsonl([codexMeta('grandchild','child'),codexStart('g','root'),currentUsage('grandchild','g','root',20)]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  const turns = database.queryTurns();assert.equal(turns.length,1);assert.equal(turns[0].total_tokens,160);
}));

test('worker cancellation before startup and while waiting for another writer releases cleanly',async () => {
  const base = await mkdtemp(join(tmpdir(),'agent-tracker-cancel-'));
  const options = {dbPath:join(base,'db.sqlite'),roots:[]};
  const client = new SummaryClient(options);
  let release: (()=>Promise<void>)|undefined;
  try {
    const early = client.refresh();client.cancel();
    assert.equal((await early).interrupted,true);
    release = await acquireRefreshLock(options.dbPath);
    const waiting = client.refresh();
    await new Promise(resolve=>setTimeout(resolve,100));client.cancel();
    assert.equal((await waiting).interrupted,true);
    await release();release=undefined;
    assert.equal((await client.refresh()).interrupted,false);
  } finally {await release?.();await client.dispose();await rm(base,{recursive:true,force:true});}
});

test('two workers sharing a DB serialize refreshes and preserve unchanged reads',async () => {
  const base = await mkdtemp(join(tmpdir(),'agent-tracker-lock-'));const root=join(base,'projects');await mkdir(root);
  await writeFile(join(root,'main.jsonl'),jsonl([user(),response()]));
  const options = {dbPath:join(base,'db.sqlite'),roots:[{provider:'claude' as const,path:root}]};
  const first=new SummaryClient(options);const second=new SummaryClient(options);
  try {
    await first.initialize();await second.initialize();
    const [a,b]=await Promise.all([first.refresh(),second.refresh()]);
    assert.equal(a.failed+b.failed,0);assert.equal(a.parsed+b.parsed,1);assert.equal(a.reused+b.reused,1);
    assert.equal((await first.query({groupBy:'all'})).rows[0].total_tokens,200);
  } finally {await Promise.all([first.dispose(),second.dispose()]);await rm(base,{recursive:true,force:true});}
});

test('line byte budget failure preserves prior summary and exposes the exact source offset',async () => fixture(async(database,options,root)=>{
  const path=join(root,'main.jsonl');await writeFile(path,jsonl([user(),response()]));await refreshSummary(database,options);
  await appendFile(path,JSON.stringify({type:'assistant',text:'x'.repeat(1000)})+'\n');
  const result=await refreshSummary(database,{...options,maxLineBytes:512});
  assert.equal(result.failed,1);assert.equal(database.queryTurns()[0].total_tokens,200);
  const file=database.findManifest('claude',path)!;
  assert.equal(file.last_error,'line-byte-budget-exceeded');assert.match(file.processing_position!,/byte=[1-9]/);
}));

test('a new malformed subagent preserves the entire previously accepted session',async () => fixture(async(database,options,root)=>{
  const main=join(root,'session-one.jsonl');
  await writeFile(main,jsonl([user(),response()]));await refreshSummary(database,options);
  await writeFile(main,jsonl([user(),response(200)]));
  const agents=join(root,'session-one','subagents');await mkdir(agents,{recursive:true});
  await writeFile(join(agents,'agent-new.jsonl'),jsonl([response(30,'prompt-one','child','child-request')])+'{bad}\n');
  const result=await refreshSummary(database,options);
  assert.equal(result.failed,1);assert.equal(database.queryTurns()[0].total_tokens,200);
  assert.equal(database.findManifest('claude',main)!.processing_status,'error');
}));

test('a malformed reassigned file preserves both the old and newly identified session',async () => fixture(async(database,options,root)=>{
  const a=join(root,'a.jsonl');const b=join(root,'b.jsonl');
  await writeFile(a,jsonl([user('prompt-a','session-a'),response(100,'prompt-a')]));
  await writeFile(b,jsonl([user('prompt-b','session-b'),response(50,'prompt-b')]));
  await refreshSummary(database,options);
  await writeFile(a,jsonl([user('prompt-b','session-b'),response(200,'prompt-b')])+'{bad}\n');
  await writeFile(b,jsonl([user('prompt-b','session-b'),response(100,'prompt-b')]));
  const result=await refreshSummary(database,options);assert.equal(result.failed,1);
  const rows=database.queryTurns();
  assert.equal(rows.find(row=>row.session_id==='session-a')!.total_tokens,200);
  assert.equal(rows.find(row=>row.session_id==='session-b')!.total_tokens,150);
  assert.ok(rows.every(row=>row.last_error==='parse-error'));
}));

test('a malformed new Codex descendant keeps the accepted root-session summary',async () => fixture(async(database,options,root)=>{
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  const main=join(root,'main.jsonl');
  await writeFile(main,jsonl([codexMeta('main'),codexStart('root'),currentUsage('main','root','root',100)]));
  await refreshSummary(database,codexOptions);
  await writeFile(main,jsonl([codexMeta('main'),codexStart('root'),currentUsage('main','root','root',200)]));
  await writeFile(join(root,'child.jsonl'),jsonl([codexMeta('child','main'),codexStart('c','root')])+'{bad}\n');
  const result=await refreshSummary(database,codexOptions);
  assert.equal(result.failed,1);assert.equal(database.queryTurns()[0].total_tokens,100);
  assert.equal(database.queryTurns()[0].last_error,'parse-error');
}));

test('cancelling an affected session also marks its reread unchanged source interrupted',async () => fixture(async(database,options,root)=>{
  const main=join(root,'session-one.jsonl');
  const agents=join(root,'session-one','subagents');await mkdir(agents,{recursive:true});
  const child=join(agents,'agent-child.jsonl');
  await writeFile(main,jsonl([user(),response()]));
  await writeFile(child,jsonl([response(30,'prompt-one','child','child-request')]));
  await refreshSummary(database,options);
  await writeFile(child,jsonl([response(60,'prompt-one','child','child-request')]));
  const controller=new AbortController();
  const result=await refreshSummary(database,options,controller.signal,progress=>{if(progress.phase==='committing')controller.abort();});
  assert.equal(result.interrupted,true);
  assert.equal(database.findManifest('claude',main)!.processing_status,'interrupted');
  assert.equal(database.findManifest('claude',child)!.processing_status,'interrupted');
  assert.equal(database.queryTurns()[0].total_tokens,330);
}));

test('cancellation after one session commits does not mark that successful session stale',async () => fixture(async(database,options,root)=>{
  const a=join(root,'a.jsonl');const b=join(root,'b.jsonl');
  for(const [path,session,prompt] of [[a,'session-a','prompt-a'],[b,'session-b','prompt-b']]) {
    await writeFile(path,jsonl([user(prompt,session),response(100,prompt)]));
  }
  await refreshSummary(database,options);
  for(const [path,session,prompt] of [[a,'session-a','prompt-a'],[b,'session-b','prompt-b']]) {
    await writeFile(path,jsonl([user(prompt,session),response(200,prompt)]));
  }
  const controller=new AbortController();const original=database.replaceSessions.bind(database);
  database.replaceSessions=replacement=>{original(replacement);controller.abort();};
  const result=await refreshSummary(database,options,controller.signal);
  assert.equal(result.interrupted,true);
  assert.equal(database.findManifest('claude',a)!.processing_status,'done');
  const rows=database.queryTurns();
  assert.equal(rows.find(row=>row.session_id==='session-a')!.total_tokens,300);
  assert.equal(rows.find(row=>row.session_id==='session-a')!.last_error,null);
  assert.equal(rows.find(row=>row.session_id==='session-b')!.total_tokens,200);
  assert.equal(database.findManifest('claude',b)!.processing_status,'interrupted');
}));
