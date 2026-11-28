// 일별 저장소의 트랜잭션·이관·원본 진단을 검증한다.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { serialize } from 'node:v8';
import { SummaryDatabase, periodBounds, type FileMetadata, type TurnSummaryInput } from '../../src/summary/db';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../../src/summary/db/schema';

function database(t: TestContext): SummaryDatabase {
  const db = new SummaryDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function metadata(index = 1, session = 'session-a', sourceRoot = '/synthetic/claude'): Omit<FileMetadata, 'relations'> {
  return {
    provider: 'claude', source_root: sourceRoot, path: `${sourceRoot}/${index}.jsonl`,
    session_id: session, size_bytes: 512, mtime_ms: 123456, parser_version: 1,
  };
}

function turn(root = 'turn-a', override: Partial<Omit<TurnSummaryInput, 'model_usage' | 'capability_usage' | 'billing'>> = {}): Omit<TurnSummaryInput, 'model_usage' | 'capability_usage' | 'billing'> {
  return {
    provider: 'claude', project_key: '/synthetic/project-a', project_name: 'Project', session_id: 'session-a',
    root_turn_id: root, started_at_ms: Date.parse('2026-10-03T00:00:00Z'),
    completed_at_ms: Date.parse('2026-10-03T00:00:01Z'), duration_ms: 1000, duration_quality: 'exact',
    input_tokens: 100, output_tokens: 10, total_tokens: 110, status: 'completed',
    updated_at: '2026-10-03T00:00:02.000Z', ...override,
  };
}

function seed(db: SummaryDatabase, rows: TurnSummaryInput[] = [turn()]): number {
  const file = metadata();
  const source_file = db.observeFile(file);
  db.replaceMemory({
    sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...file, id: source_file.id }], summaries: rows,
  });
  return source_file.id;
}

test('replacement rolls back summary, metadata, and deletion on a streaming row failure', t => {
  const db = database(t);
  const id = seed(db);
  const previous = db.queryUsage({}, 'session');
  function* failingRows(): IterableIterator<TurnSummaryInput> {
    yield turn('replacement', { total_tokens: 220, input_tokens: 200, output_tokens: 20 });
    throw new Error('synthetic staging failure');
  }
  assert.throws(() => db.replaceMemory({
    sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...metadata(), size_bytes: 1024, id }], summaries: failingRows(), removedFileIds: [id],
  }), /synthetic staging failure/);
  assert.deepEqual(db.queryUsage({}, 'session'), previous);
  assert.equal(db.findSourceFile('claude', metadata().path)?.mtime_ms, 123456);
  function* failingDeletion(): IterableIterator<number> {
    yield id;
    throw new Error('synthetic deletion failure');
  }
  assert.throws(() => db.replaceMemory({
    sessions: [{ provider: 'claude', session_id: 'session-a' }], files: [], summaries: [],
    removedFileIds: failingDeletion(),
  }), /synthetic deletion failure/);
  assert.deepEqual(db.queryUsage({}, 'session'), previous);
  assert.ok(db.findSourceFile('claude', metadata().path));
});

test('a failed first replacement can retry without publishing partial state', t => {
  const db = database(t);
  const file = metadata();
  const source_file = db.observeFile(file);
  assert.throws(() => db.replaceMemory({
    sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...file, id: source_file.id }], summaries: [turn('invalid', { total_tokens: 0 })],
  }));
  assert.equal(db.findSourceFile('claude', file.path)?.session_id, null);
  db.replaceMemory({
    sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...file, id: source_file.id }], summaries: [turn()],
  });
  assert.equal(db.queryUsage()[0].total_tokens, 110);
});

test('session replacement keeps identically named sessions from the other provider untouched', t => {
  const db = database(t);
  seed(db);
  db.replaceMemory({
    sessions: [{ provider: 'codex', session_id: 'session-a' }, { provider: 'claude', session_id: 'session-b' }],
    files: [], summaries: [turn('codex-turn', { provider: 'codex' }), turn('other-session', { session_id: 'session-b' })],
  });
  const otherProvider = db.queryUsage({ provider: 'codex' });
  const otherSession = db.queryUsage({ provider: 'claude', sessionId: 'session-b' });
  db.replaceMemory({
    sessions: [{ provider: 'claude', session_id: 'session-a' }], files: [],
    summaries: [turn('replacement', { input_tokens: 200, total_tokens: 210 })],
  });
  assert.deepEqual(db.queryUsage({ provider: 'codex' }), otherProvider);
  assert.deepEqual(db.queryUsage({ provider: 'claude', sessionId: 'session-b' }), otherSession);
  assert.equal(db.queryUsage({ provider: 'claude', sessionId: 'session-a' })[0].total_tokens, 210);
});

