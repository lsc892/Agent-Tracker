import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, unlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryDatabase } from '../src/summary/db';
import { PARSER_VERSION, refreshSummary } from '../src/summary/scanner';
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

const stopHook = (time = '2026-10-01T00:00:16Z', blocked = false) => ({
  type:'system',subtype:'stop_hook_summary',timestamp:time,preventedContinuation:blocked,
});
const apiError = (time = '2026-10-01T00:00:05Z', root = 'prompt-one') => ({
  type:'assistant',promptId:root,timestamp:time,isApiErrorMessage:true,error:'rate_limit',apiErrorStatus:429,
  message:{id:`error-${root}`,stop_reason:'stop_sequence',usage:{input_tokens:0,output_tokens:0}},
});

test('Claude Stop summaries measure the root elapsed time and explicit durations still take priority',async () => fixture(async (database,options,root) => {
  const main = join(root,'session-one.jsonl');
  await mkdir(join(root,'session-one','subagents'),{recursive:true});
  await writeFile(main,jsonl([user(),response(),stopHook()]));
  await writeFile(join(root,'session-one','subagents','agent-one.jsonl'),jsonl([
    response(20,'prompt-one','child-response','child-request'),stopHook('2026-10-01T00:01:00Z'),
  ]));
  assert.equal((await refreshSummary(database,options)).failed,0);
  let turn = database.queryTurns()[0];
  assert.equal(turn.duration_ms,16000);assert.equal(turn.duration_quality,'derived');
  assert.equal(turn.completed_at_ms,Date.parse('2026-10-01T00:00:16Z'));
  assert.equal(turn.total_tokens,320);
  await appendFile(main,jsonl([{type:'system',subtype:'turn_duration',durationMs:15000,timestamp:'2026-10-01T00:00:16Z'}]));
  await refreshSummary(database,options);turn = database.queryTurns()[0];
  assert.equal(turn.duration_ms,15000);assert.equal(turn.duration_quality,'exact');
}));

test('a blocked Claude Stop reopens the request until its continuation finishes',async () => fixture(async (database,options,root) => {
  const main = join(root,'session-one.jsonl');
  await writeFile(main,jsonl([user(),response(),stopHook('2026-10-01T00:00:06Z',true),
    {type:'system',subtype:'turn_duration',durationMs:6000,timestamp:'2026-10-01T00:00:06Z'}]));
  await refreshSummary(database,options);
  let turn = database.queryTurns()[0];
  assert.equal(turn.status,'in_progress');assert.equal(turn.duration_ms,null);assert.equal(turn.completed_at_ms,null);
  assert.equal(database.queryUsage()[0].turns_with_duration,0);
  await appendFile(main,jsonl([
    {...response(20,'prompt-one','continued-response','continued-request'),timestamp:'2026-10-01T00:00:10Z'},stopHook(),
  ]));
  await refreshSummary(database,options);turn = database.queryTurns()[0];
  assert.equal(turn.status,'completed');assert.equal(turn.duration_ms,16000);assert.equal(turn.duration_quality,'derived');
}));

test('Claude Stop records without an explicit continuation outcome retain message timestamp fallback',async () => fixture(async (database,options,root) => {
  const main = join(root,'session-one.jsonl');
  for (const preventedContinuation of [undefined,null,'false']) {
    await writeFile(main,jsonl([user(),response(),{...stopHook(),preventedContinuation}]));
    assert.equal((await refreshSummary(database,options)).failed,0);
    const turn = database.queryTurns()[0];
    assert.equal(turn.status,'completed');assert.equal(turn.duration_ms,3000);assert.equal(turn.duration_quality,'approximate');
  }
}));

test('Claude API failures stay out of completed averages while retaining tokens spent before failure',async () => fixture(async (database,options,root) => {
  await writeFile(join(root,'session-one.jsonl'),jsonl([
    user(),{...response(),message:{...response().message,stop_reason:'tool_use'}},apiError(),stopHook(),
    {type:'system',subtype:'turn_duration',durationMs:16000,timestamp:'2026-10-01T00:00:16Z'},
    user('success'),response(50,'success','success-response','success-request'),
  ]));
  assert.equal((await refreshSummary(database,options)).failed,0);
  const failure = database.queryTurns().find(row=>row.root_turn_id==='prompt-one')!;
  assert.equal(failure.status,'failed');assert.equal(failure.total_tokens,200);assert.match(failure.quality_flags!,/api-error/);
  const usage = database.queryUsage()[0];
  assert.equal(usage.turn_count,2);assert.equal(usage.completed_turns,1);assert.equal(usage.total_tokens,350);
  assert.equal(usage.avg_tokens_per_turn,150);assert.equal(usage.avg_duration_ms,3000);assert.equal(usage.turns_with_duration,1);
}));

