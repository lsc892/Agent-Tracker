// 세션·프로젝트 이름의 우선순위·식별자·저장·필터·페이지를 검증한다.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SummaryDatabase, type TurnSummaryInput } from '../../src/summary/db';
import { refreshSummary } from '../../src/summary/scanner';
import type { SummaryOptions } from '../../src/summary/types';

const jsonl = (rows: unknown[]): string => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const claude = (id: string, title: string): unknown[] => [
  {type:'user',sessionId:id,promptId:`request-${id}`,cwd:'/project',message:{content:'private body is not a title'}},
  {type:'assistant',message:{id:`response-${id}`,stop_reason:'end_turn',usage:{input_tokens:100,output_tokens:10}}},
  {type:'ai-title',sessionId:id,aiTitle:title},
];
const codex = (id: string): unknown[] => [
  {type:'session_meta',payload:{id,cwd:'/project'}},
  {type:'turn_context',payload:{turn_id:`request-${id}`}},
  {type:'token_usage_record',payload:{turn_id:`request-${id}`,response_id:`response-${id}`,usage:{input_tokens:20,output_tokens:3}}},
];

function metadataCalls(db: SummaryDatabase) {
  const calls = { projects: 0, sessions: 0, billing: 0, titleUpdates: 0, facts: 0, order: [] as string[] };
  const prepare = db.connection.prepare.bind(db.connection);
  db.connection.prepare = sql => {
    const statement = prepare(sql), run = statement.run, get = statement.get;
    const kind = /^INSERT INTO projects/.test(sql) ? 'projects' : /^INSERT INTO sessions/.test(sql) ? 'sessions'
      : /^UPDATE sessions SET session_name/.test(sql) ? 'titleUpdates' : /^INSERT INTO turn_summary/.test(sql) ? 'facts' : undefined;
    if (kind) statement.run = function(...parameters: unknown[]) {
      calls[kind]++; calls.order.push(kind);
      return Reflect.apply(run, this, parameters);
    };
    if (/^SELECT billing_mode FROM session_billing/.test(sql)) statement.get = function(...parameters: unknown[]) {
      calls.billing++;
      return Reflect.apply(get, this, parameters);
    };
    return statement;
  };
  return Object.assign(calls, { reset: () => {
    calls.projects = calls.sessions = calls.billing = calls.titleUpdates = calls.facts = 0;
    calls.order.length = 0;
  } });
}

function memoryRow(root: string, session = 'one', override: Partial<TurnSummaryInput> = {}): TurnSummaryInput {
  return { provider: 'claude', project_key: '/project', project_name: 'Project', session_id: session,
    session_name: 'Session', root_turn_id: root, duration_quality: 'missing', input_tokens: 10, output_tokens: 2,
    total_tokens: 12, status: 'in_progress', ...override };
}

function fixture(t: TestContext, provider: 'claude' | 'codex'): {db:SummaryDatabase;options:SummaryOptions;root:string;base:string} {
  const parent = realpathSync(tmpdir());
  const base = mkdtempSync(join(parent,'agent-tracker-names-'));
  const root = join(base,provider==='claude'?'projects':'sessions');
  mkdirSync(root);
  const options: SummaryOptions = {dbPath:join(base,'summary.sqlite'),roots:[{provider,path:root,dataHome:base}]};
  const db = new SummaryDatabase(options.dbPath);
  t.after(()=> {
    db.close();
    const target = resolve(base);
    assert.ok(target.startsWith(`${parent}${sep}`) && target.split(sep).at(-1)?.startsWith('agent-tracker-names-'));
    rmSync(target,{recursive:true,force:true});
  });
  return {db,options,root,base};
}

