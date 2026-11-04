// 요약 임시 저장소의 계보 해석과 제한된 배치 트랜잭션을 검증한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryDatabase } from '../../src/summary/db';
import { SummaryStaging } from '../../src/summary/staging';
import { readJsonl } from '../../src/summary/jsonl';

function withStaging(check: (staging: SummaryStaging, database: SummaryDatabase) => void): void {
  const database = new SummaryDatabase(':memory:');
  const staging = new SummaryStaging(database.connection);
  try { check(staging,database); } finally {staging.close();database.close();}
}

function codexFile(staging: SummaryStaging,id: number,thread: string,parent: string|null = null,
  options: {session?:string;failed?:boolean;removed?:boolean;parsed?:boolean} = {}): void {
  const session = options.session ?? parent ?? thread;
  staging.addFile({id,provider:'codex',source_root:'/synthetic',path:`/synthetic/${id}.jsonl`,session_id:session,
    size_bytes:0,mtime_ms:0,dev:null,inode:null,parser_version:1},null,true,options.removed);
  if (options.parsed !== false) staging.identity(id,{threadId:thread,parentThreadId:parent,sessionId:session,
    projectKey:'/synthetic',projectName:'synthetic',isMain:parent===null});
  if (options.failed) staging.fail(id);
}

test('lineage resolves chains beyond 128 ancestors and links every reassigned identity',() => withStaging((staging,database) => {
  // Descendants precede their parents so the disk stack also grows beyond 128 frames.
  codexFile(staging,301,'root');
  for (let index=1;index<=300;index++) codexFile(staging,301-index,`child-${index}`,index===1?'root':`child-${index-1}`);
  staging.resolveLineage();
  assert.equal(database.connection.prepare("SELECT count(*) count FROM scan_files WHERE session_id<>'root'").get()?.count,0);
  assert.ok(database.connection.prepare("SELECT 1 FROM links WHERE provider='codex' AND a='child-299' AND b='root'").get());
  assert.ok(database.connection.prepare("SELECT 1 FROM affected WHERE session_id='child-299'").get());
  assert.equal(database.connection.prepare('SELECT count(*) count FROM flags').get()?.count,0);
}));

test('lineage detects cycles without reassigning them or flagging an unrelated valid component',() => withStaging((staging,database) => {
  codexFile(staging,1,'cycle-a','cycle-b',{session:'original-a'});
  codexFile(staging,2,'cycle-b','cycle-a',{session:'original-b'});
  codexFile(staging,3,'cycle-descendant','cycle-a',{session:'original-descendant'});
  codexFile(staging,4,'valid-root');codexFile(staging,5,'valid-child','valid-root');
  codexFile(staging,6,'self-cycle','self-cycle');
  staging.resolveLineage();
  assert.deepEqual(database.connection.prepare('SELECT id,session_id FROM scan_files ORDER BY id').all().map(row=>[row.id,row.session_id]),
    [[1,'original-a'],[2,'original-b'],[3,'original-descendant'],[4,'valid-root'],[5,'valid-root'],[6,'self-cycle']]);
  assert.deepEqual(database.connection.prepare("SELECT file_id FROM flags WHERE flag='missing-parent-agent' ORDER BY file_id").all().map(row=>row.file_id),[1,2,3,6]);
  staging.resolveLineage();
  assert.equal(database.connection.prepare("SELECT session_id FROM scan_files WHERE id=1").get()?.session_id,'original-a');
}));

