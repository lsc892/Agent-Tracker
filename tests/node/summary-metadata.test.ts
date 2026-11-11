// 원본 전수 파싱과 영속 metadata의 부분 반영·재시도 계약을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryDatabase } from '../../src/summary/db';
import { refreshSummary } from '../../src/summary/scanner';
import { project } from '../../src/summary/parsers/common';
import type { SummaryOptions } from '../../src/summary/types';

const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const user = (root = 'one', session = 'session') => ({
  type:'user',sessionId:session,promptId:root,cwd:'/synthetic/project',timestamp:'2026-10-01T00:00:00Z',
  message:{content:'Fixture request'},
});
const response = (input = 100, root = 'one', id = 'response-one', request: string | null = 'request-one',
  model = 'claude-sonnet-4-6', complete = true, time = '2026-10-01T00:00:02Z') => ({
  type:'assistant',promptId:root,requestId:request,timestamp:time,
  message:{id,model,stop_reason:complete?'end_turn':'tool_use',usage:{input_tokens:input,output_tokens:2}},
});

interface Fixture {
  readonly db: SummaryDatabase;
  options: SummaryOptions;
  root: string;
  reopen(): void;
}

async function fixture(run: (value: Fixture) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(),'agent-tracker-metadata-'));
  const root = join(directory,'logs');await mkdir(root);
  const options: SummaryOptions = {dbPath:join(directory,'summary.sqlite'),roots:[{provider:'claude',path:root}],retainDeletedSourceUsage:false};
  let database = new SummaryDatabase(options.dbPath);
  const value: Fixture = {get db() { return database; },options,root,
    reopen() { database.close();database = new SummaryDatabase(options.dbPath); }};
  try { await run(value); }
  finally { database.close();await rm(directory,{recursive:true,force:true}); }
}

const metadata = (db: SummaryDatabase) => db.connection.prepare(
  'SELECT id,source_identity,content_hash FROM manifest ORDER BY id').all();

test('a full reread with unchanged statistics preserves request identities across database reopen',async () => fixture(async value => {
  const {root,options} = value,path = join(root,'session.jsonl');
  const source = jsonl([user(),response(),user('two'),response(40,'two','response-two','request-two')]);
  await writeFile(path,source);assert.equal((await refreshSummary(value.db,options)).failed,0);
  const before = value.db.queryTurns(),beforeMetadata = metadata(value.db);
  assert.equal(beforeMetadata.length,1);
  value.db.connection.exec(`CREATE TABLE request_writes(operation TEXT);
    CREATE TRIGGER request_insert AFTER INSERT ON turn_summary BEGIN INSERT INTO request_writes VALUES('insert'); END;
    CREATE TRIGGER request_update AFTER UPDATE ON turn_summary BEGIN INSERT INTO request_writes VALUES('update'); END;
    CREATE TRIGGER request_delete AFTER DELETE ON turn_summary BEGIN INSERT INTO request_writes VALUES('delete'); END;`);
  value.reopen();
  const extra = jsonl([{type:'progress',detail:'No statistical event'}]);await appendFile(path,extra);
  const result = await refreshSummary(value.db,options);
  assert.equal(result.failed,0);assert.equal(result.parsed,1);
  assert.ok(result.bodyBytes >= Buffer.byteLength(source+extra),'changed sources are still read from the beginning');
  assert.deepEqual(value.db.queryTurns(),before);
  const afterMetadata=metadata(value.db);
  assert.deepEqual(afterMetadata.map(({content_hash,...row})=>row),beforeMetadata.map(({content_hash,...row})=>row));
  assert.ok(afterMetadata.every((row,index)=>row.content_hash!==beforeMetadata[index].content_hash),
    'the accepted source hash changes even when appended records contain no statistical events');
  assert.equal(value.db.connection.prepare('SELECT count(*) AS n FROM request_writes').get()?.n,0,
    'unchanged normalized facts do not rewrite the request table');
}));