test('a Claude error after an earlier end_turn overrides completion and a later successful retry restores it',async () => fixture(async (database,options,root) => {
  const main = join(root,'session-one.jsonl');
  await writeFile(main,jsonl([user(),response(),apiError()]));await refreshSummary(database,options);
  assert.equal(database.queryTurns()[0].status,'failed');assert.equal(database.queryUsage()[0].avg_duration_ms,null);
  await appendFile(main,jsonl([
    {...response(30,'prompt-one','retry-response','retry-request'),timestamp:'2026-10-01T00:00:12Z'},stopHook(),
  ]));
  await refreshSummary(database,options);
  assert.equal(database.queryTurns()[0].status,'completed');assert.equal(database.queryTurns()[0].duration_ms,16000);
  assert.equal(database.queryUsage()[0].completed_turns,1);assert.equal(database.queryUsage()[0].total_tokens,330);
}));

test('Claude completion without a usage vector still ends the request and subagent errors do not fail its parent',async () => fixture(async (database,options,root) => {
  await mkdir(join(root,'session-one','subagents'),{recursive:true});
  await writeFile(join(root,'session-one.jsonl'),jsonl([user(),
    {...response(),message:{...response().message,stop_reason:'tool_use'}},
    {type:'assistant',timestamp:'2026-10-01T00:00:10Z',message:{stop_reason:'end_turn'}},stopHook(),
  ]));
  await writeFile(join(root,'session-one','subagents','agent-error.jsonl'),jsonl([apiError('2026-10-01T00:00:30Z')]));
  assert.equal((await refreshSummary(database,options)).failed,0);
  const turn = database.queryTurns()[0];
  assert.equal(turn.status,'completed');assert.equal(turn.duration_ms,16000);assert.equal(turn.total_tokens,200);
}));

test('Claude duplicate sources use the latest outcome timestamp rather than file parse order',async () => fixture(async (database,options,root) => {
  await writeFile(join(root,'a-success.jsonl'),jsonl([user(),response(),stopHook()]));
  await writeFile(join(root,'z-old-error.jsonl'),jsonl([user(),apiError()]));
  assert.equal((await refreshSummary(database,options)).failed,0);
  assert.equal(database.queryTurns()[0].status,'completed');assert.equal(database.queryTurns()[0].duration_ms,16000);
}));

test('a Claude API failure without a timestamp still supersedes earlier completion in its source',async () => fixture(async (database,options,root) => {
  await writeFile(join(root,'session-one.jsonl'),jsonl([user(),response(),{...apiError(),timestamp:undefined}]));
  assert.equal((await refreshSummary(database,options)).failed,0);
  const turn = database.queryTurns()[0];
  assert.equal(turn.status,'failed');assert.equal(turn.completed_at_ms,null);assert.equal(turn.duration_ms,null);
  assert.equal(database.queryUsage()[0].completed_turns,0);assert.equal(database.queryUsage()[0].avg_duration_ms,null);
}));

