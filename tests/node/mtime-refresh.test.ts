// 갱신 기준 시각과 재파싱 범위, SQLite 실패 뒤 재시도를 검증한다.
import assert from 'node:assert/strict';
import { appendFile, mkdtemp, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { SummaryClient } from '../../src/summary/client';
import { SummaryDatabase } from '../../src/summary/db';
import { refreshSummary } from '../../src/summary/scanner';
import { acquireRefreshLock } from '../../src/summary/scanner/lock';

const old = new Date('2020-01-01T00:00:00Z');
const usage = (input: number, id = 'response') => ({ type: 'token_usage_record', payload: {
  root_turn_id: 'turn', turn_id: 'turn', response_id: id, usage: { input_tokens: input, output_tokens: 7 },
} });
const source = (session: string, input: number, timestamp?: Date) => [
  { type: 'session_meta', payload: { id: session, cwd: '/fixture' } },
  { type: 'turn_context', payload: { root_turn_id: 'turn', turn_id: 'turn' } },
  ...(timestamp ? [{ type: 'event_msg', timestamp, payload: { type: 'task_started', root_turn_id: 'turn', turn_id: 'turn' } }] : []),
  usage(input),
].map(row => JSON.stringify(row)).join('\n') + '\n';

async function fixture<T>(action: (path: string, options: { dbPath: string; roots: { provider: 'codex'; path: string }[] }) => Promise<T>): Promise<T> {
  const path = await mkdtemp(join(tmpdir(), 'tracker-mtime-'));
  try { return await action(path, { dbPath: join(path, 'summary.sqlite'), roots: [{ provider: 'codex', path }] }); }
  finally { await rm(path, { recursive: true, force: true }); }
}


test('warm refresh commits the new response and related winner before releasing SQLite queries', async () => fixture(async (path, options) => {
  const file = join(path, 'existing.jsonl'), companion = join(path, 'copy-of-existing.jsonl'), unchanged = join(path, 'unchanged.jsonl');
  const now = new Date();
  const existing = source('existing', 120, now);
  const companionSource = source('existing', 130, now);
  const added = `${JSON.stringify(usage(100, 'added'))}\n`;
  await writeFile(file, existing);
  await writeFile(companion, companionSource);
  await writeFile(unchanged, source('unchanged', 30, now));
  for (const log of [file, companion, unchanged]) await utimes(log, old, old);
  const client = new SummaryClient(options);
  const database = new SummaryDatabase(options.dbPath);
  let release: (() => void) | undefined;
  let refreshed = false;
  try {
    await client.refresh();
    await appendFile(file, added);
    const changedAt = new Date(old.getTime() + 1_000);
    await utimes(file, changedAt, changedAt);
    release = await acquireRefreshLock(options.dbPath);
    const refreshing = client.refresh().then(result => { refreshed = true; return result; });
    const current = Promise.all([
      client.query({ groupBy: 'all' }),
      client.queryNames({ kind: 'session' }),
    ]).then(page => ({ page, afterRefresh: refreshed }));
    assert.equal(await Promise.race([current, delay(70, undefined, { ref: false })]), undefined);
    assert.equal(database.queryUsage()[0].total_tokens, 174);
    release();
    release = undefined;
    const result = await refreshing;
    assert.equal(result.interrupted, false);
    assert.equal(result.failed, 0);
    assert.equal(result.bodyBytes, Buffer.byteLength(existing + added + companionSource));
    assert.equal(result.parsed, 2);
    const { page, afterRefresh } = await current;
    assert.equal(afterRefresh, true);
    assert.equal(page[0].rows[0].total_tokens, 281);
    assert.equal(page[1].total, 2);
  } finally {
    release?.();
    await client.dispose();
    database.close();
  }
}));

test('reopen skips old mtimes and reparses only the newer independent file from byte zero', async () => fixture(async (path, options) => {
  const one = join(path, 'one.jsonl'), two = join(path, 'two.jsonl');
  await writeFile(one, source('one', 123));
  await writeFile(two, source('two', 234));
  for (const file of [one, two]) await utimes(file, old, old);
  const original = new SummaryDatabase(options.dbPath);
  try { assert.equal((await refreshSummary(original, options)).parsed, 2); }
  finally { original.close(); }

  const db = new SummaryDatabase(options.dbPath);
  try {
    const rewritten = source('one', 456);
    await writeFile(one, rewritten);
    await utimes(one, old, old);
    db.connection.exec(`CREATE TEMP TRIGGER reject_unchanged_file_update BEFORE UPDATE ON main.source_file
      BEGIN SELECT RAISE(ABORT, 'unchanged files must not be rewritten'); END;`);
    const unchanged = await refreshSummary(db, options);
    assert.equal(unchanged.failed, 0);
    assert.equal(unchanged.interrupted, false);
    assert.equal(unchanged.parsed, 0);
    assert.equal(unchanged.bodyBytes, 0);
    assert.equal(db.queryTurnsCount(), 2);
    assert.equal(db.queryUsage({}, 'session').find(row => row.session_id === 'one')?.total_tokens, 130);
    db.connection.exec('DROP TRIGGER reject_unchanged_file_update');

    const time = new Date(old.getTime() + 60_000);
    await utimes(one, time, time);
    const updated = await refreshSummary(db, options);
    assert.equal(updated.failed, 0);
    assert.equal(updated.parsed, 1);
    assert.equal(updated.bodyBytes, Buffer.byteLength(rewritten));
    assert.equal(db.queryUsage({}, 'session').find(row => row.session_id === 'one')?.total_tokens, 463);
    assert.equal(db.queryUsage({}, 'session').find(row => row.session_id === 'two')?.total_tokens, 241);
  } finally { db.close(); }
}));


test('failed daily writes keep the source mtime and retry the same file', async () => fixture(async (path, options) => {
  const db = new SummaryDatabase(options.dbPath);
  try {
    const file = join(path, 'session.jsonl');
    await writeFile(file, source('session', 100));
    assert.equal((await refreshSummary(db, options)).failed, 0);
    const accepted = db.findSourceFile('codex', file);
    const previous = db.queryUsage();
    assert.ok(accepted);
    db.connection.exec("CREATE TEMP TRIGGER reject_daily BEFORE UPDATE ON main.usage_request_daily BEGIN SELECT RAISE(ABORT, 'reject daily'); END;");
    await appendFile(file, JSON.stringify(usage(200, 'second')) + '\n');
    assert.equal((await refreshSummary(db, options)).failed, 1);
    assert.deepEqual(db.queryUsage(), previous);
    assert.equal(db.findSourceFile('codex', file)?.mtime_ms, accepted.mtime_ms);
    db.connection.exec('DROP TRIGGER reject_daily');
    assert.equal((await refreshSummary(db, options)).failed, 0);
    assert.ok(db.queryUsage()[0].total_tokens > previous[0].total_tokens);
    assert.equal((await refreshSummary(db, options)).bodyBytes, 0);
  } finally { db.close(); }
}));