test('lineage compares resolved sessions of duplicate parent sources and preserves ambiguous metadata',() => withStaging((staging,database) => {
  // The child's candidates have different initial sessions but both eventually reach the same root.
  codexFile(staging,1,'child','duplicate-parent',{session:'child-before'});
  codexFile(staging,2,'duplicate-parent','branch-a');codexFile(staging,3,'duplicate-parent','branch-b');
  codexFile(staging,4,'branch-a','root');codexFile(staging,5,'branch-b','root');codexFile(staging,6,'root');
  codexFile(staging,7,'ambiguous-parent',null,{session:'root-a'});
  codexFile(staging,8,'ambiguous-parent',null,{session:'root-b'});
  codexFile(staging,9,'ambiguous-child','ambiguous-parent',{session:'known-session'});
  codexFile(staging,10,'descendant','ambiguous-child');
  staging.resolveLineage();
  for (const id of [1,2,3,4,5,6]) assert.equal(database.connection.prepare('SELECT session_id FROM scan_files WHERE id=?').get(id)?.session_id,'root');
  for (const id of [9,10]) assert.equal(database.connection.prepare('SELECT session_id FROM scan_files WHERE id=?').get(id)?.session_id,'known-session');
  assert.equal(database.connection.prepare('SELECT count(*) count FROM flags').get()?.count,0);
}));

test('lineage excludes failed, removed and unparsed parents and retains known sessions when ancestors are absent',() => withStaging((staging,database) => {
  codexFile(staging,1,'failed-parent',null,{failed:true});codexFile(staging,2,'removed-parent',null,{removed:true});
  codexFile(staging,3,'unparsed-parent',null,{parsed:false});
  codexFile(staging,4,'failed-child','failed-parent',{session:'keep-failed'});
  codexFile(staging,5,'removed-child','removed-parent',{session:'keep-removed'});
  codexFile(staging,6,'unparsed-child','unparsed-parent',{session:'keep-unparsed'});
  codexFile(staging,7,'missing-child','absent-parent',{session:'known-root'});
  codexFile(staging,8,'grandchild','missing-child',{session:'before'});
  // A removed copy must not make a surviving parent's session ambiguous.
  codexFile(staging,9,'same-parent',null,{session:'removed-root',removed:true});
  codexFile(staging,10,'same-parent',null,{session:'live-root'});codexFile(staging,11,'live-child','same-parent');
  staging.resolveLineage();
  assert.deepEqual(database.connection.prepare('SELECT session_id FROM scan_files WHERE id BETWEEN 4 AND 8 ORDER BY id').all().map(row=>row.session_id),
    ['keep-failed','keep-removed','keep-unparsed','known-root','known-root']);
  assert.equal(database.connection.prepare('SELECT session_id FROM scan_files WHERE id=11').get()?.session_id,'live-root');
  assert.deepEqual(database.connection.prepare("SELECT file_id FROM flags WHERE flag='missing-parent-agent' ORDER BY file_id").all().map(row=>row.file_id),[4,5,6,7]);
  // Scanner can parse a previously unseen parent and resolve lineage again in the same refresh.
  codexFile(staging,12,'absent-parent',null,{session:'known-root'});
  staging.resolveLineage();
  assert.equal(database.connection.prepare("SELECT 1 FROM flags WHERE file_id=7 AND flag='missing-parent-agent'").get(),undefined);
}));

test('bounded TEMP event batches leave the persistent database available to another writer',async () => {
  const directory = await mkdtemp(join(tmpdir(),'agent-tracker-staging-'));
  const path = join(directory,'summary.sqlite');
  const database = new SummaryDatabase(path);
  const writer = new SummaryDatabase(path);
  const staging = new SummaryStaging(database.connection);
  try {
    // A busy timeout of zero makes an accidental main-database writer lock fail immediately.
    writer.connection.exec('PRAGMA busy_timeout=0');
    staging.batchEvents(() => {
      staging.event(1,{kind:'turn',rootId:'request-one',isMain:true,offset:0});
      writer.observeFile({provider:'claude',source_root:directory,path:join(directory,'synthetic.jsonl'),session_id:null,
        size_bytes:0,mtime_ms:0,dev:null,inode:null,parser_version:1},'synthetic-scan');
    });
    assert.equal(writer.diagnostics().counts.files,1);
    assert.equal((database.connection.prepare('SELECT count(*) count FROM events').get() as {count:number}).count,1);
    assert.throws(() => staging.batchEvents(() => {
      staging.event(1,{kind:'turn',rootId:'request-two',isMain:true,offset:1});
      throw new Error('synthetic parse failure');
    }),/synthetic parse failure/);
    assert.equal((database.connection.prepare('SELECT count(*) count FROM events').get() as {count:number}).count,1);
    // A failed chunk leaves no transaction open, and the next chunk can be staged normally.
    staging.batchEvents(() => staging.event(1,{kind:'turn',rootId:'request-three',isMain:true,offset:2}));
    assert.equal((database.connection.prepare('SELECT count(*) count FROM events').get() as {count:number}).count,2);
  } finally { staging.close();writer.close();database.close();await rm(directory,{recursive:true,force:true}); }
});

