// 최종 세션 귀속이 깊은 계보·순환·중복 부모에서도 전체 갱신 결과를 보존하는지 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryDatabase } from '../../src/summary/db';
import { refreshSummary } from '../../src/summary/scanner';
import type { SummaryOptions } from '../../src/summary/types';

const jsonl=(rows:unknown[])=>rows.map(row=>JSON.stringify(row)).join('\n')+'\n';
const source=(thread:string,parent:string|null=null,session=parent??thread,input=1,model='gpt-5.6-sol')=>jsonl([
  {type:'session_meta',payload:{id:thread,parent_thread_id:parent,session_id:session,cwd:'/synthetic/project'}},
  {type:'event_msg',timestamp:'2026-11-01T00:00:00Z',payload:{type:'task_started',root_turn_id:'root',turn_id:'root'}},
  {type:'token_usage_record',payload:{root_turn_id:'root',turn_id:'root',response_id:'response',model,
    usage:{input_tokens:input,output_tokens:0}}},
]);

async function fixture(run:(db:SummaryDatabase,options:SummaryOptions,root:string)=>Promise<void>):Promise<void>{
  const directory=await mkdtemp(join(tmpdir(),'agent-tracker-lineage-'));
  const root=join(directory,'logs');await mkdir(root);
  const options:SummaryOptions={dbPath:join(directory,'summary.sqlite'),roots:[{provider:'codex',path:root}],retainDeletedSourceUsage:false};
  const db=new SummaryDatabase(options.dbPath);
  try{await run(db,options,root);}finally{db.close();await rm(directory,{recursive:true,force:true});}
}

test('the scanner resolves more than 128 ancestors even when descendants are discovered first',async()=>fixture(async(db,options,root)=>{
  for(let index=300;index>=1;index--){
    await writeFile(join(root,`${String(300-index).padStart(3,'0')}-child.jsonl`),
      source(`child-${index}`,index===1?'main':`child-${index-1}`));
  }
  await writeFile(join(root,'999-main.jsonl'),source('main'));
  const result=await refreshSummary(db,options);
  assert.equal(result.failed,0);assert.equal(result.parsed,301);
  assert.equal(db.queryTurnsCount(),1);assert.equal(db.queryTurns()[0].total_tokens,301);
  assert.equal(db.queryTurns()[0].session_id,'main');
  assert.doesNotMatch(db.queryTurns()[0].quality_flags??'',/missing-parent/);
  assert.equal(db.connection.prepare("SELECT count(*) AS n FROM manifest WHERE session_id<>'main'").get()?.n,0);
}));

test('cyclic lineage preserves its declared session and flags only that component and its dependents',async()=>fixture(async(db,options,root)=>{
  const entries:[string,string][]=[
    ['cycle-main',source('cycle-main',null,'cycle-session')],
    ['cycle-a',source('cycle-a','cycle-b','cycle-session')],
    ['cycle-b',source('cycle-b','cycle-a','cycle-session')],
    ['dependent',source('dependent','cycle-a','cycle-session')],
    ['healthy',source('healthy')],
  ];
  for(const [name,content] of entries)await writeFile(join(root,`${name}.jsonl`),content);
  assert.equal((await refreshSummary(db,options)).failed,0);
  const rows=db.queryTurns();assert.equal(rows.length,2);
  const cycle=rows.find(row=>row.session_id==='cycle-session')!;
  const healthy=rows.find(row=>row.session_id==='healthy')!;
  assert.equal(cycle.total_tokens,4);assert.match(cycle.quality_flags??'',/missing-parent-agent/);
  assert.equal(healthy.total_tokens,1);assert.doesNotMatch(healthy.quality_flags??'',/missing-parent/);
  assert.equal(db.findManifest('codex',join(root,'dependent.jsonl'))?.session_id,'cycle-session');
}));

test('duplicate parent identities must agree on their resolved session before a child is reassigned',async()=>fixture(async(db,options,root)=>{
  const child=join(root,'child.jsonl');
  await writeFile(join(root,'a-parent.jsonl'),source('duplicate',null,'session-a'));
  await writeFile(join(root,'b-parent.jsonl'),source('duplicate',null,'session-b'));
  await writeFile(join(root,'child-main.jsonl'),source('child-main',null,'child-session'));
  await writeFile(child,source('child','duplicate','child-session'));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.findManifest('codex',child)?.session_id,'child-session');
  assert.equal(db.queryTurns().find(row=>row.session_id==='child-session')?.total_tokens,2);
  // 같은 시각 단위 안의 재작성도 크기 변경으로 확실하게 발견한다.
  await writeFile(join(root,'b-parent.jsonl'),source('duplicate',null,'session-a')+'\n');
  await writeFile(child,source('child','duplicate','child-session')+'\n');
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.findManifest('codex',child)?.session_id,'session-a');
  assert.equal(db.queryTurns().find(row=>row.session_id==='session-a')?.total_tokens,2,
    'the two identical parent records are deduplicated before adding the child');
  assert.equal(db.queryTurns().find(row=>row.session_id==='child-session')?.total_tokens,1);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
}));

