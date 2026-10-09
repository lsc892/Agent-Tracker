import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SummaryDatabase } from '../../src/summary/db';
import { SummaryStaging } from '../../src/summary/staging';
import { readJsonl } from '../../src/summary/jsonl';

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