test('session reassignment changes both sessions atomically and preserves source_file identity on move', t => {
  const db = database(t);
  const id = seed(db);
  const sessions = [{ provider: 'claude' as const, session_id: 'session-a' }, { provider: 'claude' as const, session_id: 'session-b' }];
  const moved = { ...metadata(), path: '/synthetic/archive/moved.jsonl', source_root: '/synthetic/archive', session_id: 'session-b', id };
  assert.throws(() => db.replaceMemory({
    sessions, files: [moved], summaries: [turn('new', { session_id: 'session-b', total_tokens: 999 })],
  }));
  assert.equal(db.findSourceFile('claude', metadata().path)?.id, id);
  assert.equal(db.queryUsage({}, 'session')[0].session_id, 'session-a');
  db.replaceMemory({sessions, files: [moved], summaries: [turn('new', { session_id: 'session-b' })] });
  assert.equal(db.findSourceFile('claude', metadata().path), undefined);
  assert.equal(db.findSourceFile('claude', moved.path)?.id, id);
  assert.equal(db.queryTurnsCount({ sessionId: 'session-a' }), 0);
  assert.equal(db.queryTurnsCount({ sessionId: 'session-b' }), 1);
});

test('replacement rejects file reassignment and deletion outside its atomic session group', t => {
  const db = database(t);
  const id = seed(db);
  const before = db.queryUsage({}, 'session');
  const toSessionB = { ...metadata(), session_id: 'session-b', id };
  for (const included of ['session-a', 'session-b']) {
    assert.throws(() => db.replaceMemory({
      sessions: [{ provider: 'claude', session_id: included }], files: [toSessionB], summaries: [],
    }), /outside the replacement session group/);
    assert.deepEqual(db.queryUsage({}, 'session'), before);
    assert.equal(db.findSourceFile('claude', metadata().path)?.session_id, 'session-a');
  }
  assert.throws(() => db.replaceMemory({
    sessions: [{ provider: 'claude', session_id: 'session-b' }], files: [], summaries: [], removedFileIds: [id],
  }), /outside the replacement session group/);
  assert.ok(db.findSourceFile('claude', metadata().path));
  assert.deepEqual(db.queryUsage({}, 'session'), before);
  // An unprocessed file has no accepted session contribution to replace.
  const newFile = db.observeFile(metadata(2));
  db.replaceMemory({sessions: [], files: [], summaries: [], removedFileIds: [newFile.id] });
  assert.equal(db.findSourceFile('claude', metadata(2).path), undefined);
});

test('session file lookup streams beyond 256 files in ID order', t => {
  const db = database(t);
  for (let index = 1; index <= 300; index++) db.observeFile(metadata(index));
  db.observeFile(metadata(301, 'session-a', '/excluded'));
  function* files() {
    for (let index = 1; index <= 300; index++) {
      const file = metadata(index);
      yield { ...file, id: db.findSourceFile('claude', file.path)!.id };
    }
  }
  db.replaceMemory({sessions: [{ provider: 'claude', session_id: 'session-a' }], files: [...files()], summaries: [] });
  let count = 0;
  for (const row of db.sessionFiles('claude', 'session-a', 23)) {
    assert.equal(row.processing_status, 'done');
    count++;
    assert.equal(row.id, count);
  }
  assert.equal(count, 300);
  assert.equal(db.diagnostics({ limit: 25, offset: 300 }).files.length, 1);
});

test('calendar period boundaries honor daylight-saving gaps and repeats', () => {
  const spring = periodBounds('2026-03-08', 'America/New_York');
  const autumn = periodBounds('2026-11-01', 'America/New_York');
  assert.equal(spring.fromMs, Date.parse('2026-03-08T05:00:00Z'));
  assert.equal(spring.toMs - spring.fromMs, 23 * 60 * 60 * 1000);
  assert.equal(autumn.toMs - autumn.fromMs, 25 * 60 * 60 * 1000);
  assert.throws(() => periodBounds('2026-02-30', 'UTC'), RangeError);
});

test('calendar boundaries also handle midnight gaps, half-hour DST, and skipped dates', () => {
  const midnightGap = periodBounds('2018-11-04', 'America/Sao_Paulo');
  assert.equal(midnightGap.fromMs, Date.parse('2018-11-04T03:00:00Z'));
  assert.equal(midnightGap.toMs - midnightGap.fromMs, 23 * 60 * 60 * 1000);
  const halfHour = periodBounds('2026-10-04', 'Australia/Lord_Howe');
  assert.equal(halfHour.toMs - halfHour.fromMs, 23.5 * 60 * 60 * 1000);
  const skipped = periodBounds('2011-12-30', 'Pacific/Apia');
  assert.equal(skipped.fromMs, skipped.toMs);
});