test('identical AI titles stay separate, custom titles win, and subagents cannot rename the parent', async t => {
  const {db,options,root} = fixture(t,'claude');
  const main = join(root,'one.jsonl');
  writeFileSync(main,jsonl(claude('one','같은 제목')));
  writeFileSync(join(root,'two.jsonl'),jsonl(claude('two','같은 제목')));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const rows = db.queryUsage({sessionName:'같은 제목'},'session');
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row=>row.session_id),['one','two']);
  assert.ok(rows.every(row=>row.session_name==='같은 제목' && row.total_tokens===110));
  assert.equal(db.queryUsageCount({projectName:'project',sessionName:'같은 제목'},'session'),2);
  assert.equal(db.queryTurnsCount({sessionName:'같은 제목',sessionId:'two'}),1);
  mkdirSync(join(root,'one','subagents'),{recursive:true});
  writeFileSync(join(root,'one','subagents','agent.jsonl'),jsonl([
    {type:'ai-title',aiTitle:'자식 이름'},
    {type:'assistant',promptId:'request-one',requestId:'child',message:{id:'child',usage:{input_tokens:1,output_tokens:1}}},
  ]));
  appendFileSync(main,jsonl([{type:'custom-title',sessionId:'one',customTitle:'사용자 이름'},
    {type:'ai-title',sessionId:'one',aiTitle:'이후 AI 이름'}]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns({sessionId:'one'})[0].session_name,'사용자 이름');
  assert.equal(db.queryTurns({sessionId:'two'})[0].session_name,'같은 제목');
  assert.equal(db.connection.prepare('SELECT count(*) n FROM sessions').get()?.n,2);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM projects').get()?.n,1);
  const columns = db.connection.prepare('PRAGMA table_info(turn_summary)').all().map(row=>row.name);
  assert.ok(!columns.includes('project_name') && !columns.includes('session_name'));
  assert.equal(db.queryTurns({sessionName:'private body'}).length,0);
});

test('Codex index renames update unchanged transcripts, survive missing metadata, and preserve source files', async t => {
  const {db,options,root,base} = fixture(t,'codex');
  const log = jsonl(codex('one'));
  writeFileSync(join(root,'one.jsonl'),log);
  const index = join(base,'session_index.jsonl');
  writeFileSync(index,jsonl([{id:'one',thread_name:'원래 이름'}]));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns()[0].session_name,'원래 이름');
  const turnsBefore = db.connection.prepare('SELECT * FROM turn_summary').all();
  appendFileSync(index,jsonl([{id:'one',thread_name:'바뀐 이름'}]));
  const refresh = await refreshSummary(db,options);
  assert.equal(refresh.parsed,0);assert.equal(refresh.reused,1);assert.equal(refresh.bodyBytes,0);
  assert.equal(db.queryUsage({sessionName:'바뀐 이름'},'session')[0].session_name,'바뀐 이름');
  assert.deepEqual(db.connection.prepare('SELECT * FROM turn_summary').all(),turnsBefore);
  assert.equal(readFileSync(join(root,'one.jsonl'),'utf8'),log);
  unlinkSync(index);
  await refreshSummary(db,options);
  assert.equal(db.queryTurns()[0].session_name,'바뀐 이름');
});

test('Codex state DB names override index titles, support duplicate titles, and are read only', async t => {
  const {db,options,root,base} = fixture(t,'codex');
  writeFileSync(join(root,'one.jsonl'),jsonl(codex('one')));
  writeFileSync(join(root,'two.jsonl'),jsonl(codex('two')));
  writeFileSync(join(base,'session_index.jsonl'),jsonl([{id:'one',thread_name:'오래된 이름'}]));
  const source = new DatabaseSync(join(base,'state_5.sqlite'));
  try {
    source.exec("CREATE TABLE threads(id TEXT PRIMARY KEY,title TEXT,name TEXT); INSERT INTO threads VALUES('one','자동 이름','같은 이름'),('two','같은 이름',NULL)");
    const before = source.prepare('SELECT * FROM threads ORDER BY id').all();
    assert.equal((await refreshSummary(db,options)).failed,0);
    assert.equal(db.queryUsageCount({sessionName:'같은 이름'},'session'),2);
    assert.ok(db.queryTurns().every(row=>row.session_name==='같은 이름'));
    assert.deepEqual(source.prepare('SELECT * FROM threads ORDER BY id').all(),before);
    source.exec("UPDATE threads SET name='새 이름' WHERE id='one'");
    assert.equal((await refreshSummary(db,options)).parsed,0);
    assert.equal(db.queryTurns({sessionId:'one'})[0].session_name,'새 이름');
  } finally { source.close(); }
});

