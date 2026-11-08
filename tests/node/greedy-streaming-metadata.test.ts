// 패자 DTO를 버려도 원본 진단·서명과 변경 요청 반영 계약이 유지되는지 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SummaryDatabase} from '../../src/summary/db';
import {refreshSummary} from '../../src/summary/scanner';
import type {SummaryOptions} from '../../src/summary/types';

const jsonl=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
const response=(input:number,cacheRead=0,model='gpt-5.6-sol')=>({
  type:'token_usage_record',timestamp:'2026-11-01T00:00:01Z',payload:{
    root_turn_id:'root',turn_id:'root',response_id:'shared-response',model,
    usage:{input_tokens:input,output_tokens:3,cached_input_tokens:cacheRead},
  },
});
const source=(loser:unknown)=>jsonl([
  {type:'session_meta',payload:{id:'thread',session_id:'session',cwd:'/synthetic/project'}},
  {type:'event_msg',timestamp:'2026-11-01T00:00:00Z',payload:{type:'task_started',root_turn_id:'root',turn_id:'root'}},
  {type:'turn_context',payload:{root_turn_id:'root',turn_id:'root',model:'gpt-5.6-sol'}},
  response(200),loser,
  {type:'event_msg',timestamp:'2026-11-01T00:00:02Z',payload:{type:'task_complete',root_turn_id:'root',turn_id:'root'}},
]);

async function fixture(run:(db:SummaryDatabase,options:SummaryOptions,path:string)=>Promise<void>):Promise<void>{
  const directory=await mkdtemp(join(tmpdir(),'agent-tracker-greedy-metadata-'));
  const path=join(directory,'thread.jsonl'),options:SummaryOptions={dbPath:join(directory,'summary.sqlite'),
    roots:[{provider:'codex',path:directory,dataHome:directory}],retainDeletedSourceUsage:false};
  const db=new SummaryDatabase(options.dbPath);
  try{await run(db,options,path);}finally{db.close();await rm(directory,{recursive:true,force:true});}
}

test('a discarded current usage DTO still contributes token quality flags and their later removal',async()=>fixture(async(db,options,path)=>{
  await writeFile(path,source(response(100,200)));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const initial=db.queryTurns()[0];assert.equal(initial.total_tokens,203);
  assert.match(initial.quality_flags??'',/component-clamped/,
    'the warning belongs to the observed source even when the warned DTO loses');
  await writeFile(path,source(response(100,20)));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const corrected=db.queryTurns()[0];assert.equal(corrected.total_tokens,203);
  assert.doesNotMatch(corrected.quality_flags??'',/component-clamped/);
  assert.equal(db.queryTurns({}, {},'model')[0].model,'gpt-5.6-sol');
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('discarded source usage is absorbed into the stream signature without rewriting unchanged facts',async()=>fixture(async(db,options,path)=>{
  await writeFile(path,source(response(100)));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const before=db.queryTurns()[0];
  const signature=()=>db.connection.prepare("SELECT signature FROM turn_metadata WHERE root_id='root'").get()?.signature;
  const originalSignature=signature();assert.equal(typeof originalSignature,'string');
  db.connection.exec(`CREATE TABLE greedy_fact_writes(operation TEXT);
    CREATE TRIGGER greedy_fact_insert AFTER INSERT ON turn_summary BEGIN INSERT INTO greedy_fact_writes VALUES('insert'); END;
    CREATE TRIGGER greedy_fact_update AFTER UPDATE ON turn_summary BEGIN INSERT INTO greedy_fact_writes VALUES('update'); END;
    CREATE TRIGGER greedy_fact_delete AFTER DELETE ON turn_summary BEGIN INSERT INTO greedy_fact_writes VALUES('delete'); END;`);
  await writeFile(path,source(response(90,0,'gpt-6-sol')));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.notEqual(signature(),originalSignature,'the raw stream signature must reflect even a discarded DTO');
  assert.deepEqual(db.queryTurns()[0],before,'the selected normalized facts are unchanged');
  assert.equal(db.connection.prepare('SELECT count(*) n FROM greedy_fact_writes').get()?.n,0);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('a real legacy fork keeps a surviving zero-token DTO from its cached source after the copied winner is excluded',async()=>fixture(async(db,options,path)=>{
  const parent=join(options.roots[0].path,'parent.jsonl');
  const metadata=(id:string,forkedFromId?:string)=>({type:'session_meta',payload:{
    id,session_id:'session',cwd:'/synthetic/project',...(forkedFromId?{forked_from_id:forkedFromId}:{}),
  }});
  const context=(model='gpt-5.6-sol')=>({type:'turn_context',payload:{turn_id:'root',root_turn_id:'root',model}});
  const start={type:'event_msg',timestamp:'2026-11-01T00:00:00Z',
    payload:{type:'task_started',turn_id:'root',root_turn_id:'root'}};
  const end={type:'event_msg',timestamp:'2026-11-01T00:00:02Z',
    payload:{type:'task_complete',turn_id:'root',root_turn_id:'root'}};
  const cumulative=(input:number)=>({type:'event_msg',payload:{type:'token_count',
    info:{total_token_usage:{input_tokens:input,output_tokens:0}}}});
  await writeFile(parent,jsonl([metadata('parent'),start,context(),cumulative(100),end]));
  await writeFile(path,jsonl([metadata('child','parent'),start,context(),cumulative(100),cumulative(90),
    context('gpt-6-sol'),cumulative(100),end]));
  const result=await refreshSummary(db,options);
  assert.equal(result.failed,0);
  assert.equal(result.parsed,2,'each source is parsed once and its DTOs provide prefix fallback');
  assert.equal(result.bodyBytes,(await stat(parent)).size+(await stat(path)).size);
  const turn=db.queryTurns()[0];assert.equal(turn.total_tokens,100);
  assert.match(turn.quality_flags??'',/counter-regression/);
  const models=db.connection.prepare('SELECT model,input_tokens,output_tokens FROM turn_model_usage ORDER BY model').all();
  assert.deepEqual(models.map(row=>[row.model,row.input_tokens,row.output_tokens]),[
    ['gpt-5.6-sol',100,0],['gpt-6-sol',0,0],
  ],'the post-prefix lower DTO contributes its own model even though its usage is zero');
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
}));