test('the daily schema keeps only current tables and preserves source diagnostics across a failed refresh', t => {
  const db = database(t);
  const id = seed(db);
  const tables = db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  assert.deepEqual(tables.map(row => row.name), [
    'projects', 'sessions', 'source_file', 'usage_capability_daily', 'usage_model_daily',
    'usage_request_daily', 'usage_rollup_meta',
  ]);
  const previous = db.queryUsage();
  const observed = db.observeFile({ ...metadata(), mtime_ms: 654321, session_id: 'session-b', parser_version: 2 });
  assert.equal(observed.id, id);
  assert.equal(observed.mtime_ms, 123456);
  db.setSourceDiagnostic(id, 'error', 'parse: byte=128', 'parse-error');
  assert.deepEqual(db.queryUsage(), previous);
  assert.equal(db.diagnostics().counts.stale_summaries, 1);
  assert.equal(db.diagnostics().files[0].last_error, 'parse-error');
  seed(db);
  assert.equal(db.diagnostics().counts.stale_summaries, 0);
  assert.equal(db.diagnostics().files[0].last_error, null);
});

test('daily migration retains historical usage, names, source identity, Skill counts and billing', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-tracker-db-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'summary.sqlite');
  const legacy = new DatabaseSync(path);
  try {
    legacy.exec(SCHEMA_SQL);
    legacy.exec(`INSERT INTO projects VALUES ('/project', 'Historical project');
      INSERT INTO sessions VALUES ('claude', 'old', 'Historical session');
      INSERT INTO source_file (id, provider, source_root, path, session_id, mtime_ms, parser_version, processing_status, recorded_at)
        VALUES (42, 'claude', '/log', '/log/old.jsonl', 'old', 123456, 10, 'done', 'old');
      INSERT INTO turn_summary (id, provider, project_key, session_id, root_turn_id, started_at_ms, duration_ms,
        duration_quality, input_tokens, output_tokens, total_tokens, status, updated_at)
        VALUES (99, 'claude', '/project', 'old', 'r', 1790985600000, 1000, 'exact', 100, 10, 110, 'completed', 'old');
      INSERT INTO turn_capability_usage VALUES (99, 'skill', 'historical', 3);
      INSERT INTO session_billing VALUES ('claude', 'old', 'subscription');
      ALTER TABLE source_file RENAME TO manifest;
      PRAGMA user_version=22;`);
    legacy.prepare('UPDATE manifest SET relation_meta=? WHERE id=42').run(serialize({identity:{threadId:'thread-old'},threadUsage:true}));
  } finally { legacy.close(); }

  const migrated = new SummaryDatabase(path);
  try {
    const usage = migrated.queryUsage({ includeCosts:true }, 'session')[0];
    assert.equal(usage.total_tokens, 110);
    assert.equal(usage.avg_duration_ms, 1000);
    assert.equal(usage.session_name, 'Historical session');
    assert.equal(usage.project_name, 'Historical project');
    assert.equal(migrated.sessionBilling('claude', 'old'), 'subscription');
    assert.equal(migrated.queryCapabilities({}, 'skill').totalUses, 3);
    const source = migrated.findSourceFile('claude', '/log/old.jsonl');
    assert.equal(source?.id, 42);
    assert.equal(source.thread_id, 'thread-old');
    assert.equal(source.thread_usage, 1);
    assert.equal(migrated.connection.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
    assert.deepEqual(migrated.connection.prepare('PRAGMA foreign_key_check').all(), []);
    assert.deepEqual(migrated.connection.prepare("SELECT name FROM sqlite_master WHERE name IN ('manifest','turn_summary','session_billing')").all(), []);
  } finally { migrated.close(); }
});

test('version 32 rebuilds old daily tables and restores values from retained columns', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-tracker-compact-migration-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'summary.sqlite');
  const previous = new SummaryDatabase(path);
  const read = (db: SummaryDatabase) => ['provider', 'model'].map(by =>
    db.queryUsage({}, 'day', 'UTC', {}, by as 'provider' | 'model'));
  let expected: ReturnType<typeof read>;
  try {
    seed(previous, [{ ...turn(), model_usage: [
      { model: 'claude-sonnet-4-6', input_tokens: 100, output_tokens: 10, cache_write_input_tokens: null, cache_read_input_tokens: null },
    ] }]);
    expected = read(previous);
    previous.connection.exec(`ALTER TABLE usage_request_daily ADD COLUMN total_tokens INTEGER DEFAULT 999;
      ALTER TABLE usage_model_daily ADD COLUMN total_tokens INTEGER DEFAULT 999;
      ALTER TABLE usage_model_daily ADD COLUMN model TEXT DEFAULT 'obsolete';
      PRAGMA user_version=31;`);
  } finally { previous.close(); }

  const migrated = new SummaryDatabase(path);
  try {
    assert.deepEqual(read(migrated), expected);
    assert.equal(migrated.connection.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
    for (const table of ['usage_request_daily','usage_model_daily']) {
      assert.equal(migrated.connection.prepare(`PRAGMA table_info(${table})`).all().length, 41);
    }
  } finally { migrated.close(); }
});