test('a new response changes only its owning request in a source containing several turns',async () => fixture(async ({db,root,options}) => {
  const path = join(root,'session.jsonl');
  await writeFile(path,jsonl([user(),response(),user('two'),response(40,'two','response-two','request-two')]));
  await refreshSummary(db,options);
  const before = db.queryTurns().find(row=>row.root_turn_id==='two')!;
  await appendFile(path,jsonl([response(20,'one','extra-response','extra-request')]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='one')?.total_tokens,124);
  assert.deepEqual(db.queryTurns().find(row=>row.root_turn_id==='two'),before);
  assert.equal(db.queryUsage()[0].total_tokens,166);
}));

test('rewriting or removing a winning source chooses the largest remaining response candidate',async () => fixture(async ({db,root,options}) => {
  const main = join(root,'session.jsonl'),copy = join(root,'copy.jsonl');
  await writeFile(main,jsonl([user(),response(100)]));await writeFile(copy,jsonl([user(),response(200)]));
  assert.equal((await refreshSummary(db,options)).failed,0);assert.equal(db.queryTurns()[0].total_tokens,202);
  await writeFile(copy,jsonl([user(),response(50)]));
  assert.equal((await refreshSummary(db,options)).failed,0);assert.equal(db.queryTurns()[0].total_tokens,102);
  await unlink(main);assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns()[0].total_tokens,52);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('late Claude request IDs regroup every candidate of the affected response',async () => fixture(async value => {
  const {root,options} = value,path = join(root,'session.jsonl');
  await writeFile(path,jsonl([user(),response(100,'one','shared',null)]));
  await refreshSummary(value.db,options);
  assert.equal(value.db.queryTurns()[0].total_tokens,102);
  assert.match(value.db.queryTurns()[0].quality_flags ?? '',/missing-request-id/);
  value.reopen();
  await appendFile(path,jsonl([response(80,'one','shared','request-a')]));
  assert.equal((await refreshSummary(value.db,options)).failed,0);
  assert.equal(value.db.queryTurns()[0].total_tokens,102,'one known request ID absorbs the missing-ID candidate');
  assert.doesNotMatch(value.db.queryTurns()[0].quality_flags ?? '',/missing-request-id/);
  await appendFile(path,jsonl([response(60,'one','shared','request-b')]));
  assert.equal((await refreshSummary(value.db,options)).failed,0);
  assert.equal(value.db.queryTurns()[0].total_tokens,246,'ambiguous IDs keep all three response groups separate');
  assert.match(value.db.queryTurns()[0].quality_flags ?? '',/missing-request-id/);
}));

test('a shared response winner moving between roots invalidates both request summaries',async () => fixture(async ({db,root,options}) => {
  const path = join(root,'session.jsonl');
  await writeFile(path,jsonl([user(),response(100,'one','shared',null),user('two'),response(80,'two','shared','request-a')]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='one')?.total_tokens,102);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='two')?.total_tokens,0);
  await writeFile(path,jsonl([user(),response(100,'one','shared',null),user('two'),response(150,'two','shared','request-a')]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='one')?.total_tokens,0);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id==='two')?.total_tokens,152);
  assert.equal(db.queryUsage()[0].total_tokens,152);
}));

