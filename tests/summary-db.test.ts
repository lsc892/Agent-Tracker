import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { test, type TestContext } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { SummaryDatabase, periodBounds, type FileMetadata, type TurnSummaryInput } from '../src/summary/db';
import { SCHEMA_SQL, SCHEMA_VERSION } from '../src/summary/db/schema';

// The pre-normalization schema stored the project label on every request.
const legacySchema = SCHEMA_SQL
  .replace(/CREATE TABLE IF NOT EXISTS projects[\s\S]*?WITHOUT ROWID;\s*CREATE TABLE IF NOT EXISTS sessions[\s\S]*?WITHOUT ROWID;/, '')
  .replace('project_key TEXT NOT NULL REFERENCES projects(project_key),', 'project_key TEXT NOT NULL,\n  project_name TEXT NOT NULL,')
  .replace(/,\s*FOREIGN KEY\(provider, session_id\) REFERENCES sessions\(provider, session_id\)/, '')
  .replace(/^  cache_(write|read)_input_tokens.*\r?\n/gm, '');

function database(t: TestContext): SummaryDatabase {
  const db = new SummaryDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function metadata(index = 1, session = 'session-a', sourceRoot = '/synthetic/claude'): FileMetadata {
  return {
    provider: 'claude', source_root: sourceRoot, path: `${sourceRoot}/${index}.jsonl`,
    session_id: session, size_bytes: 512, mtime_ms: 123456, dev: '10', inode: String(index), parser_version: 1,
  };
}

function turn(root = 'turn-a', override: Partial<TurnSummaryInput> = {}): TurnSummaryInput {
  return {
    provider: 'claude', project_key: '/synthetic/project-a', project_name: 'Project', session_id: 'session-a',
    root_turn_id: root, turn_index: 1, started_at_ms: Date.parse('2026-10-03T00:00:00Z'),
    completed_at_ms: Date.parse('2026-10-03T00:00:01Z'), duration_ms: 1000, duration_quality: 'exact',
    input_tokens: 100, output_tokens: 10, total_tokens: 110, status: 'completed',
    updated_at: '2026-10-03T00:00:02.000Z', ...override,
  };
}

function seed(db: SummaryDatabase, rows: TurnSummaryInput[] = [turn()]): number {
  const file = metadata();
  const manifest = db.observeFile(file, 'scan-initial');
  db.replaceSessions({
    sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...file, id: manifest.id }], summaries: rows,
  });
  return manifest.id;
}

test('tracking selection filters usage, pagination counts and diagnostics without discarding cached data', t => {
  const db = database(t);
  seed(db);
  const meta = {...metadata(), provider: 'codex' as const};
  const file = db.observeFile(meta, 'scan-codex');
  db.replaceSessions({sessions: [{provider: 'codex', session_id: 'session-a'}], files: [{...meta, id: file.id}], summaries: [turn('codex-turn', {provider: 'codex', quality_flags: '["derived"]'})]});
  for (const provider of ['claude', 'codex'] as const) {
    const filter = {providers: [provider]};
    assert.deepEqual(db.queryTurns(filter).map(row => row.provider), [provider]);
    assert.equal(db.queryTurnsCount(filter), 1);
    assert.deepEqual(db.queryUsage(filter).map(row => row.provider), [provider]);
    assert.equal(db.queryUsageCount(filter), 1);
    assert.equal(db.diagnostics(filter).counts.files, 1);
    assert.ok(db.diagnostics(filter).files.every(row => row.provider === provider));
    assert.ok(db.diagnostics(filter).summaries.every(row => row.provider === provider));
  }
  assert.deepEqual(db.queryTurns({providers: ['codex'], provider: 'claude'}), []);
  assert.deepEqual(db.queryUsage({providers: []}), []);
  assert.equal(db.queryUsageCount({providers: []}), 0);
  assert.equal(db.diagnostics({providers: []}).counts.files, 0);
  assert.equal(db.queryTurnsCount(), 2);
  db.clearData();
  assert.equal(db.queryTurnsCount(), 0);
  assert.equal(db.diagnostics().counts.files, 0);
  seed(db);
  assert.equal(db.queryTurnsCount(), 1, 'clear preserves a usable schema');
});