test('names are stored once, filters escape wildcard characters, and failed replacements roll back metadata', t => {
  const db = new SummaryDatabase(':memory:');t.after(()=>db.close());
  const row: TurnSummaryInput = {provider:'claude',project_key:'/project',project_name:'100%_project',
    session_id:'one',session_name:'100%_session',root_turn_id:'first',
    duration_quality:'missing',input_tokens:10,output_tokens:2,total_tokens:12,status:'in_progress'};
  const replace = (summaries: TurnSummaryInput[]): void => { db.replaceMemory({scanId: 'test',sessions:[{provider:'claude',session_id:'one'}],files:[],summaries}); };
  replace([row,{...row,root_turn_id:'second'}]);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM projects').get()?.n,1);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM sessions').get()?.n,1);
  assert.equal(db.queryTurnsCount({projectName:'%_',sessionName:'%_'}),2);
  assert.equal(db.queryUsageCount({sessionName:'missing%'}),0);
  assert.throws(()=>replace([{...row,session_name:'broken',project_name:'broken',total_tokens:999}]),/Invalid total tokens/);
  assert.ok(db.queryTurns().every(turn=>turn.project_name==='100%_project' && turn.session_name==='100%_session'));
  replace([{...row,session_name:'renamed'}]);
  assert.equal(db.queryTurns()[0].session_name,'renamed');
  replace([]);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM sessions').get()?.n,0);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM projects').get()?.n,0);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('normal batches collect final names once per key and keep request-specific billing fallback', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  const calls = metadataCalls(db);
  let iterations = 0;
  function* rows() {
    iterations++;
    yield memoryRow('first', 'same', { project_name: 'First project', session_name: ' First ', billing: 'api' });
    yield memoryRow('second', 'same', { session_name: '   ', billing: 'subscription' });
    yield memoryRow('third', 'same', { session_name: 'Final', billing: 'unknown' });
    yield memoryRow('fourth', 'same', { session_name: null, billing: 'api' });
  }
  const saved = db.replaceMemoryBatch([
    { scanId: 'batch', sessions: [{ provider: 'claude', session_id: 'same' }], files: [], summaries: rows() },
    { scanId: 'batch', sessions: [{ provider: 'codex', session_id: 'same' }], files: [],
      summaries: [memoryRow('other-provider', 'same', { provider: 'codex', project_name: 'Last project', session_name: 'Codex' })] },
  ]);
  assert.equal(iterations, 1);
  assert.deepEqual([calls.projects, calls.sessions, calls.billing], [1, 2, 2]);
  assert.ok(calls.order.slice(0, 3).every(kind => kind !== 'facts'), 'Parent metadata precedes request FK writes');
  assert.equal(db.connection.prepare('SELECT project_name FROM projects').get()?.project_name, 'Last project');
  assert.deepEqual([...saved], [['["claude","same"]', 'Final'], ['["codex","same"]', 'Codex']]);
  assert.ok(db.queryTurns({ provider: 'claude' }).every(row => row.session_name === 'Final'));
  assert.deepEqual(db.connection.prepare('SELECT billing_mode FROM turn_costs ORDER BY turn_id').all().map(row => row.billing_mode),
    ['api', 'subscription', 'unknown', 'api', 'unknown']);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
});

test('billing override is read once per session and empty names preserve accepted metadata', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  const calls = metadataCalls(db);
  db.replaceMemory({ scanId: 'initial', sessions: [{ provider: 'claude', session_id: 'one' }], files: [], summaries: [memoryRow('old')] });
  db.setSessionBilling('claude', 'one', 'subscription');
  calls.reset();
  const saved = db.replaceMemory({ scanId: 'changed', sessions: [{ provider: 'claude', session_id: 'one' }], files: [],
    summaries: [memoryRow('first', 'one', { session_name: null, billing: 'api' }), memoryRow('second', 'one', { session_name: ' ', billing: 'unknown' })] });
  assert.deepEqual([calls.projects, calls.sessions, calls.billing], [1, 1, 1]);
  assert.equal(saved.size, 0, 'Unknown preserved names are not reported as newly applied names');
  assert.ok(db.queryTurns({ includeCosts: true }).every(row => row.session_name === 'Session' && row.billing_mode === 'subscription'));
});

