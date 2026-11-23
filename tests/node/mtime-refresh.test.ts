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
const recentWindow = () => ({ fromMs: Date.now() - 30 * 86_400_000, toMs: Date.now() + 86_400_000 });

async function fixture<T>(action: (path: string, options: { dbPath: string; roots: { provider: 'codex'; path: string }[] }) => Promise<T>): Promise<T> {
  const path = await mkdtemp(join(tmpdir(), 'tracker-mtime-'));
  try { return await action(path, { dbPath: join(path, 'summary.sqlite'), roots: [{ provider: 'codex', path }] }); }
  finally { await rm(path, { recursive: true, force: true }); }
}

function cutoff(db: SummaryDatabase): number | undefined {
  return db.connection.prepare('SELECT started_ms FROM summary_refresh WHERE id=1').get()?.started_ms as number | undefined;
}

test('cold dashboard scan previews recent sources and reuses their reads for the complete snapshot', async () => fixture(async (path, options) => {
  const recentPath = join(path, 'recent.jsonl'), olderPath = join(path, 'older.jsonl');
  const recentSource = source('recent', 120), olderSource = source('older', 240);
  await writeFile(recentPath, recentSource);
  await writeFile(olderPath, olderSource);
  await utimes(olderPath, old, old);
  const baseline = new SummaryDatabase(':memory:');
  const database = new SummaryDatabase(options.dbPath);
  let previewSessions: string[] | undefined;
  let checkpointAtPreview: number | undefined;
  let committedAtPreview: number | undefined;
  try {
    const result = await refreshSummary(database, options, undefined, undefined, {
      ...recentWindow(),
      onReady: db => {
        previewSessions = db.queryTurns().map(row => row.session_id);
        checkpointAtPreview = cutoff(database);
        committedAtPreview = database.queryTurnsCount();
      },
    });
    assert.equal(checkpointAtPreview, undefined);
    assert.equal(committedAtPreview, 0);
    assert.deepEqual(previewSessions, ['recent']);
    assert.equal(result.bodyBytes, Buffer.byteLength(recentSource + olderSource));
    assert.equal(result.parsed, 2);
    assert.ok(cutoff(database) !== undefined);
    assert.equal((await refreshSummary(baseline, options)).failed, 0);
    const facts = (db: SummaryDatabase) => db.queryTurns().map(({ updated_at: _updatedAt, ...row }) => row);
    assert.deepEqual(facts(database), facts(baseline));
  } finally {
    database.close();
    baseline.close();
  }
}));

test('warm refresh previews a new response and the unchanged winner before releasing SQLite queries', async () => fixture(async (path, options) => {
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
  const recentUsage = recentWindow();
  let release: (() => void) | undefined;
  let previewTotal: number | undefined;
  let firstBytes: number | undefined;
  let refreshed = false;
  try {
    await client.refresh();
    const previous = cutoff(database)!;
    await appendFile(file, added);
    const changedAt = new Date(previous + 10);
    await utimes(file, changedAt, changedAt);
    release = await acquireRefreshLock(options.dbPath);
    client.subscribe(progress => {
      if (!progress.recentUsage) return;
      previewTotal = progress.recentUsage.rows.reduce((sum, row) => sum + (row.total_tokens ?? 0), 0);
      firstBytes = progress.bodyBytes;
    });
    const refreshing = client.refresh({ recentUsage }).then(result => { refreshed = true; return result; });
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
    assert.equal(previewTotal, 281);
    assert.equal(firstBytes, result.bodyBytes);
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
    const archived = join(path, 'archived.jsonl');
    await writeFile(archived, source('archived', 10));
    await utimes(archived, old, old);
    db.connection.exec(`CREATE TEMP TRIGGER reject_unchanged_file_update BEFORE UPDATE ON main.source_file
      BEGIN SELECT RAISE(ABORT, 'unchanged files must not be rewritten'); END;`);
    const unchanged = await refreshSummary(db, options);
    assert.equal(unchanged.failed, 0);
    assert.equal(unchanged.interrupted, false);
    assert.equal(unchanged.parsed, 0);
    assert.equal(unchanged.bodyBytes, 0);
    assert.equal(db.queryTurnsCount(), 2);
    assert.equal(db.queryTurns().find(row => row.session_id === 'one')?.total_tokens, 130);
    db.connection.exec('DROP TRIGGER reject_unchanged_file_update');

    const previous = cutoff(db);
    assert.ok(previous !== undefined);
    const time = new Date(previous + 1);
    await utimes(one, time, time);
    const updated = await refreshSummary(db, options);
    assert.equal(updated.failed, 0);
    assert.equal(updated.parsed, 1);
    assert.equal(updated.bodyBytes, Buffer.byteLength(rewritten));
    assert.equal(db.queryTurns().find(row => row.session_id === 'one')?.total_tokens, 463);
    assert.equal(db.queryTurns().find(row => row.session_id === 'two')?.total_tokens, 241);
  } finally { db.close(); }
}));