test('schema normalizes names and uses bounded disk staging cache', t => {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'agent-tracker-db-test-'));
  const dbPath = join(directory, 'summary.sqlite');
  t.after(() => {
    const target = resolve(directory);
    assert.ok(target.startsWith(`${parent}${sep}`));
    assert.ok(target.split(sep).at(-1)?.startsWith('agent-tracker-db-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  const first = new SummaryDatabase(dbPath);
  seed(first);
  assert.equal(first.connection.prepare('PRAGMA temp_store').get()?.temp_store, 1);
  assert.equal(first.connection.prepare('PRAGMA cache_size').get()?.cache_size, -4096);
  assert.equal(first.connection.prepare('PRAGMA temp.cache_size').get()?.cache_size, -4096);
  assert.equal(first.connection.prepare('PRAGMA journal_mode').get()?.journal_mode, 'wal');
  first.close();
  const second = new SummaryDatabase(dbPath);
  t.after(() => second.close());
  assert.deepEqual(second.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(row => row.name), ['manifest', 'projects', 'sessions', 'turn_summary']);
  assert.equal(second.queryUsage()[0].total_tokens, 110);
  second.close();
});

for (const version of [1,2]) test(`v${version} migration preserves summaries, manifest references and indexes while permitting failed requests`, t => {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent,'agent-tracker-db-migration-'));
  const dbPath = join(directory,'summary.sqlite');
  let db: SummaryDatabase | undefined;
  t.after(() => {
    db?.close();
    const target = resolve(directory);
    assert.ok(target.startsWith(`${parent}${sep}`));
    assert.ok(target.split(sep).at(-1)?.startsWith('agent-tracker-db-migration-'));
    rmSync(target,{recursive:true,force:true});
  });
  const legacy = new DatabaseSync(dbPath);
  let beforeFiles: unknown[];let beforeTurns: unknown[];
  try {
    legacy.exec(version===1 ? legacySchema.replace("'completed','in_progress','failed'","'completed','in_progress'") : legacySchema);
    legacy.exec(`PRAGMA user_version=${version}`);
    const file = {...metadata(),id:42,processing_status:'done',recorded_at:'2026-10-03T00:00:02.000Z'};
    const summary = {...turn(),id:99,diagnostic_file_id:42,quality_flags:'duration-approximate',diagnostic_offset:12,last_error:'parse-error'};
    for (const [table,row] of [['manifest',file],['turn_summary',summary]] as const) {
      const keys = Object.keys(row);
      legacy.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
    }
    beforeFiles = legacy.prepare('SELECT * FROM manifest').all();
    beforeTurns = legacy.prepare('SELECT * FROM turn_summary').all();
    if (version===1) assert.throws(()=>legacy.exec("UPDATE turn_summary SET status='failed'"),/CHECK constraint/);
  } finally {legacy.close();}
  db = new SummaryDatabase(dbPath);
  assert.deepEqual(db.connection.prepare('SELECT * FROM manifest').all(),beforeFiles);
  assert.deepEqual(db.queryTurns().map(row=>({...row})),beforeTurns.map(row=>({
    ...row as object,session_name:null,cache_write_input_tokens:null,cache_read_input_tokens:null,
  })));
  assert.equal(db.connection.prepare('PRAGMA user_version').get()?.user_version,SCHEMA_VERSION);
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(),[]);
  assert.deepEqual(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name),['manifest','projects','sessions','turn_summary']);
  assert.equal(db.connection.prepare("SELECT count(*) count FROM sqlite_master WHERE type='index' AND name LIKE 'idx_summary_%'").get()?.count,3);
  db.connection.exec("UPDATE turn_summary SET status='failed'");
  assert.equal(db.queryUsage()[0].total_tokens,110);assert.equal(db.queryUsage()[0].completed_turns,0);
  assert.equal(db.queryUsage()[0].avg_duration_ms,null);
  db.close();db = new SummaryDatabase(dbPath);
  assert.equal(db.queryTurns()[0].id,99);assert.equal(db.queryTurns()[0].status,'failed');
});

