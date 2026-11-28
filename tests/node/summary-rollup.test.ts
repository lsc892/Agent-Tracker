// 일별 집계의 조회 범위와 저장·교체 일관성을 검증한다.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SummaryDatabase, periodBounds, type FileMetadata, type ModelUsageInput, type SummaryFilter, type TurnSummaryInput, type UsageGrouping, type UsageRow } from '../../src/summary/db';

const epoch = (local: string): number => Date.parse(`${local}+09:00`);
const timezone = 'Asia/Seoul';
const rollupTables = ['usage_request_daily', 'usage_model_daily', 'usage_rollup_meta'];

function turn(id: string, local: string | null, tokens: number, overrides: Partial<TurnSummaryInput> = {}): TurnSummaryInput {
  const start = local === null ? null : epoch(local);
  return {
    provider: 'claude', project_key: '/rollup/project', project_name: 'Project%_',
    session_id: 'session-a', session_name: 'Session%_', root_turn_id: id,
    started_at_ms: start, completed_at_ms: start === null ? null : start + 1000,
    input_tokens: tokens, output_tokens: 0, total_tokens: tokens,
    cache_write_input_tokens: 0, cache_read_input_tokens: 0,
    duration_ms: 1000, duration_quality: 'exact', status: 'completed',
    updated_at: '2026-10-15T00:00:00.000Z', ...overrides,
  };
}

function model(name: string, tokens: number): ModelUsageInput {
  return { model: name, input_tokens: tokens, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0 };
}

function replace(db: SummaryDatabase, rows: TurnSummaryInput[], sessions = [...new Map(rows.map(row =>
  [`${row.provider}:${row.session_id}`, { provider: row.provider, session_id: row.session_id }])).values()]): void {
  db.replaceMemory({sessions, files: [], summaries: rows });
}

function fixture(t: TestContext, rows: TurnSummaryInput[] = []): SummaryDatabase {
  const db = new SummaryDatabase({ databasePath: ':memory:', timezone });
  t.after(() => db.close());
  replace(db, rows);
  return db;
}

function readPage(db: SummaryDatabase, filter: SummaryFilter = {}, group: UsageGrouping = 'total',
  timeZone = timezone, by: 'provider' | 'model' = 'provider'): UsageRow[] {
  const rows = db.queryUsage(filter, group, timeZone, {}, by);
  assert.equal(db.queryUsageCount(filter, group, timeZone, by), rows.length);
  return rows;
}

function expect(row: UsageRow | undefined, expected: Partial<UsageRow>): void {
  assert.ok(row);
  for (const key of Object.keys(expected) as (keyof UsageRow)[]) assert.equal(row[key], expected[key], key);
}

function snapshot(db: SummaryDatabase, tables: string[]): unknown[] {
  return tables.map(table => db.connection.prepare(`SELECT * FROM ${table}`).all());
}

function metadata(): FileMetadata {
  return { provider: 'claude', source_root: '/rollup', path: '/rollup/session.jsonl', session_id: 'session-a',
    size_bytes: 512, mtime_ms: 123456, dev: '1', inode: '2', parser_version: 1 };
}

test('public rollups apply name/provider filters, the original session start outside the query range', t => {
  const earliest = epoch('2026-09-30T10:00:00');
  const db = fixture(t, [
    turn('earlier', '2026-09-30T10:00:00', 100),
    turn('selected', '2026-10-02T12:00:00', 20),
    turn('other-session', '2026-10-02T12:00:00', 50, { session_id: 'session-b', session_name: 'Other' }),
    turn('other-provider', '2026-09-29T10:00:00', 700, { provider: 'codex' }),
    turn('other-project', '2026-10-02T12:00:00', 1000, {
      project_key: '/rollup/other', project_name: 'Other', session_id: 'session-c', session_name: 'Other',
    }),
    turn('unknown', null, 1),
  ]);
  const filter: SummaryFilter = {
    providers: ['claude'], projectKey: '/rollup/project', projectName: '%_', sessionName: '%_',
    fromMs: epoch('2026-10-02T00:00:00'), toMs: epoch('2026-10-03T00:00:00'),
  };
  const rows = readPage(db, filter, 'session');
  assert.equal(rows.length, 1);
  expect(rows[0], { provider: 'claude', project_key: '/rollup/project', project_name: 'Project%_',
    session_id: 'session-a', session_name: 'Session%_', session_started_at_ms: earliest,
    total_tokens: 20, turn_count: 1, avg_tokens_per_turn: 20 });
  assert.deepEqual(readPage(db, { providers: [] }), []);
  assert.deepEqual(readPage(db, { providers: ['codex'], provider: 'claude' }), []);
});