test('Claude parser version repairs cached durations and API error averages without source changes',async () => fixture(async (database,options,root) => {
  const main = join(root,'session-one.jsonl');
  await writeFile(main,jsonl([user(),response(),stopHook(),user('error'),apiError('2026-10-01T00:00:05Z','error')]));
  await refreshSummary(database,options);
  database.connection.exec(`UPDATE manifest SET parser_version=3;
    UPDATE turn_summary SET status='completed',duration_ms=3000,duration_quality='approximate'`);
  assert.equal(database.queryUsage()[0].completed_turns,2);
  const refreshed = await refreshSummary(database,options);
  assert.equal(refreshed.failed,0);assert.equal(refreshed.parsed,1);assert.ok(refreshed.bodyBytes>0);
  const usage = database.queryUsage()[0];
  assert.equal(usage.completed_turns,1);assert.equal(usage.avg_duration_ms,16000);
  assert.equal(database.findManifest('claude',main)!.parser_version,PARSER_VERSION);
  const unchanged = await refreshSummary(database,options);
  assert.equal(unchanged.reused,1);assert.equal(unchanged.bodyBytes,0);
}));

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
    assert.deepEqual(await client.queryNames({kind:'project'}),{rows:[],total:0});
    const a = client.refresh();const b = client.refresh();assert.equal(a,b);
    assert.equal((await a).failed,0);const query = await client.query({groupBy:'all'});
    assert.equal(query.rows[0].total_tokens,200);assert.equal(query.total,1);
    const names = await client.queryNames({kind:'session',providers:['claude']});
    assert.equal(names.total,1);assert.equal(names.rows[0].session_id,'session-one');
    assert.equal(names.rows[0].project_name,'project');
    assert.equal((await client.queryNames({kind:'session',providers:['codex']})).total,0);
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
const rootlessStart = (turn:string) => ({type:'event_msg',timestamp:'2026-10-01T00:00:00Z',payload:{type:'task_started',turn_id:turn}});

test('aborted Codex roots and descendants leave no request summary while later cumulative deltas stay correct',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  const count = (input:number) => ({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:input,output_tokens:0}}}});
  await writeFile(join(root,'main.jsonl'),jsonl([codexMeta('main'),codexStart('aborted'),count(100),
    {type:'event_msg',timestamp:'2026-10-01T00:00:01Z',payload:{type:'turn_aborted',turn_id:'aborted',completed_at:1790812801,duration_ms:1000}},
    {...codexStart('next'),timestamp:'2026-10-01T00:00:02Z'},count(150),
    {type:'event_msg',timestamp:'2026-10-01T00:00:03Z',payload:{type:'task_complete',turn_id:'next',duration_ms:1000}}]));
  await writeFile(join(root,'child.jsonl'),jsonl([codexMeta('child','main'),codexStart('child-turn','aborted'),
    currentUsage('child','child-turn','aborted',40),
    {type:'event_msg',payload:{type:'task_complete',turn_id:'child-turn',root_turn_id:'aborted',duration_ms:500}}]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  const turns=database.queryTurns();assert.equal(turns.length,1);
  assert.equal(turns[0].root_turn_id,'next');assert.equal(turns[0].turn_index,1);assert.equal(turns[0].total_tokens,50);
  const usage=database.queryUsage()[0];assert.equal(usage.turn_count,1);assert.equal(usage.total_tokens,50);
  assert.equal(usage.avg_tokens_per_turn,50);assert.equal(database.diagnostics().summaries.length,0);
}));

