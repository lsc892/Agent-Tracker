// 경로가 바뀐 원본의 재수집과 소실 원본의 독립적인 처리를 검증한다.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SummaryDatabase } from '../../src/summary/db';
import { refreshSummary } from '../../src/summary/scanner';
import type { SummaryOptions } from '../../src/summary/types';

function source(promptId: string, input: number): string {
  return [
    { type:'user', sessionId:'session', promptId, timestamp:'2026-10-01T00:00:00Z', cwd:'/project' },
    { type:'assistant', promptId, requestId:promptId, timestamp:'2026-10-01T00:00:01Z',
      message:{ id:promptId, model:'claude-sonnet-4-6', stop_reason:'end_turn', usage:{input_tokens:input,output_tokens:1} } },
  ].map(row=>JSON.stringify(row)).join('\n')+'\n';
}

async function fixture(run: (db:SummaryDatabase, options:SummaryOptions, root:string)=>Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(),'agent-tracker-source-paths-'));
  const root = join(dir,'logs');
  await mkdir(root);
  const options:SummaryOptions = { dbPath:join(dir,'db.sqlite'), roots:[{provider:'claude',path:root}], retainDeletedSourceUsage:false };
  const db = new SummaryDatabase(options.dbPath);
  try { await run(db,options,root); }
  finally { db.close(); await rm(dir,{recursive:true,force:true}); }
}

test('moving a log rereads the new path and removes the previous path without doubling totals', async () => fixture(async (db,options,root) => {
  const original = join(root,'old.jsonl'), moved = join(root,'moved.jsonl');
  await writeFile(original,source('request',20));
  await refreshSummary(db,options);
  await rename(original,moved);
  const result = await refreshSummary(db,options);
  assert.equal(result.failed,0);
  assert.equal(result.parsed,1);
  assert.equal(db.findSourceFile('claude',original),undefined);
  assert.equal(db.findSourceFile('claude',moved)?.processing_status,'done');
  assert.equal(db.queryUsage()[0].total_tokens,21);
  assert.equal(db.queryUsage()[0].turn_count,1);
  assert.equal((await refreshSummary(db,options)).bodyBytes,0);
}));

test('live copies remain distinct sources while shared responses count once', async () => fixture(async (db,options,root) => {
  const body = source('request',20);
  await writeFile(join(root,'one.jsonl'),body);
  await writeFile(join(root,'two.jsonl'),body);
  assert.equal((await refreshSummary(db,options)).failed,0);
  assert.equal(db.diagnostics().counts.files,2);
  assert.equal(db.queryUsage()[0].total_tokens,21);
  assert.equal(db.queryUsage()[0].turn_count,1);
}));

test('a different file in the same session replaces old daily usage and has its own source entry', async () => fixture(async (db,options,root) => {
  const retained = {...options,retainDeletedSourceUsage:true};
  const original = join(root,'old.jsonl'), replacement = join(root,'replacement.jsonl');
  await writeFile(original,source('old',20));
  await refreshSummary(db,retained);
  const originalId = db.findSourceFile('claude',original)?.id;
  assert.ok(originalId);
  await rm(original);
  await writeFile(replacement,source('new',30));
  assert.equal((await refreshSummary(db,retained)).failed,0);
  assert.equal(db.findSourceFile('claude',original),undefined);
  assert.notEqual(db.findSourceFile('claude',replacement)?.id,originalId);
  assert.equal(db.findSourceFile('claude',replacement)?.source_missing,0);
  assert.equal(db.diagnostics().counts.files,1);
  assert.equal(db.queryUsage()[0].total_tokens,31,'the replaced day uses the current session totals');
}));