test('a migration discards per-file offsets and retains previously committed facts', async () => fixture(async (path, options) => {
  const file = join(path, 'one.jsonl');
  await writeFile(file, source('one', 123));
  const previous = new SummaryDatabase(options.dbPath);
  try {
    assert.equal((await refreshSummary(previous, options)).failed, 0);
    previous.connection.exec(`DROP TABLE applied_response;
      DROP TABLE summary_refresh;
      ALTER TABLE source_file DROP COLUMN relation_meta;
      ALTER TABLE source_file ADD COLUMN complete_position INTEGER NOT NULL DEFAULT 100;
      ALTER TABLE source_file ADD COLUMN prefix_hash TEXT;
      UPDATE source_file SET parser_version=18;
      PRAGMA user_version=20;`);
  } finally { previous.close(); }

  const db = new SummaryDatabase(options.dbPath);
  try {
    assert.equal(db.queryTurns()[0].total_tokens, 130);
    const columns = db.connection.prepare('PRAGMA table_info(source_file)').all().map(row => row.name);
    assert.ok(!columns.includes('complete_position') && !columns.includes('prefix_hash'));
    assert.equal((await refreshSummary(db, options)).parsed, 1);
    assert.equal(db.queryTurns()[0].total_tokens, 130);
    assert.equal(db.connection.prepare('SELECT COUNT(*) AS count FROM applied_response').get()?.count, 1);
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
    db.clearData();
    assert.equal(cutoff(db), undefined);
    assert.equal(db.connection.prepare('SELECT COUNT(*) AS count FROM applied_response').get()?.count, 0);
  } finally { db.close(); }
}));

test('v22 migration preserves existing summaries and replaces the source cache with applied responses', async () => fixture(async (path, options) => {
  const file = join(path, 'one.jsonl');
  await writeFile(file, source('one', 123));
  const previous = new SummaryDatabase(options.dbPath);
  let summaryId: number;
  try {
    assert.equal((await refreshSummary(previous, options)).failed, 0);
    summaryId = previous.queryTurns()[0].id;
    previous.connection.exec(`DROP TABLE applied_response;
      ALTER TABLE source_file DROP COLUMN relation_meta;
      CREATE TABLE source_winner_snapshot (file_id INTEGER PRIMARY KEY REFERENCES source_file(id), state BLOB NOT NULL);
      CREATE TABLE source_winner_candidate (file_id INTEGER REFERENCES source_winner_snapshot(file_id), position INTEGER NOT NULL);
      INSERT INTO source_winner_snapshot SELECT id, x'01' FROM source_file;
      INSERT INTO source_winner_candidate SELECT file_id, 0 FROM source_winner_snapshot;
      UPDATE source_file SET parser_version=19;
      PRAGMA user_version=22;`);
  } finally { previous.close(); }

  const db = new SummaryDatabase(options.dbPath);
  try {
    assert.equal(db.queryTurns()[0].total_tokens, 130);
    assert.equal(db.queryTurns()[0].id, summaryId);
    assert.equal(db.connection.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name LIKE 'source_winner_%'").get()?.n, 0);
    assert.equal((await refreshSummary(db, options)).failed, 0);
    assert.equal(db.queryTurns()[0].total_tokens, 130);
    assert.equal(db.queryTurns()[0].id, summaryId);
    assert.equal(db.connection.prepare('SELECT count(*) AS n FROM applied_response').get()?.n, 1);
    await appendFile(file, `${JSON.stringify(usage(140))}\n`);
    assert.equal((await refreshSummary(db, options)).failed, 0);
    assert.equal(db.queryTurns()[0].total_tokens, 147);
    assert.equal(db.connection.prepare('SELECT count(*) AS n FROM applied_response').get()?.n, 1);
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { db.close(); }
}));

test('failure in the final SQLite transaction keeps the previous cutoff and allows a retry', async () => fixture(async (path, options) => {
  const file = join(path, 'one.jsonl');
  await writeFile(file, source('one', 123));
  const db = new SummaryDatabase(options.dbPath);
  try {
    assert.equal((await refreshSummary(db, options)).failed, 0);
    const previous = cutoff(db);
    assert.ok(previous !== undefined);
    await writeFile(file, source('one', 456));
    const time = new Date(previous + 1);
    await utimes(file, time, time);
    db.connection.exec(`CREATE TEMP TRIGGER reject_refresh BEFORE UPDATE ON main.summary_refresh
      BEGIN SELECT RAISE(ABORT, 'reject checkpoint'); END;`);
    assert.equal((await refreshSummary(db, options)).interrupted, true);
    assert.equal(cutoff(db), previous);
    db.connection.exec('DROP TRIGGER reject_refresh');
    const retry = await refreshSummary(db, options);
    assert.equal(retry.failed, 0);
    assert.equal(retry.parsed, 1);
    const advanced = cutoff(db);
    assert.ok(advanced !== undefined && advanced > previous);
    assert.equal(db.queryTurns()[0].total_tokens, 463);
  } finally { db.close(); }
}));