test('migration rechecks the version after another window finishes the transition', t => {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent,'agent-tracker-db-race-'));
  const dbPath = join(directory,'summary.sqlite');
  t.after(()=> {
    const target = resolve(directory);
    assert.ok(target.startsWith(`${parent}${sep}`) && target.split(sep).at(-1)?.startsWith('agent-tracker-db-race-'));
    rmSync(target,{recursive:true,force:true});
  });
  const legacy = new DatabaseSync(dbPath);
  legacy.exec(legacySchema);legacy.exec('PRAGMA user_version=2');
  const row = turn();
  const keys = Object.keys(row);
  legacy.prepare(`INSERT INTO turn_summary (${keys.join(',')}) VALUES (${keys.map(()=>'?').join(',')})`).run(...Object.values(row));
  legacy.close();
  class WaitingDatabase extends SummaryDatabase {
    override transaction<T>(action: ()=>T): T {
      // Simulate the other opener committing after our initial version read, before our lock is acquired.
      const other = new SummaryDatabase(dbPath);other.close();
      return super.transaction(action);
    }
  }
  const db = new WaitingDatabase(dbPath);
  try {
    assert.equal(db.queryTurns()[0].project_name,'Project');
    assert.equal(db.queryUsage()[0].total_tokens,110);
    assert.equal(db.connection.prepare('PRAGMA user_version').get()?.user_version,SCHEMA_VERSION);
  } finally { db.close(); }
});

test('discovery and failure preserve accepted metadata and previous successful values', t => {
  const db = database(t);
  const id = seed(db);
  const changed = { ...metadata(), size_bytes: 900, mtime_ms: 654321, session_id: 'session-b', parser_version: 2 };
  const observed = db.observeFile(changed, 'scan-next');
  assert.equal(observed.size_bytes, 512);
  assert.equal(observed.mtime_ms, 123456);
  assert.equal(observed.session_id, 'session-a');
  assert.equal(observed.last_seen_scan_id, 'scan-next');
  db.setManifestDiagnostic(id, 'error', 'parse: byte=128', 'parse-error', 128);
  const summary = db.queryTurns()[0];
  assert.equal(summary.total_tokens, 110);
  assert.equal(summary.updated_at, '2026-10-03T00:00:02.000Z');
  assert.equal(summary.diagnostic_file_id, id);
  assert.equal(summary.diagnostic_offset, 128);
  assert.equal(summary.last_error, 'parse-error');
  assert.equal(db.diagnostics().counts.stale_summaries, 1);
  assert.equal(db.queryUsage()[0].stale_turns, 1);
  seed(db);
  assert.equal(db.findManifest('claude', metadata().path)?.last_error, null);
  assert.equal(db.queryTurns()[0].last_error, null);
});

test('new files keep null normal session and zero metadata until committed', t => {
  const db = database(t);
  const file = db.observeFile(metadata(), 'scan');
  assert.equal(file.session_id, null);
  assert.equal(file.parser_version, 0);
  assert.equal(file.size_bytes, 0);
  assert.equal(file.dev, null);
  assert.equal(file.processing_status, 'processing');
});

test('replacement rolls back summary, metadata, and deletion on a streaming row failure', t => {
  const db = database(t);
  const id = seed(db);
  const previous = db.queryTurns();
  function* failingRows(): IterableIterator<TurnSummaryInput> {
    yield turn('replacement', { total_tokens: 220, input_tokens: 200, output_tokens: 20 });
    throw new Error('synthetic staging failure');
  }
  assert.throws(() => db.replaceSessions({
    sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...metadata(), size_bytes: 1024, id }], summaries: failingRows(), removedFileIds: [id],
  }), /synthetic staging failure/);
  assert.deepEqual(db.queryTurns(), previous);
  assert.equal(db.findManifest('claude', metadata().path)?.size_bytes, 512);
  function* failingDeletion(): IterableIterator<number> {
    yield id;
    throw new Error('synthetic deletion failure');
  }
  assert.throws(() => db.replaceSessions({
    sessions: [{ provider: 'claude', session_id: 'session-a' }], files: [], summaries: [],
    removedFileIds: failingDeletion(),
  }), /synthetic deletion failure/);
  assert.deepEqual(db.queryTurns(), previous);
  assert.ok(db.findManifest('claude', metadata().path));
});