test('failed metadata batches roll back names and retry with a fresh transaction plan', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  db.connection.exec(`CREATE TRIGGER metadata_failure BEFORE INSERT ON turn_summary WHEN NEW.root_turn_id='bad'
    BEGIN SELECT RAISE(ABORT,'metadata-failure'); END`);
  const replacements = ['one', 'two'].map((session, index) => ({ scanId: 'batch',
    sessions: [{ provider: 'claude' as const, session_id: session }], files: [],
    summaries: [memoryRow(index ? 'bad' : 'good', session, { session_name: session })] }));
  assert.throws(() => db.replaceMemoryBatch(replacements), /metadata-failure/);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM projects').get()?.n, 0);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM sessions').get()?.n, 0);
  db.connection.exec('DROP TRIGGER metadata_failure');
  assert.equal(db.replaceMemoryBatch(replacements).size, 2);
  assert.equal(db.queryTurnsCount(), 2);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
});

test('repeated-session snapshots retain deletion billing cascades and do not report pruned names', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  const session = { provider: 'claude' as const, session_id: 'one' };
  db.replaceMemory({ scanId: 'initial', sessions: [session], files: [], summaries: [memoryRow('old')] });
  db.setSessionBilling('claude', 'one', 'subscription');
  const saved = db.replaceMemoryBatch([
    { scanId: 'delete', sessions: [session], files: [], summaries: [] },
    { scanId: 'recreate', sessions: [session], files: [], summaries: [memoryRow('new', 'one', { session_name: null, billing: 'api' })] },
  ]);
  assert.equal(saved.size, 0);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM session_billing').get()?.n, 0);
  assert.equal(db.queryTurns({ includeCosts: true })[0].billing_mode, 'api');
  assert.equal(db.queryTurns()[0].session_name, null);
});

test('retained requests do not contribute replacement names or billing metadata', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  const calls = metadataCalls(db);
  const file = db.observeFile({ provider: 'claude', source_root: '/logs', path: '/logs/one.jsonl', session_id: 'one',
    size_bytes: 100, mtime_ms: 10, dev: '1', inode: '1', parser_version: 1 }, 'initial');
  const row = memoryRow('retained', 'one', { model_usage: [{ model: 'model', input_tokens: 10, output_tokens: 2,
    cache_write_input_tokens: 0, cache_read_input_tokens: 0 }] });
  const sessions = [{ provider: 'claude' as const, session_id: 'one' }];
  db.replaceMemory({ scanId: 'initial', sessions, files: [{ ...file, session_id: 'one' }], summaries: [row] });
  calls.reset();
  const saved = db.replaceMemory({ scanId: 'removed', sessions, files: [], removedFileIds: [file.id], retainDeletedSourceUsage: true,
    summaries: [{ ...row, project_key: '/discarded', project_name: 'Discarded', session_name: 'Discarded' }] });
  assert.deepEqual([calls.projects, calls.sessions, calls.billing, saved.size], [0, 0, 0, 0]);
  assert.equal(db.queryTurns()[0].session_name, 'Session');
  assert.equal(db.connection.prepare("SELECT count(*) n FROM projects WHERE project_key='/discarded'").get()?.n, 0);
});

test('scanner skips committed names but still applies metadata-only title changes', async t => {
  const { db, options, root, base } = fixture(t, 'codex');
  writeFileSync(join(root, 'one.jsonl'), jsonl(codex('one')));
  const index = join(base, 'session_index.jsonl');
  writeFileSync(index, jsonl([{ id: 'one', thread_name: 'First' }]));
  const calls = metadataCalls(db);
  assert.equal((await refreshSummary(db, options)).failed, 0);
  assert.deepEqual([calls.sessions, calls.titleUpdates], [1, 0]);
  appendFileSync(index, jsonl([{ id: 'one', thread_name: 'Renamed' }]));
  assert.equal((await refreshSummary(db, options)).parsed, 0);
  assert.equal(calls.titleUpdates, 1);
  assert.equal(db.queryTurns()[0].session_name, 'Renamed');
});