test('empty first read, append, historical correction, project move, deletion and clear maintain rollups', t => {
  const db = fixture(t);
  assert.deepEqual(readPage(db), []);
  assert.deepEqual(readPage(db, {}, 'total', 'Asia/Seoul', 'model'), []);
  const original = turn('first', '2026-10-01T12:00:00', 100, { model_usage: [model('A', 100)] });
  const other = turn('other', '2026-10-02T12:00:00', 70, { session_id: 'session-b', model_usage: [model('B', 70)] });
  replace(db, [original, other]);
  const verify = (): void => {
    for (const by of ['provider', 'model'] as const) {
      for (const group of ['total', 'project', 'session', 'day', 'month'] as const) readPage(db, {}, group, 'Asia/Seoul', by);
    }
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  };
  verify();
  const appended = turn('second', '2026-10-03T12:00:00', 200, { model_usage: [model('C', 200)] });
  replace(db, [original, appended]);
  verify();
  expect(readPage(db)[0], { total_tokens: 370, turn_count: 3 });
  const corrected = turn('first', '2026-09-01T12:00:00', 30, { model_usage: [model('D', 30)] });
  replace(db, [corrected, appended]);
  verify();
  assert.ok(!db.queryUsage({}, 'day', 'Asia/Seoul').some(row => row.period === '2026-10-01'));
  const moved = [corrected, appended].map(row => ({ ...row, project_key: '/rollup/moved', project_name: 'Moved', session_name: 'Renamed' }));
  replace(db, moved);
  verify();
  assert.equal(readPage(db, { projectKey: '/rollup/project' }, 'project')[0].total_tokens, 70);
  expect(readPage(db, { projectKey: '/rollup/moved' }, 'session')[0], { total_tokens: 230, session_name: 'Renamed' });
  replace(db, [], [{ provider: 'claude', session_id: 'session-a' }]);
  verify();
  expect(readPage(db)[0], { total_tokens: 70, turn_count: 1 });
  assert.equal(db.connection.prepare("SELECT COUNT(*) count FROM usage_request_daily WHERE session_id='session-a'").get()?.count, 0);
  assert.equal(db.connection.prepare("SELECT COUNT(*) count FROM usage_model_daily WHERE session_id='session-a'").get()?.count, 0);
  db.clearData();
  assert.deepEqual(readPage(db), []);
  assert.equal(db.queryTurnsCount(), 0);
  replace(db, [original]);
  verify();
  expect(readPage(db)[0], { total_tokens: 100, turn_count: 1 });
});

test('source_file diagnostic updates refresh stale counts and successful replacement clears stale state', t => {
  const db = fixture(t);
  const file = metadata();
  const source_file = db.observeFile(file);
  const rows = [turn('one', '2026-10-01T12:00:00', 100, { model_usage: [model('A', 100)] }),
    turn('two', '2026-10-02T12:00:00', 200, { model_usage: [model('B', 200)] })];
  const install = (): void => { db.replaceMemory({sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...file, id: source_file.id }], summaries: rows }); };
  install();
  expect(readPage(db)[0], { total_tokens: 300 });
  assert.equal(db.diagnostics().counts.stale_summaries, 0);
  for (const status of ['error', 'interrupted'] as const) {
    const beforeDiagnostic = snapshot(db, rollupTables);
    db.setSourceDiagnostic(source_file.id, status, 'failed-line', null, 17);
    assert.deepEqual(snapshot(db, rollupTables), beforeDiagnostic, 'Diagnostic-only updates do not rebuild usage aggregates');
    expect(readPage(db)[0], { total_tokens: 300 });
    assert.equal(db.diagnostics().counts.stale_summaries, 2);
    for (const by of ['provider', 'model'] as const) readPage(db, {}, 'day', 'Asia/Seoul', by);
    install();
    expect(readPage(db)[0], { total_tokens: 300 });
    assert.equal(db.diagnostics().counts.stale_summaries, 0);
  }
  const before = snapshot(db, rollupTables);
  db.observeFile(file);
  db.setSourceDiagnostic(source_file.id, 'done', 'committed', null);
  assert.deepEqual(snapshot(db, rollupTables), before, 'Presence and non-error file diagnostics do not alter aggregate state');
});