test('a Codex abort removes an accepted summary and a later completed retry can restore the same root',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  const path=join(root,'main.jsonl');
  await writeFile(path,jsonl([codexMeta('main'),codexStart('request'),legacyUsage(100),
    {type:'event_msg',timestamp:'2026-10-01T00:00:01Z',payload:{type:'task_complete',turn_id:'request',duration_ms:1000}}]));
  await refreshSummary(database,codexOptions);assert.equal(database.queryTurns().length,1);
  await appendFile(path,jsonl([{type:'event_msg',timestamp:'2026-10-01T00:00:02Z',payload:{type:'turn_aborted',turn_id:'request'}}]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);assert.equal(database.queryTurns().length,0);
  assert.equal(database.findManifest('codex',path)!.processing_status,'done');
  await appendFile(path,jsonl([{...codexStart('request'),timestamp:'2026-10-01T00:00:03Z'},
    {type:'event_msg',timestamp:'2026-10-01T00:00:04Z',payload:{type:'task_complete',turn_id:'request',duration_ms:1000}}]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  assert.equal(database.queryTurns()[0].status,'completed');assert.equal(database.queryTurns()[0].total_tokens,100);
}));

test('an aborted subagent does not discard its successfully completed main request',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  await writeFile(join(root,'main.jsonl'),jsonl([codexMeta('main'),codexStart('request'),currentUsage('main','request','request',100),
    {type:'event_msg',timestamp:'2026-10-01T00:00:01Z',payload:{type:'task_complete',turn_id:'request',duration_ms:1000}}]));
  await writeFile(join(root,'child.jsonl'),jsonl([codexMeta('child','main'),codexStart('child-turn','request'),currentUsage('child','child-turn','request',40),
    {type:'event_msg',timestamp:'2026-10-01T00:00:02Z',payload:{type:'turn_aborted',turn_id:'child-turn',root_turn_id:'request'}}]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  const turns=database.queryTurns();assert.equal(turns.length,1);assert.equal(turns[0].status,'completed');assert.equal(turns[0].total_tokens,140);
}));

test('copied parent metadata preserves child lineage and only the verified inherited usage is removed',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  const inherited=[rootlessStart('inherited'),legacyUsage(100),
    {type:'event_msg',payload:{type:'task_complete',turn_id:'inherited',duration_ms:1000}}];
  await writeFile(join(root,'main.jsonl'),jsonl([codexMeta('main'),...inherited]));
  const child=join(root,'child.jsonl');
  await writeFile(child,jsonl([codexMeta('child','main','main'),codexMeta('main'),...inherited,
    rootlessStart('own'),{type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:140,output_tokens:0},last_token_usage:{input_tokens:40,output_tokens:0}}}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:'own',duration_ms:500}}]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  const turns=database.queryTurns();assert.equal(turns.length,2);
  assert.equal(turns.find(row=>row.session_id==='main')!.total_tokens,100);
  const own=turns.find(row=>row.session_id==='child')!;assert.equal(own.root_turn_id,'own');assert.equal(own.total_tokens,40);
  assert.equal(database.findManifest('codex',child)!.session_id,'child');
  assert.ok(turns.every(row=>!row.quality_flags?.includes('missing-parent')));
}));

test('Codex lifecycle seconds produce correct calendar groups, date filters and derived durations',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  const started=Date.parse('2026-09-30T14:59:59Z');const completed=started+3000;
  const rows: unknown[]=[codexMeta('main')];
  for (const [turn,duration,input] of [['exact',2750,100],['derived',undefined,200]] as const) {
    rows.push(
      {type:'event_msg',timestamp:'2026-09-30T15:00:00.100Z',payload:{type:'task_started',turn_id:turn,started_at:started/1000}},
      {type:'event_msg',timestamp:'2026-09-30T15:00:00.200Z',payload:{type:'user_message'}},
      legacyUsage(input),
      {type:'event_msg',timestamp:'2026-09-30T15:00:02.200Z',payload:{type:'task_complete',turn_id:turn,completed_at:completed/1000,duration_ms:duration}},
    );
  }
  await writeFile(join(root,'main.jsonl'),jsonl(rows));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  const turns=database.queryTurns();assert.equal(turns.length,2);
  assert.ok(turns.every(row=>row.started_at_ms===started && row.completed_at_ms===completed));
  const exact=turns.find(row=>row.root_turn_id==='exact')!;const derived=turns.find(row=>row.root_turn_id==='derived')!;
  assert.equal(exact.duration_ms,2750);assert.equal(exact.duration_quality,'exact');
  assert.equal(derived.duration_ms,3000);assert.equal(derived.duration_quality,'derived');
  const filter={fromMs:Date.parse('2026-09-29T15:00:00Z'),toMs:Date.parse('2026-09-30T15:00:00Z')};
  assert.equal(database.queryTurns(filter).length,2);
  const days=database.queryUsage(filter,'day','Asia/Seoul');assert.equal(days.length,1);
  assert.equal(days[0].period,'2026-09-30');assert.equal(days[0].total_tokens,300);
  assert.equal(database.queryUsage({},'month','Asia/Seoul')[0].period,'2026-09');
  assert.equal(database.queryTurns({fromMs:filter.toMs}).length,0);
}));