test('scanner fallback records only committed names and finishes metadata for the failed session', async t => {
  const { db, options, root, base } = fixture(t, 'codex');
  const calls = metadataCalls(db);
  for (const id of ['one', 'two']) writeFileSync(join(root, `${id}.jsonl`), jsonl(codex(id)));
  const index = join(base, 'session_index.jsonl');
  writeFileSync(index, jsonl(['one', 'two'].map(id => ({ id, thread_name: `Original ${id}` }))));
  assert.equal((await refreshSummary(db, options)).failed, 0);
  db.connection.exec(`CREATE TRIGGER metadata_failure BEFORE UPDATE ON turn_summary
    WHEN NEW.session_id='two' AND NEW.input_tokens<>OLD.input_tokens BEGIN SELECT RAISE(ABORT,'metadata-failure'); END`);
  for (const id of ['one', 'two']) writeFileSync(join(root, `${id}.jsonl`), jsonl(codex(id)).replace('"input_tokens":20', '"input_tokens":40') + '\n');
  appendFileSync(index, jsonl(['one', 'two'].map(id => ({ id, thread_name: `Final ${id}` }))));
  calls.reset();
  const result = await refreshSummary(db, options);
  assert.equal(result.failed, 1);
  assert.equal(calls.titleUpdates, 1, 'The rolled-back session must still receive its metadata-only title update');
  assert.equal(db.queryTurns({ sessionId: 'one' })[0].session_name, 'Final one');
  assert.equal(db.queryTurns({ sessionId: 'two' })[0].session_name, 'Final two');
  assert.equal(db.queryTurns({ sessionId: 'one' })[0].input_tokens, 40);
  assert.equal(db.queryTurns({ sessionId: 'two' })[0].input_tokens, 20);
});

test('name choices page through every stored identity with stable ordering and provider/project scoping', t => {
  const db = new SummaryDatabase(':memory:');t.after(()=>db.close());
  const summaries: TurnSummaryInput[] = Array.from({length:125},(_,index)=>({
    provider:'codex',project_key:`/project-${index}`,project_name:'같은 프로젝트명',
    session_id:`session-${index}`,session_name:index===124 ? null : '같은 세션명',root_turn_id:'request',
    started_at_ms:index,duration_quality:'missing',input_tokens:10,output_tokens:2,total_tokens:12,status:'in_progress',
  }));
  summaries.push({...summaries[0],provider:'claude'});
  db.replaceMemory({scanId: 'test',sessions:summaries.map(row=>({provider:row.provider,session_id:row.session_id})),files:[],summaries});
  const projects = db.queryNames({kind:'project'});
  assert.equal(projects.total,125);assert.equal(projects.rows.length,100);
  const projectTail = db.queryNames({kind:'project',offset:100});
  assert.equal(projectTail.rows.length,25);
  assert.equal(new Set([...projects.rows,...projectTail.rows].map(row=>row.project_key)).size,125);
  assert.equal(db.queryNames({kind:'project',provider:'claude'}).total,1);
  assert.equal(db.queryNames({kind:'project',providers:['claude'],provider:'codex'}).total,0);
  assert.equal(db.queryNames({kind:'session',providers:[]}).total,0);
  const first = db.queryNames({kind:'session'});
  const last = db.queryNames({kind:'session',offset:100});
  assert.equal(first.total,126);assert.equal(first.rows.length,100);assert.equal(last.rows.length,26);
  assert.equal(new Set([...first.rows,...last.rows].map(row=>`${row.provider}/${row.project_key}/${row.session_id}`)).size,126);
  const sameId = db.queryNames({kind:'session',projectKey:'/project-0'});
  assert.equal(sameId.total,2);assert.deepEqual(sameId.rows.map(row=>row.provider),['claude','codex']);
  const unnamed = db.queryNames({kind:'session',projectKey:'/project-124'}).rows[0];
  assert.equal(unnamed.session_name,null);assert.equal(unnamed.session_started_at_ms,124);
  assert.equal(db.queryNames({kind:'session',offset:1000}).rows.length,0);
  assert.throws(()=>db.queryNames({kind:'project',limit:1001}),RangeError);
  assert.throws(()=>db.queryNames({kind:'session',offset:-1}),RangeError);
});