test('changed sources expand their stored session when filenames contain no thread identities',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'00.jsonl'),child=join(root,'01.jsonl'),other=join(root,'02.jsonl');
  await writeFile(main,source('hidden-main-thread',null,'shared-session'));
  await writeFile(child,source('hidden-child-thread','hidden-main-thread','shared-session'));
  await writeFile(other,source('independent-thread'));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const independent=db.queryTurns().find(row=>row.session_id==='independent-thread')!;

  await writeFile(child,source('hidden-child-thread','hidden-main-thread','shared-session',17));
  const updated=await refreshSummary(db,options);
  assert.equal(updated.failed,0);assert.equal(updated.parsed,2);assert.equal(updated.reused,1);
  assert.equal(db.queryTurns().find(row=>row.session_id==='shared-session')?.total_tokens,18);
  assert.deepEqual(db.queryTurns().find(row=>row.session_id==='independent-thread'),independent);
  assert.doesNotMatch(db.queryTurns().find(row=>row.session_id==='shared-session')?.quality_flags??'',/missing-parent/);

  const unchanged=await refreshSummary(db,options);
  assert.equal(unchanged.parsed,0);assert.equal(unchanged.bodyBytes,0);assert.equal(unchanged.reused,3);
}));

test('moving a parent between sessions updates unchanged descendants and both previous and next totals',async()=>fixture(async(db,options,root)=>{
  const mainA=join(root,'thread-main-a.jsonl'),mainB=join(root,'thread-main-b.jsonl');
  const child=join(root,'thread-child.jsonl'),grandchild=join(root,'opaque-descendant.jsonl');
  await writeFile(mainA,source('thread-main-a'));
  await writeFile(mainB,source('thread-main-b'));
  await writeFile(child,source('thread-child','thread-main-a','thread-main-a'));
  await writeFile(grandchild,source('thread-grandchild','thread-child','thread-main-a'));
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.queryTurns().find(row=>row.session_id==='thread-main-a')?.total_tokens,3);

  await writeFile(child,source('thread-child','thread-main-b','thread-main-b',11));
  const updated=await refreshSummary(db,options);
  assert.equal(updated.failed,0);assert.equal(updated.parsed,4);
  assert.equal(db.findManifest('codex',child)?.session_id,'thread-main-b');
  assert.equal(db.findManifest('codex',grandchild)?.session_id,'thread-main-b');
  const rows=db.queryTurns();assert.equal(rows.length,2);
  assert.equal(rows.find(row=>row.session_id==='thread-main-a')?.total_tokens,1);
  assert.equal(rows.find(row=>row.session_id==='thread-main-b')?.total_tokens,13);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);

  const unchanged=await refreshSummary(db,options);
  assert.equal(unchanged.parsed,0);assert.equal(unchanged.bodyBytes,0);
  assert.deepEqual(db.queryTurns(),rows);
}));

test('new descendants preserve the later-id winner among multiple unchanged parent filename candidates',async()=>fixture(async(db,options,root)=>{
  const main=join(root,'thread-main.jsonl');
  const first=join(root,'first-thread-parent.jsonl'),second=join(root,'second-thread-parent.jsonl');
  await writeFile(main,source('thread-main',null,'session-main',1,'main-model'));
  await writeFile(first,source('thread-parent','thread-main','session-main',10,'parent-a'));
  await writeFile(second,source('thread-parent','thread-main','session-main',10,'parent-b'));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const winner=db.findManifest('codex',first)!.id>db.findManifest('codex',second)!.id?'parent-a':'parent-b';
  const models=()=>db.connection.prepare('SELECT model,input_tokens FROM turn_model_usage ORDER BY model').all();
  assert.deepEqual(models().map(row=>({...row})),[{model:'main-model',input_tokens:1},{model:winner,input_tokens:10}]);

  await writeFile(join(root,'new-grandchild.jsonl'),source('new-grandchild','thread-parent','session-main',3,'grandchild-model'));
  const updated=await refreshSummary(db,options);
  assert.equal(updated.failed,0);assert.equal(updated.parsed,4);
  const rows=db.queryTurns();assert.equal(rows.length,1);assert.equal(rows[0].total_tokens,14);
  assert.equal(rows[0].session_id,'session-main');
  assert.deepEqual(models().map(row=>({...row})),[
    {model:'grandchild-model',input_tokens:3},{model:'main-model',input_tokens:1},{model:winner,input_tokens:10},
  ]);
  assert.doesNotMatch(rows[0].quality_flags??'',/missing-parent/);
}));

test('overlapping scan roots prepare each manifest file once after discovery replaces its queued state',async()=>fixture(async(db,options,root)=>{
  const nested=join(root,'nested');await mkdir(nested);
  const main=join(root,'00.jsonl'),child=join(nested,'01.jsonl');
  const mainSource=source('opaque-main-thread',null,'shared-session');
  await writeFile(main,mainSource);
  await writeFile(child,source('opaque-child-thread','opaque-main-thread','shared-session'));
  assert.equal((await refreshSummary(db,options)).failed,0);
  const previousId=db.findManifest('codex',child)!.id;

  const changedSource=source('opaque-child-thread','opaque-main-thread','shared-session',17);
  await writeFile(child,changedSource);
  const overlapping:SummaryOptions={...options,roots:[...options.roots,{provider:'codex',path:nested}]};
  const updated=await refreshSummary(db,overlapping);
  assert.equal(updated.failed,0);assert.equal(updated.discovered,3);assert.equal(updated.parsed,2);
  assert.equal(updated.bodyBytes,Buffer.byteLength(mainSource)+Buffer.byteLength(changedSource));
  assert.equal(db.connection.prepare('SELECT count(*) AS n FROM manifest').get()?.n,2);
  assert.equal(db.findManifest('codex',child)?.id,previousId);
  assert.equal(db.findManifest('codex',child)?.source_root,nested);
  const rows=db.queryTurns();assert.equal(rows.length,1);assert.equal(rows[0].total_tokens,18);
}));