test('consecutive component aggregates keep shared request ids, empty usage, titles and capabilities isolated',() => withStaging((staging,database) => {
  for (const [id,session] of [[1,'a'],[2,'b'],[3,'c']] as const) {
    codexFile(staging,id,session);
    staging.event(id,{kind:'turn',rootId:'shared-request',isMain:true,offset:0,title:`Title ${session}`});
  }
  staging.event(1,{kind:'usage',rootId:'shared-request',responseId:'shared-response',requestId:null,
    threadId:'a',turnId:'shared-request',model:'gpt-5.4',billingMode:'subscription',offset:1,
    tokens:{input:10,output:2,cacheRead:0,cacheWrite:0,reasoning:0}});
  staging.event(1,{kind:'capability',rootId:'shared-request',threadId:'a',eventId:'same-event',
    category:'skill',name:'first-only',offset:2});
  staging.event(3,{kind:'usage',rootId:'shared-request',responseId:'shared-response',requestId:null,
    threadId:'c',turnId:'shared-request',model:'gpt-5.4',billingMode:'api',offset:1,
    tokens:{input:20,output:3,cacheRead:5,cacheWrite:0,reasoning:0}});
  const rows = [];
  while (staging.nextComponent()) {
    staging.prepareSummaries();
    const componentRows = [...staging.summaries()];
    assert.equal(componentRows.length,1);
    const row=componentRows[0];
    rows.push({session:row.session_id,title:row.request_title,tokens:row.total_tokens,billing:row.billing,
      skills:[...(row.capability_usage ?? [])].filter(usage=>usage.category==='skill').map(usage=>usage.name),
      models:[...(row.model_usage ?? [])].map(model=>[model.model,model.input_tokens,model.output_tokens])});
    staging.finishComponent();
  }
  assert.deepEqual(rows,[
    {session:'a',title:'Title a',tokens:12,billing:'subscription',skills:['first-only'],models:[['gpt-5.4',10,2]]},
    {session:'b',title:'Title b',tokens:0,billing:'unknown',skills:[],models:[]},
    {session:'c',title:'Title c',tokens:23,billing:'api',skills:[],models:[['gpt-5.4',20,3]]},
  ]);
  assert.equal(database.connection.prepare('SELECT count(*) n FROM events').get()?.n,0);
}));

test('JSONL batch processing keeps chunk boundaries without changing offsets or trailing-line deferral',async () => {
  const directory = await mkdtemp(join(tmpdir(),'agent-tracker-jsonl-batch-'));
  const path = join(directory,'synthetic.jsonl');
  const row = JSON.stringify({type:'synthetic',value:'x'.repeat(1024)})+'\n';
  const text = row.repeat(150)+'{"partial":';
  await writeFile(path,text);
  let rows = 0;
  let inBatch = false;
  let largestBatch = 0;
  let batches = 0;
  try {
    const result = await readJsonl(path,Buffer.byteLength(text),(_row,offset) => {
      assert.equal(inBatch,true);
      assert.equal(offset,rows * Buffer.byteLength(row));
      rows++;
    },{processBatch:parseRows => {
      const before = rows;inBatch=true;
      try {parseRows();} finally {inBatch=false;}
      largestBatch=Math.max(largestBatch,rows-before);batches++;
    }});
    assert.equal(result.rows,150);assert.equal(result.partialLine,true);
    assert.ok(batches>=3);assert.ok(largestBatch<=64);
  } finally {await rm(directory,{recursive:true,force:true});}
});