test('equal-score shared responses follow the current cross-root source parse order',async () => fixture(async ({db,root,options}) => {
  const sources = [
    {path:join(root,'first.jsonl'),root:'one',model:'claude-sonnet-4-6'},
    {path:join(root,'second.jsonl'),root:'two',model:'claude-haiku-4-5'},
  ];
  for (const source of sources) await writeFile(source.path,jsonl([
    user(source.root),response(100,source.root,'shared','same-request',source.model),
  ]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const winner = db.queryTurns().find(row=>row.total_tokens===102)!;
  const touched = sources.find(source=>source.root===winner.root_turn_id)!;
  const other = sources.find(source=>source!==touched)!;
  await appendFile(touched.path,jsonl([{type:'progress',detail:'Same normalized turn events'}]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns().find(row=>row.root_turn_id===touched.root)?.total_tokens,0,
    'the changed source is parsed before the unchanged affected source');
  assert.equal(db.queryTurns().find(row=>row.root_turn_id===other.root)?.total_tokens,102);
  assert.equal(db.queryTurns({}, {},'model').find(row=>row.root_turn_id===other.root)?.model,other.model);
}));

test('rewriting a source removes facts whose entire root disappeared',async () => fixture(async ({db,root,options}) => {
  const path = join(root,'session.jsonl');
  await writeFile(path,jsonl([user(),response(),user('two'),response(40,'two','response-two','request-two')]));
  assert.equal((await refreshSummary(db,options)).failed,0);assert.equal(db.queryTurnsCount(),2);
  await writeFile(path,jsonl([user(),response()]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurnsCount(),1);assert.equal(db.queryTurns()[0].root_turn_id,'one');
  assert.equal(db.queryUsage()[0].total_tokens,102);
}));

test('equal token totals still update changed model, completion and time metadata',async () => fixture(async ({db,root,options}) => {
  const path = join(root,'session.jsonl');
  await writeFile(path,jsonl([user(),response(100,'one','response-one','request-one','claude-sonnet-4-6',false)]));
  await refreshSummary(db,options);assert.equal(db.queryTurns()[0].status,'in_progress');
  await writeFile(path,jsonl([user(),response(100,'one','response-one','request-one','claude-haiku-4-5',true,'2026-10-01T00:00:05Z')]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const turn = db.queryTurns()[0];
  assert.equal(turn.total_tokens,102);assert.equal(turn.status,'completed');assert.equal(turn.duration_ms,5000);
  assert.equal(turn.completed_at_ms,Date.parse('2026-10-01T00:00:05Z'));
  assert.equal(db.queryTurns({}, {},'model')[0].model,'claude-haiku-4-5');
}));

test('changed main-source project metadata updates roots recorded only in another session source',async () => fixture(async ({db,root,options}) => {
  const first = join(root,'a-main.jsonl'),second = join(root,'z-copy.jsonl');
  await writeFile(first,jsonl([user(),response()]));
  await writeFile(second,jsonl([user('two'),response(40,'two','response-two','request-two')]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.ok(db.queryTurns().every(row=>row.project_key===project('/synthetic/project').projectKey));
  const selected = db.findManifest('claude',first)!.id < db.findManifest('claude',second)!.id ? first : second;
  const selectedRoot = selected===first?'one':'two';
  await writeFile(selected,jsonl([{...user(selectedRoot),cwd:'/synthetic/renamed-project'},
    selected===first?response():response(40,'two','response-two','request-two')]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurnsCount(),2);
  assert.ok(db.queryTurns().every(row=>row.project_key===project('/synthetic/renamed-project').projectKey));
  assert.equal(db.queryUsage({},'project')[0].turn_count,2);
}));

test('a malformed rewrite does not publish candidates and recovery survives reopen',async () => fixture(async value => {
  const {root,options} = value,path = join(root,'session.jsonl');
  await writeFile(path,jsonl([user(),response()]));await refreshSummary(value.db,options);
  const before = value.db.queryTurns()[0],beforeMetadata = metadata(value.db);
  await writeFile(path,jsonl([user(),response(400)])+'{malformed}\n');
  assert.equal((await refreshSummary(value.db,options)).failed,1);
  assert.equal(value.db.queryTurns()[0].total_tokens,102);
  assert.equal(value.db.queryTurns()[0].updated_at,before.updated_at);
  assert.deepEqual(metadata(value.db),beforeMetadata);
  value.reopen();
  await writeFile(path,jsonl([user(),response(110)]));
  assert.equal((await refreshSummary(value.db,options)).failed,0);
  assert.equal(value.db.queryTurns()[0].total_tokens,112);
  assert.equal(value.db.queryTurns()[0].last_error,null);
}));

test('model write failure rolls back source hashes and request changes and a retry publishes both',async () => fixture(async ({db,root,options}) => {
  const path = join(root,'session.jsonl');
  await writeFile(path,jsonl([user(),response()]));await refreshSummary(db,options);
  const before = db.queryTurns()[0],beforeMetadata = metadata(db);
  db.connection.exec(`CREATE TRIGGER reject_metadata_insert BEFORE INSERT ON turn_model_usage
      BEGIN SELECT RAISE(ABORT,'fixture metadata rejection'); END;
    CREATE TRIGGER reject_metadata_update BEFORE UPDATE ON turn_model_usage
      BEGIN SELECT RAISE(ABORT,'fixture metadata rejection'); END;`);
  // 100→110은 같은 길이이므로 빈 줄로 변경 감지를 보장한 뒤 rollback을 검증한다.
  await writeFile(path,jsonl([user(),response(110)])+'\n');
  assert.equal((await refreshSummary(db,options)).failed,1);
  assert.equal(db.queryTurns()[0].total_tokens,before.total_tokens);
  assert.equal(db.queryTurns()[0].updated_at,before.updated_at);
  assert.deepEqual(metadata(db),beforeMetadata);
  db.connection.exec('DROP TRIGGER reject_metadata_insert; DROP TRIGGER reject_metadata_update;');
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns()[0].total_tokens,112);
  assert.notDeepEqual(metadata(db),beforeMetadata);
}));

test('clearing statistics removes source state and all derived facts',async () => fixture(async ({db,root,options}) => {
  await writeFile(join(root,'session.jsonl'),jsonl([user(),response()]));
  assert.equal((await refreshSummary(db,options)).failed,0);assert.equal(metadata(db).length,1);
  db.clearData();assert.equal(db.queryTurnsCount(),0);
  for (const table of ['manifest','turn_summary','turn_model_usage','turn_capability_usage','turn_costs','sessions','projects']) {
    assert.equal(db.connection.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n,0);
  }
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('an aborted-only Codex source does not require an otherwise absent session row',async () => fixture(async ({db,root,options}) => {
  const path = join(root,'thread.jsonl'),codexOptions: SummaryOptions = {...options,roots:[{provider:'codex',path:root}]};
  await writeFile(path,jsonl([
    {type:'session_meta',payload:{id:'thread',cwd:'/synthetic/project'}},
    {type:'event_msg',timestamp:'2026-10-01T00:00:00Z',payload:{type:'task_started',turn_id:'turn',root_turn_id:'turn'}},
    {type:'turn_context',payload:{turn_id:'turn',root_turn_id:'turn',model:'gpt-5.6-sol'}},
    {type:'token_usage_record',payload:{turn_id:'turn',root_turn_id:'turn',response_id:'response',usage:{input_tokens:10,output_tokens:2}}},
    {type:'event_msg',timestamp:'2026-10-01T00:00:02Z',payload:{type:'turn_aborted',turn_id:'turn',root_turn_id:'turn'}},
  ]));
  assert.equal((await refreshSummary(db,codexOptions)).failed,0);
  assert.equal(db.queryTurnsCount(),0);assert.equal(metadata(db).length,1);
  await appendFile(path,jsonl([{type:'ignored'}]));
  assert.equal((await refreshSummary(db,codexOptions)).failed,0);
  assert.equal(db.queryTurnsCount(),0);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('disabling source retention revalidates a previously suppressed orphan calculation',async () => fixture(async ({db,root,options}) => {
  const main = join(root,'session.jsonl'),child = join(root,'session','subagents','agent.jsonl');
  await mkdir(join(root,'session','subagents'),{recursive:true});
  await writeFile(main,jsonl([user(),response()]));
  await writeFile(child,jsonl([response(20,'one','child-response','child-request')]));
  const retaining = {...options,retainDeletedSourceUsage:true};
  assert.equal((await refreshSummary(db,retaining)).failed,0);
  const before = db.queryTurns()[0];assert.equal(before.total_tokens,124);
  await unlink(main);assert.equal((await refreshSummary(db,retaining)).failed,0);
  assert.deepEqual(db.queryTurns()[0],before);
  const result = await refreshSummary(db,options);
  assert.equal(result.failed,1);
  assert.equal(db.queryTurns()[0].total_tokens,124);
  assert.equal(db.findManifest('claude',child)?.last_error,'missing-root-turn');
}));
