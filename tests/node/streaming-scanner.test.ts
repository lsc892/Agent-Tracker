// 단일 읽기의 고정 byte 경계와 읽기 완료 뒤 변경·취소의 반영 시점을 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SummaryDatabase } from '../../src/summary/db';
import { refreshSummary } from '../../src/summary/scanner';
import * as reader from '../../src/summary/scanner/sourceReader';
import type { SummaryOptions } from '../../src/summary/types';

const source = (input: number): string => [
  { type: 'user', sessionId: 'session', promptId: 'root', cwd: '/fixture', message: { content: 'Fixture' } },
  { type: 'assistant', promptId: 'root', requestId: 'request', message: { id: 'response', model: 'claude-sonnet-4-6',
    usage: { input_tokens: input, output_tokens: 2 } } },
].map(row => JSON.stringify(row)).join('\n') + '\n';

async function fixture(run: (db: SummaryDatabase, options: SummaryOptions, path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-streaming-read-'));
  const logs = join(directory, 'logs'); await mkdir(logs);
  const path = join(logs, 'session.jsonl');
  const options: SummaryOptions = { dbPath: join(directory, 'summary.sqlite'), roots: [{ provider: 'claude', path: logs }] };
  const db = new SummaryDatabase(options.dbPath);
  try {
    await writeFile(path, source(100));
    assert.equal((await refreshSummary(db, options)).failed, 0);
    await run(db, options, path);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
}

test('one source read accepts its fixed boundary and collects a later append on the next refresh', async t => fixture(async (db, options, path) => {
  await writeFile(path, source(200));
  const original = reader.readSource;
  let reads = 0;
  const spy = t.mock.method(reader, 'readSource', async (...args: Parameters<typeof original>) => {
    const read = await original(...args);
    if (++reads === 1) await appendFile(path, source(300));
    return read;
  });
  const refreshed = await refreshSummary(db, options);
  assert.equal(refreshed.failed, 0); assert.equal(refreshed.interrupted, false);
  assert.equal(reads, 1); assert.equal(db.queryTurns()[0].total_tokens, 202);
  spy.mock.restore();
  assert.equal((await refreshSummary(db, options)).failed, 0);
  assert.equal(db.queryTurns()[0].total_tokens, 302);
}));

test('a rewrite after the completed single read is observed by the next refresh', async t => fixture(async (db, options, path) => {
  await writeFile(path, source(200));
  const original = reader.readSource;
  let reads = 0;
  const spy = t.mock.method(reader, 'readSource', async (...args: Parameters<typeof original>) => {
    const read = await original(...args);
    if (++reads === 1) await writeFile(path, source(900) + source(300));
    return read;
  });
  const refreshed = await refreshSummary(db, options);
  assert.equal(reads, 1);
  assert.equal(refreshed.interrupted, false);
  assert.equal(refreshed.failed, 0);
  assert.equal(db.queryTurns()[0].total_tokens, 202);
  spy.mock.restore();
  assert.equal((await refreshSummary(db, options)).failed, 0);
  assert.equal(db.queryTurns()[0].total_tokens, 902);
}));

test('cancelling after evidence collection publishes no partial winner result', async t => fixture(async (db, options, path) => {
  const before = db.queryTurns(), controller = new AbortController();
  await writeFile(path, source(200));
  const original = reader.readSource;
  t.mock.method(reader, 'readSource', async (...args: Parameters<typeof original>) => {
    const read = await original(...args); controller.abort(); return read;
  });
  const refreshed = await refreshSummary(db, options, controller.signal);
  assert.equal(refreshed.interrupted, true); assert.equal(refreshed.error, 'interrupted');
  assert.deepEqual(db.queryTurns().map(row => ({ ...row })), before.map(row => ({ ...row, last_error: 'interrupted' })));
}));