test('Codex parser version rebuilds cached seconds timestamps without changes to source files',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  const main=join(root,'main.jsonl');
  await writeFile(main,jsonl([codexMeta('main'),
    {type:'event_msg',timestamp:'2026-08-16T05:28:27.439Z',payload:{type:'task_started',turn_id:'t',started_at:1786858107}},
    legacyUsage(100),
    {type:'event_msg',timestamp:'2026-08-16T05:49:14.489Z',payload:{type:'task_complete',turn_id:'t',completed_at:1786859354,duration_ms:1247169}},
  ]));
  await refreshSummary(database,codexOptions);
  // Recreate the accepted v2 cache; source size, mtime and identity stay unchanged.
  database.connection.exec(`UPDATE manifest SET parser_version=2;
    UPDATE turn_summary SET started_at_ms=1786858107,completed_at_ms=1786859354`);
  assert.equal(database.queryUsage({},'month','Asia/Seoul')[0].period,'1970-01');
  const refreshed=await refreshSummary(database,codexOptions);
  assert.equal(refreshed.failed,0);assert.equal(refreshed.parsed,1);assert.ok(refreshed.bodyBytes>0);
  const turns=database.queryTurns();assert.equal(turns.length,1);
  assert.equal(turns[0].started_at_ms,1786858107000);assert.equal(turns[0].completed_at_ms,1786859354000);
  assert.equal(turns[0].total_tokens,100);assert.equal(turns[0].duration_ms,1247169);
  assert.equal(database.queryUsage({},'month','Asia/Seoul')[0].period,'2026-08');
  assert.equal(database.findManifest('codex',main)!.parser_version,PARSER_VERSION);
  const unchanged=await refreshSummary(database,codexOptions);
  assert.equal(unchanged.failed,0);assert.equal(unchanged.reused,1);assert.equal(unchanged.bodyBytes,0);
}));

test('rootless legacy subagents become separate sessions without counting verified inherited usage twice',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  const main=join(root,'main.jsonl');const child=join(root,'child.jsonl');
  await writeFile(main,jsonl([codexMeta('main'),rootlessStart('inherited'),legacyUsage(100),
    {type:'event_msg',payload:{type:'task_complete',turn_id:'inherited',duration_ms:500}}]));
  await writeFile(child,jsonl([{type:'session_meta',payload:{id:'child',session_id:'main',parent_thread_id:'main'}},
    rootlessStart('inherited'),legacyUsage(100),rootlessStart('child-turn'),
    {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:140,output_tokens:0},last_token_usage:{input_tokens:40,output_tokens:0}}}},
    {type:'event_msg',payload:{type:'task_complete',turn_id:'child-turn',duration_ms:700}}]));
  const result=await refreshSummary(database,codexOptions);
  assert.equal(result.failed,0);
  const turns=database.queryTurns();assert.equal(turns.length,2);
  const parentTurn=turns.find(row=>row.session_id==='main')!;const childTurn=turns.find(row=>row.session_id==='child')!;
  assert.equal(parentTurn.total_tokens,100);assert.equal(parentTurn.duration_ms,500);
  assert.equal(childTurn.root_turn_id,'child-turn');assert.equal(childTurn.total_tokens,40);assert.equal(childTurn.duration_ms,700);
  assert.match(childTurn.quality_flags!,/standalone-subagent/);assert.equal(childTurn.last_error,null);
  assert.equal(database.findManifest('codex',child)!.session_id,'child');
  const unchanged=await refreshSummary(database,codexOptions);
  assert.equal(unchanged.failed,0);assert.equal(unchanged.reused,2);assert.equal(unchanged.bodyBytes,0);
  await appendFile(child,jsonl([rootlessStart('next-child-turn'),
    {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:160,output_tokens:0},last_token_usage:{input_tokens:20,output_tokens:0}}}}]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  assert.equal(database.queryTurns().reduce((sum,row)=>sum+row.total_tokens,0),160);
  await appendFile(child,'{bad}\n');
  assert.equal((await refreshSummary(database,codexOptions)).failed,1);
  assert.equal(database.queryTurns().find(row=>row.session_id==='main')!.last_error,null);
  assert.equal(database.queryTurns().find(row=>row.session_id==='child')!.last_error,'parse-error');
  await unlink(child);assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  assert.equal(database.queryTurns().length,1);assert.equal(database.queryTurns()[0].total_tokens,100);
}));