test('a failed model write rolls back provider totals, source metadata and session names', t => {
  const original = turn('first', '2026-10-01T12:00:00', 100, { model_usage: [model('A', 100)] });
  const db = fixture(t, [original]);
  const file = metadata();
  const source = db.observeFile(file);
  const install = (row: TurnSummaryInput, mtime: number): void => {
    db.replaceMemory({ sessions: [{ provider: 'claude', session_id: 'session-a' }], summaries: [row],
      files: [{ ...file, id: source.id, mtime_ms: mtime }] });
  };
  install(original, file.mtime_ms);
  const before = snapshot(db, [...rollupTables, 'sessions', 'source_file']);
  db.connection.exec(`CREATE TEMP TRIGGER reject_model BEFORE INSERT ON main.usage_model_daily
    WHEN NEW.model_key = 'VB' BEGIN SELECT RAISE(ABORT, 'reject model'); END;`);
  const changed = turn('first', '2026-10-01T12:00:00', 150, { model_usage: [model('B', 150)], session_name: 'Changed' });
  assert.throws(() => install(changed, file.mtime_ms + 1), /reject model/);
  assert.deepEqual(snapshot(db, [...rollupTables, 'sessions', 'source_file']), before);
  db.connection.exec('DROP TRIGGER reject_model');
  install(changed, file.mtime_ms + 1);
  assert.equal(readPage(db)[0].total_tokens, 150);
  assert.equal(readPage(db, {}, 'session')[0].session_name, 'Changed');
  assert.deepEqual(readPage(db, {}, 'total', timezone, 'model').map(row => row.model), ['B']);
});

test('a WAL reader sees a consistent set of daily rows across a concurrent replacement', t => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-tracker-rollup-wal-'));
  const options = { databasePath: join(directory, 'summary.sqlite'), timezone };
  const writer = new SummaryDatabase(options);
  const reader = new SummaryDatabase(options);
  t.after(() => { reader.close(); writer.close(); rmSync(directory, {recursive:true,force:true}); });
  const original = turn('first', '2026-10-01T12:00:00', 100);
  replace(writer, [original]);
  reader.connection.exec('BEGIN');
  try {
    assert.equal(readPage(reader)[0].total_tokens, 100);
    replace(writer, [{ ...original, input_tokens: 250, total_tokens: 250 }]);
    assert.equal(readPage(reader)[0].total_tokens, 100);
  } finally { reader.connection.exec('ROLLBACK'); }
  assert.equal(readPage(reader)[0].total_tokens, 250);
});

test('stored local dates follow DST boundaries', t => {
  const zone = 'America/New_York';
  const db = new SummaryDatabase({ databasePath: ':memory:', timezone: zone });
  t.after(() => db.close());
  for (const [day, hours] of [['2026-03-08',23], ['2026-11-01',25]] as const) {
    const {fromMs,toMs} = periodBounds(day, zone);
    assert.equal(toMs - fromMs, hours * 3_600_000);
    replace(db, [
      turn('before', null, 10, {started_at_ms: fromMs - 1}),
      turn('first', null, 20, {started_at_ms: fromMs}),
      turn('last', null, 30, {started_at_ms: toMs - 1}),
      turn('after', null, 40, {started_at_ms: toMs}),
    ]);
    const rows = readPage(db, {fromMs,toMs}, 'day', zone);
    assert.deepEqual(rows.map(row => [row.period,row.total_tokens,row.turn_count]), [[day,50,2]]);
  }
});
