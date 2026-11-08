// SQL 적재 전 Map 선택·정정·식별 경계와 legacy 복사 접두사를 독립 기대값으로 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryEvents, type MemoryFile } from '../../src/summary/staging/memoryEvents';
import { SummaryDatabase } from '../../src/summary/db';
import { SummaryStaging } from '../../src/summary/staging';
import type { UsageEvent } from '../../src/summary/types';

const file=(id:number,provider:MemoryFile['provider']='claude',session='session'):MemoryFile=>({
  id,provider,session_id:session,parsed:1,failed:0,removed:0,thread_id:`thread-${id}`,parent_thread_id:null,forked_from_id:null,
});
const usage=(response:string,input:number,output:number,extra:Partial<UsageEvent>={}):UsageEvent=>({
  kind:'usage',rootId:'root',responseId:response,requestId:null,threadId:'thread',turnId:'turn',schema:'current',
  tokens:{input,output,cacheRead:0,cacheWrite:0,reasoning:0},offset:input,...extra,
});

test('memory winners preserve canonical requests, whole-row corrections, provider/session keys and original roots',()=>{
  const memory=new MemoryEvents(), files=[file(1),file(2),file(3,'codex'),file(4,'claude','other')];
  memory.add(1,usage('response',100,30,{model:'winner',rootId:'first',offset:5}));
  memory.add(2,usage('response',110,10,{requestId:'request',model:'loser',rootId:'other',offset:8}));
  memory.add(2,usage('response',90,40,{requestId:'request',model:'latest',rootId:'final',offset:9}));
  memory.add(3,usage('response',1,1));memory.add(4,usage('response',1,1));
  memory.add(1,usage('ambiguous',10,0));memory.add(1,usage('ambiguous',1,0,{requestId:'a'}));
  memory.add(2,usage('ambiguous',2,0,{requestId:'b'}));
  memory.add(1,usage('big',Number.MAX_SAFE_INTEGER,2));memory.add(2,usage('big',Number.MAX_SAFE_INTEGER,1));
  const selected=memory.deduplicate(files), winners=selected.rows.filter(row=>row.event.kind==='usage');
  assert.deepEqual(winners.map(row=>row.id),[3,4,5,6,7,8,9]);
  assert.equal(selected.canonical.get(3),'request');
  assert.deepEqual(selected.rows.filter(row=>row.event.kind==='anchor').map(row=>[row.id,row.fileId,row.event.rootId,row.event.offset]),
    [[1,1,'first',5],[2,2,'other',8],[10,2,'root',Number.MAX_SAFE_INTEGER]]);
  assert.equal(memory.size,10,'distinct provisional keys remain until final reconciliation');
  memory.beginBatch();memory.add(1,usage('rolled-back',1,1));memory.rollbackBatch();
  assert.equal(memory.size,10);assert.deepEqual(memory.deduplicate(files),selected);
});

test('legacy prefix filtering precedes response selection and removes copied controls and capabilities',()=>{
  const memory=new MemoryEvents(), parent=file(1,'codex'),child={...file(2,'codex'),forked_from_id:parent.thread_id};
  const capability={kind:'capability' as const,rootId:'copied',threadId:'thread',eventId:'tool',category:'skill' as const,name:'read',offset:0};
  memory.add(1,capability);memory.add(1,usage('copied',5,5,{schema:'legacy',rootId:'copied'}));
  memory.add(2,{kind:'turn',rootId:'copied',isMain:true,offset:0});memory.add(2,capability);
  memory.add(2,usage('copied',5,5,{schema:'legacy',rootId:'copied'}));
  memory.add(2,usage('new',10,1,{schema:'legacy',rootId:'new'}));
  assert.deepEqual(memory.excludePrefixes([parent,child]),[2]);
  assert.deepEqual([...memory.rows()].map(row=>row.id),[1,2,6]);
  memory.add(2,usage('current',1,1));memory.excludeLegacy();
  assert.deepEqual([...memory.rows()].map(row=>row.id),[1,2,7]);
});

test('capability Maps preserve thread keys and source anchors while DTOs snapshot mutable token values',()=>{
  const memory=new MemoryEvents(), files=[file(1),file(2)];
  const event={kind:'capability' as const,rootId:'root',threadId:'thread',eventId:'call',category:'skill' as const,name:'read',offset:1};
  memory.add(1,event);memory.add(2,event);memory.add(2,{...event,threadId:'other'});
  const raw=usage('response',10,1);memory.add(1,raw);raw.tokens.input=999;
  const selected=memory.deduplicate(files);
  assert.deepEqual(selected.rows.map(row=>[row.id,row.event.kind]),[[1,'capability'],[2,'anchor'],[3,'capability'],[4,'usage']]);
  assert.equal((selected.rows[3].event as UsageEvent).tokens.input,10);
});

test('parsing creates no SQL event rows and unique DTOs are loaded without reading SQL candidates',()=>{
  const db=new SummaryDatabase(':memory:'),stage=new SummaryStaging(db.connection);
  try {
    stage.addFile({id:1,provider:'claude',source_root:'/fixture',path:'/fixture/main.jsonl',session_id:'session',
      size_bytes:0,mtime_ms:0,dev:null,inode:null,parser_version:14},null,true);
    stage.identity(1,{sessionId:'session',threadId:'thread',parentThreadId:null,isMain:true,projectKey:'/fixture',projectName:'fixture'});
    stage.batchEvents(()=>{
      stage.event(1,{kind:'turn',rootId:'root',isMain:true,startedAt:1,offset:0});
      stage.event(1,usage('response',10,1));stage.event(1,usage('response',20,2));stage.event(1,usage('response',30,3));
    });
    assert.equal(db.connection.prepare('SELECT count(*) n FROM events').get()?.n,0);
    assert.equal(db.connection.prepare('SELECT count(*) n FROM flags').get()?.n,0);
    const original=db.connection.prepare,queries:string[]=[];
    db.connection.prepare=function(sql){queries.push(sql);return original.call(this,sql);};
    try { stage.nextComponent();stage.prepareSummaries(); }
    finally {db.connection.prepare=original;}
    assert.ok(!queries.some(sql=>/SELECT e\.id,e\.response_id/.test(sql)),'no SQL-to-Map candidate read');
    assert.equal(db.connection.prepare("SELECT count(*) n FROM events WHERE kind='usage'").get()?.n,1);
    assert.equal(db.connection.prepare('SELECT input,output FROM winners').get()?.input,30);
    assert.equal([...stage.summaries()][0].total_tokens,33);
  } finally {stage.close();db.close();}
});