test('rootless usage-only subagents work without the parent source and keep sibling sessions distinct',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  for (const [id,input] of [['child-one',25],['child-two',40]] as const) {
    await writeFile(join(root,`${id}.jsonl`),jsonl([codexMeta(id,'missing-parent'),legacyUsage(input)]));
  }
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  const turns=database.queryTurns();assert.equal(turns.length,2);
  assert.deepEqual(turns.map(row=>row.session_id).sort(),['child-one','child-two']);
  assert.equal(turns.reduce((sum,row)=>sum+row.total_tokens,0),65);
  assert.ok(turns.every(row=>row.quality_flags!.includes('standalone-subagent') && row.last_error===null));
}));

test('rooted current subagents stay attached after a rootless inherited legacy prefix',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  await writeFile(join(root,'main.jsonl'),jsonl([codexMeta('main'),codexStart('root'),currentUsage('main','root','root',100),
    {type:'event_msg',payload:{type:'task_complete',turn_id:'root',duration_ms:500}}]));
  await writeFile(join(root,'child.jsonl'),jsonl([codexMeta('child','main','main'),rootlessStart('root'),legacyUsage(100),
    codexStart('c','root'),currentUsage('child','c','root',40),
    {type:'event_msg',payload:{type:'task_complete',turn_id:'c',root_turn_id:'root',duration_ms:700}}]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  const turns=database.queryTurns();assert.equal(turns.length,1);
  assert.equal(turns[0].session_id,'main');assert.equal(turns[0].total_tokens,140);assert.equal(turns[0].duration_ms,500);
  assert.ok(!turns[0].quality_flags?.includes('standalone-subagent'));
}));

test('subagent fallback reassigns an accepted parent session without leaving old totals behind',async () => fixture(async (database,options,root) => {
  const codexOptions={...options,roots:[{provider:'codex' as const,path:root}]};
  const child=join(root,'child.jsonl');
  await writeFile(join(root,'main.jsonl'),jsonl([codexMeta('main'),codexStart('root'),currentUsage('main','root','root',100)]));
  await writeFile(child,jsonl([codexMeta('child','main'),codexStart('c','root'),currentUsage('child','c','root',40)]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);assert.equal(database.queryTurns()[0].total_tokens,140);
  await writeFile(child,jsonl([codexMeta('child','main'),rootlessStart('c'),legacyUsage(40)]));
  assert.equal((await refreshSummary(database,codexOptions)).failed,0);
  const turns=database.queryTurns();assert.equal(turns.length,2);
  assert.equal(turns.find(row=>row.session_id==='main')!.total_tokens,100);
  assert.equal(turns.find(row=>row.session_id==='child')!.total_tokens,40);
}));

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

test('clearing derived data cancels a scan, respects the shared lock and rebuilds from unchanged sources', async () => {
  const base = await mkdtemp(join(tmpdir(), 'agent-tracker-clear-'));
  const root = join(base, 'projects'); await mkdir(root);
  const path = join(root, 'main.jsonl');
  const source = jsonl([user(), response()]);
  await writeFile(path, source);
  const options = {dbPath: join(base, 'db.sqlite'), roots: [{provider: 'claude' as const, path: root}]};
  const client = new SummaryClient(options);
  const observer = new SummaryClient(options);
  let release: (() => Promise<void>) | undefined;
  try {
    await client.refresh(); await observer.initialize();
    assert.equal((await client.query()).total, 1);
    release = await acquireRefreshLock(options.dbPath);
    const scan = client.refresh();
    let cleared = false;
    const clearing = client.clearData().then(() => { cleared = true; });
    assert.equal((await scan).interrupted, true);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(cleared, false, 'deletion waits for another window holding the refresh lock');
    assert.equal((await observer.query()).total, 1);
    await release(); release = undefined;
    await clearing;
    assert.equal((await client.query()).total, 0);
    assert.equal((await observer.query()).total, 0, 'other database connections observe the deletion');
    const diagnostics = await client.diagnostics();
    assert.equal(diagnostics.counts.files, 0);
    assert.equal(diagnostics.lastRefresh, undefined);
    assert.equal(await readFile(path, 'utf8'), source);
    const rebuilt = await client.refresh();
    assert.equal(rebuilt.parsed, 1);
    assert.equal((await client.query()).rows[0].total_tokens, 200);
  } finally {
    await release?.();
    await Promise.all([client.dispose(), observer.dispose()]);
    await rm(base, {recursive: true, force: true});
  }
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