test('a failed first replacement can retry after transaction-local staging schema rolls back', t => {
  const db = database(t);
  const file = metadata();
  const manifest = db.observeFile(file, 'scan');
  assert.throws(() => db.replaceSessions({
    sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...file, id: manifest.id }], summaries: [turn('invalid', { total_tokens: 0 })],
  }));
  assert.equal(db.findManifest('claude', file.path)?.session_id, null);
  db.replaceSessions({
    sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...file, id: manifest.id }], summaries: [turn()],
  });
  assert.equal(db.queryUsage()[0].total_tokens, 110);
});

test('session replacement keeps identically named sessions from the other provider untouched', t => {
  const db = database(t);
  seed(db);
  db.replaceSessions({
    sessions: [{ provider: 'codex', session_id: 'session-a' }, { provider: 'claude', session_id: 'session-b' }],
    files: [], summaries: [turn('codex-turn', { provider: 'codex' }), turn('other-session', { session_id: 'session-b' })],
  });
  const otherProvider = db.queryTurns({ provider: 'codex' });
  const otherSession = db.queryTurns({ provider: 'claude', sessionId: 'session-b' });
  db.replaceSessions({
    sessions: [{ provider: 'claude', session_id: 'session-a' }], files: [],
    summaries: [turn('replacement', { input_tokens: 200, total_tokens: 210 })],
  });
  assert.deepEqual(db.queryTurns({ provider: 'codex' }), otherProvider);
  assert.deepEqual(db.queryTurns({ provider: 'claude', sessionId: 'session-b' }), otherSession);
  assert.equal(db.queryTurns({ provider: 'claude', sessionId: 'session-a' })[0].total_tokens, 210);
});

test('session reassignment changes both sessions atomically and preserves manifest identity on move', t => {
  const db = database(t);
  const id = seed(db);
  const sessions = [{ provider: 'claude' as const, session_id: 'session-a' }, { provider: 'claude' as const, session_id: 'session-b' }];
  const moved = { ...metadata(), path: '/synthetic/archive/moved.jsonl', source_root: '/synthetic/archive', session_id: 'session-b', id };
  assert.throws(() => db.replaceSessions({
    sessions, files: [moved], summaries: [turn('new', { session_id: 'session-b', total_tokens: 999 })],
  }));
  assert.equal(db.findManifest('claude', metadata().path)?.id, id);
  assert.equal(db.queryTurns()[0].session_id, 'session-a');
  db.replaceSessions({ sessions, files: [moved], summaries: [turn('new', { session_id: 'session-b' })] });
  assert.equal(db.findManifest('claude', metadata().path), undefined);
  assert.equal(db.findManifest('claude', moved.path)?.id, id);
  assert.equal(db.queryTurns({ sessionId: 'session-a' }).length, 0);
  assert.equal(db.queryTurns({ sessionId: 'session-b' }).length, 1);
});

test('replacement rejects file reassignment and deletion outside its atomic session group', t => {
  const db = database(t);
  const id = seed(db);
  const before = db.queryTurns();
  const toSessionB = { ...metadata(), session_id: 'session-b', id };
  for (const included of ['session-a', 'session-b']) {
    assert.throws(() => db.replaceSessions({
      sessions: [{ provider: 'claude', session_id: included }], files: [toSessionB], summaries: [],
    }), /outside the replacement session group/);
    assert.deepEqual(db.queryTurns(), before);
    assert.equal(db.findManifest('claude', metadata().path)?.session_id, 'session-a');
  }
  assert.throws(() => db.replaceSessions({
    sessions: [{ provider: 'claude', session_id: 'session-b' }], files: [], summaries: [], removedFileIds: [id],
  }), /outside the replacement session group/);
  assert.ok(db.findManifest('claude', metadata().path));
  assert.deepEqual(db.queryTurns(), before);
  // An unprocessed file has no accepted session contribution to replace.
  const newFile = db.observeFile(metadata(2), 'scan');
  db.replaceSessions({ sessions: [], files: [], summaries: [], removedFileIds: [newFile.id] });
  assert.equal(db.findManifest('claude', metadata(2).path), undefined);
});

