import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, appendFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SummaryDatabase, type TurnSummaryInput } from '../src/summary/db';
import { refreshSummary } from '../src/summary/scanner';
import type { SummaryOptions } from '../src/summary/types';

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
    session_id:'one',session_name:'100%_session',root_turn_id:'first',turn_index:1,
    duration_quality:'missing',input_tokens:10,output_tokens:2,total_tokens:12,status:'in_progress'};
  const replace = (summaries: TurnSummaryInput[]): void => db.replaceSessions({sessions:[{provider:'claude',session_id:'one'}],files:[],summaries});
  replace([row,{...row,root_turn_id:'second',turn_index:2}]);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM projects').get()?.n,1);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM sessions').get()?.n,1);
  assert.equal(db.queryTurnsCount({projectName:'%_',sessionName:'%_'}),2);
  assert.equal(db.queryUsageCount({sessionName:'missing%'}),0);
  assert.throws(()=>replace([{...row,session_name:'broken',project_name:'broken',total_tokens:999}]),/CHECK constraint/);
  assert.ok(db.queryTurns().every(turn=>turn.project_name==='100%_project' && turn.session_name==='100%_session'));
  replace([{...row,session_name:'renamed'}]);
  assert.equal(db.queryTurns()[0].session_name,'renamed');
  replace([]);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM sessions').get()?.n,0);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM projects').get()?.n,0);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
});

test('name choices page through every stored identity with stable ordering and provider/project scoping', t => {
  const db = new SummaryDatabase(':memory:');t.after(()=>db.close());
  const summaries: TurnSummaryInput[] = Array.from({length:125},(_,index)=>({
    provider:'codex',project_key:`/project-${index}`,project_name:'같은 프로젝트명',
    session_id:`session-${index}`,session_name:index===124 ? null : '같은 세션명',root_turn_id:'request',turn_index:1,
    started_at_ms:index,duration_quality:'missing',input_tokens:10,output_tokens:2,total_tokens:12,status:'in_progress',
  }));
  summaries.push({...summaries[0],provider:'claude'});
  db.replaceSessions({sessions:summaries.map(row=>({provider:row.provider,session_id:row.session_id})),files:[],summaries});
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