test('diagnostic cursors and offsets preserve stable ordering for both file and summary pages', t => {
  const db = database(t);
  seed(db, [turn('clean'), turn('flagged', { quality_flags: 'duration-approximate' }), turn('failed', { last_error: 'parse-error' })]);
  db.observeFile(metadata(2), 'scan');
  db.observeFile(metadata(3), 'scan');
  const first = db.diagnostics({ limit: 1 });
  assert.equal(first.files[0].id, 1);
  assert.equal(first.summaries[0].root_turn_id, 'flagged');
  assert.equal(first.nextFileId, 1);
  assert.equal(first.nextSummaryId, first.summaries[0].id);
  const second = db.diagnostics({ limit: 1, afterId: first.nextFileId!, afterSummaryId: first.nextSummaryId! });
  assert.equal(second.files[0].id, 2);
  assert.equal(second.summaries[0].root_turn_id, 'failed');
  const offset = db.diagnostics({ limit: 1, offset: 1 });
  assert.equal(offset.files[0].id, second.files[0].id);
  assert.equal(offset.summaries[0].id, second.summaries[0].id);
  const combined = db.diagnostics({ limit: 1, afterId: 1, afterSummaryId: first.summaries[0].id, offset: 1 });
  assert.equal(combined.files[0].id, 3);
  assert.equal(combined.summaries.length, 0);
  const end = db.diagnostics({ afterId: 3, afterSummaryId: second.summaries[0].id });
  assert.equal(end.nextFileId, null);
  assert.equal(end.nextSummaryId, null);
  assert.equal(end.counts.files, 3);
  assert.throws(() => db.diagnostics({ offset: -1 }), RangeError);
});

test('keyset discovery includes null visits, limits deleted roots, and streams beyond 256 files', t => {
  const db = database(t);
  for (let index = 1; index <= 300; index++) db.observeFile(metadata(index), index % 2 ? 'old' : 'current');
  db.observeFile(metadata(301, 'session-a', '/excluded'), 'old');
  db.connection.exec("UPDATE manifest SET last_seen_scan_id = NULL WHERE path = '/synthetic/claude/1.jsonl'");
  let count = 0;
  for (const row of db.unseenFiles('claude', '/synthetic/claude', 'current', 17)) {
    count++;
    db.markSeen(row.id, 'current');
  }
  assert.equal(count, 150);
  assert.equal([...db.unseenFiles('claude', '/synthetic/claude', 'current', 17)].length, 0);
  assert.equal([...db.unseenFiles('claude', '/excluded', 'current')].length, 1);
  function* files() {
    for (let index = 1; index <= 300; index++) {
      const file = metadata(index);
      yield { ...file, id: db.findManifest('claude', file.path)!.id };
    }
  }
  db.replaceSessions({ sessions: [{ provider: 'claude', session_id: 'session-a' }], files: files(), summaries: [] });
  count = 0;
  for (const row of db.sessionFiles('claude', 'session-a', 23)) {
    assert.equal(row.processing_status, 'done');
    count++;
  }
  assert.equal(count, 300);
  assert.equal(db.diagnostics({ limit: 25, offset: 300 }).files.length, 1);
});

test('ambiguous, zero, and missing identities never become a unique move match', t => {
  const db = database(t);
  const first = db.observeFile(metadata(), 'scan');
  const secondMetadata = { ...metadata(2), inode: '1' };
  const second = db.observeFile(secondMetadata, 'scan');
  db.replaceSessions({
    sessions: [{ provider: 'claude', session_id: 'session-a' }], summaries: [],
    files: [{ ...metadata(), id: first.id }, { ...secondMetadata, id: second.id }],
  });
  assert.equal(db.findIdentity('claude', '10', '1').length, 2);
  assert.deepEqual(db.findIdentity('claude', '0', '1'), []);
  assert.deepEqual(db.findIdentity('claude', '10', null), []);
});

test('aggregates include in-progress tokens but average completed turns and known durations only', t => {
  const db = database(t);
  seed(db, [
    turn('complete'),
    turn('missing-duration', { input_tokens: 200, total_tokens: 210, duration_ms: null, duration_quality: 'missing' }),
    turn('running', { input_tokens: 50, total_tokens: 60, status: 'in_progress', completed_at_ms: null, duration_ms: null, duration_quality: 'missing' }),
    turn('unknown-date', { project_key: '/synthetic/project-b', started_at_ms: null, duration_ms: 3000, duration_quality: 'derived' }),
  ]);
  const aggregate = db.queryUsage()[0];
  assert.equal(aggregate.total_tokens, 490);
  assert.equal(aggregate.turn_count, 4);
  assert.equal(aggregate.completed_turns, 3);
  assert.equal(aggregate.avg_tokens_per_turn, 430 / 3);
  assert.equal(aggregate.avg_duration_ms, 2000);
  assert.equal(aggregate.turns_with_duration, 2);
  assert.equal(aggregate.missing_duration_turns, 1);
  assert.equal(aggregate.unknown_time_turns, 1);
  const projects = db.queryUsage({}, 'project');
  assert.equal(projects.length, 2);
  assert.equal(projects[0].project_name, projects[1].project_name);
  assert.notEqual(projects[0].project_key, projects[1].project_key);
  assert.equal(db.queryUsageCount({}, 'project'), 2);
  assert.equal(db.queryTurnsCount(), 4);
  const page = db.queryTurns({}, { limit: 2 });
  assert.equal(page.length, 2);
  assert.equal(db.queryTurns({}, { afterId: page[1].id, limit: 2 }).length, 2);
  assert.equal(db.queryTurns({}, { limit: 2, offset: 2 }).length, 2);
});

test('configured timezone changes day and month groups without rewriting stored turns', t => {
  const db = database(t);
  seed(db, [
    turn('before-local-month', { started_at_ms: Date.parse('2026-09-30T14:59:59Z') }),
    turn('after-local-month', { started_at_ms: Date.parse('2026-09-30T15:00:00Z') }),
    turn('unknown', { started_at_ms: null }),
  ]);
  const before = db.queryTurns();
  const seoul = db.queryUsage({}, 'day', 'Asia/Seoul');
  assert.deepEqual(seoul.map(row => row.period), [null, '2026-09-30', '2026-10-01']);
  assert.deepEqual(db.queryUsage({}, 'month', 'Asia/Seoul').map(row => row.period), [null, '2026-09', '2026-10']);
  assert.deepEqual(db.queryUsage({}, 'day', 'UTC').map(row => row.period), [null, '2026-09-30']);
  assert.equal(db.queryUsageCount({}, 'day', 'Asia/Seoul'), 3);
  assert.deepEqual(db.queryTurns(), before);
  const range = periodBounds('2026-10', 'Asia/Seoul');
  assert.equal(range.fromMs, Date.parse('2026-09-30T15:00:00Z'));
  assert.equal(db.queryTurns(range).length, 1);
  assert.equal(db.queryTurns({ ...range, unknownTime: 'include' }).length, 2);
  assert.equal(db.queryTurns({ ...range, unknownTime: 'only' }).length, 1);
  assert.throws(() => db.queryUsage({}, 'day', 'Invalid/Timezone'), RangeError);
});

test('date-filtered calendar pages retain a separately counted unknown-time group', t => {
  const db = database(t);
  seed(db, [
    turn('inside'),
    turn('outside', { started_at_ms: Date.parse('2026-09-01T00:00:00Z') }),
    turn('undated', { started_at_ms: null }),
    turn('other-project-undated', { project_key: '/other-project', started_at_ms: null }),
  ]);
  const filter = { ...periodBounds('2026-10', 'Asia/Seoul'), projectKey: '/synthetic/project-a' };
  for (const grouping of ['day', 'month'] as const) {
    const rows = db.queryUsage(filter, grouping, 'Asia/Seoul');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].period, null);
    assert.equal(rows[0].unknown_time_turns, 1);
    assert.equal(rows[0].total_tokens, 110);
    assert.equal(rows[1].turn_count, 1);
    assert.equal(db.queryUsageCount(filter, grouping, 'Asia/Seoul'), 2);
    assert.equal(db.queryUsage(filter, grouping, 'Asia/Seoul', { limit: 1, offset: 1 })[0].period, rows[1].period);
    assert.equal(db.queryUsageCount({ ...filter, unknownTime: 'exclude' }, grouping, 'Asia/Seoul'), 1);
    assert.equal(db.queryUsage({ ...filter, unknownTime: 'only' }, grouping, 'Asia/Seoul')[0].period, null);
  }
  // Other grouping modes and raw turns still respect their ordinary range filter.
  assert.equal(db.queryUsage(filter, 'project')[0].turn_count, 1);
  assert.equal(db.queryTurnsCount(filter), 1);
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
