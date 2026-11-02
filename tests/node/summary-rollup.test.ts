// 공개 DB API의 롤업 조회·갱신·시간대·마이그레이션 일관성을 검증한다.
import { queryChart } from '../fixtures/usage-chart';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  SummaryDatabase, periodBounds, type ChartMetric, type FileMetadata, type ModelUsageInput,
  type SummaryFilter, type TurnSummaryInput, type UsageGrouping, type UsageRow,
} from '../../src/summary/db';
import { buildUsageCountQuery, buildUsageQuery, type UsageBasis } from '../../src/summary/db/queries';
import { SCHEMA_VERSION } from '../../src/summary/db/schema';
import { applySessionNames } from '../../src/summary/names';
import type { SqliteSession } from '../../src/summary/db/connection';
import { SummaryReader } from '../../src/summary/db/reader';
import { UsageRollupStore } from '../../src/summary/db/rollups';
import { buildRollupUsageQueries } from '../../src/summary/db/rollup-queries';

const epoch = (local: string): number => Date.parse(`${local}+09:00`);
const rollupTables = ['usage_request_daily', 'usage_model_daily', 'usage_rollup_meta'];
const factTables = ['manifest', 'projects', 'sessions', 'turn_summary', 'turn_model_usage',
  'turn_capability_usage', 'turn_costs', 'session_billing'];

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
  db.replaceSessions({ sessions, files: [], summaries: rows });
}

function fixture(t: TestContext, rows: TurnSummaryInput[] = []): SummaryDatabase {
  const db = new SummaryDatabase(':memory:');
  t.after(() => db.close());
  if (rows.length) replace(db, rows);
  return db;
}

function disk(t: TestContext): { path: string; open(): SummaryDatabase } {
  const parent = realpathSync(tmpdir());
  const directory = mkdtempSync(join(parent, 'agent-tracker-rollup-test-'));
  const path = join(directory, 'summary.sqlite');
  const databases: SummaryDatabase[] = [];
  t.after(() => {
    for (const db of databases) db.close();
    const target = resolve(directory);
    assert.ok(target.startsWith(`${parent}${sep}`));
    assert.ok(target.split(sep).at(-1)?.startsWith('agent-tracker-rollup-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { path, open: () => {
    const db = new SummaryDatabase(path);
    databases.push(db);
    return db;
  } };
}

function oracle(db: SummaryDatabase, filter: SummaryFilter = {}, grouping: UsageGrouping = 'total',
  timezone = 'Asia/Seoul', by: UsageBasis = 'provider',
  page: { limit?: number; offset?: number; sortBy?: ChartMetric } = {}): UsageRow[] {
  const query = buildUsageQuery(filter, grouping, timezone, by, page.sortBy);
  const expected = db.connection.prepare(query.sql).all(...query.values, page.limit ?? 100, page.offset ?? 0);
  const actual = db.queryUsage(filter, grouping, timezone, page, by);
  assert.deepEqual(actual, expected, `${grouping}/${by}/${timezone}/${JSON.stringify(filter)}: every public output field`);
  const count = buildUsageCountQuery(filter, grouping, timezone, by);
  assert.equal(db.queryUsageCount(filter, grouping, timezone, by),
    db.connection.prepare(count.sql).get(...count.values)?.count, 'Public COUNT agrees with raw SQL');
  return actual;
}

function expect(row: UsageRow | undefined, expected: Partial<UsageRow>): void {
  assert.ok(row, 'Expected an aggregate row');
  for (const key of Object.keys(expected) as (keyof UsageRow)[]) assert.equal(row[key], expected[key], key);
}

function snapshot(db: SummaryDatabase, tables = [...factTables, ...rollupTables]): unknown[] {
  return tables.map(table => ({ table, rows: db.connection.prepare(`SELECT * FROM ${table} ORDER BY 1,2`).all() }));
}

test('public usage rolls completed turn sums and counts across days without averaging daily averages', t => {
  const db = fixture(t, [
    turn('day-one', '2026-10-01T12:00:00', 100),
    turn('day-two-a', '2026-10-02T10:00:00', 30),
    turn('day-two-b', '2026-10-02T11:00:00', 50),
    turn('day-two-c', '2026-10-02T12:00:00', 120),
    turn('running', '2026-10-02T13:00:00', 500, { status: 'in_progress' }),
    turn('failed', '2026-10-02T14:00:00', 700, { status: 'failed' }),
  ]);
  const daily = oracle(db, {}, 'day');
  expect(daily[0], { period: '2026-10-01', total_tokens: 100, turn_count: 1, avg_tokens_per_turn: 100 });
  expect(daily[1], { period: '2026-10-02', total_tokens: 1400, turn_count: 5, completed_turns: 3, avg_tokens_per_turn: 200 / 3 });
  for (const grouping of ['total', 'project', 'session', 'month'] as const) {
    expect(oracle(db, {}, grouping)[0], {
      total_tokens: 1500, input_tokens: 1500, output_tokens: 0, turn_count: 6,
      completed_turns: 4, recorded_turns: 6, recorded_completed_turns: 4,
      avg_tokens_per_turn: 75, avg_input_tokens: 75, avg_output_tokens: 0,
    });
  }
  const chart = queryChart(db, {}, 'day', 'Asia/Seoul', 'averageTokens');
  assert.deepEqual(chart.rows, daily, 'Charts use the same product aggregate route');
  assert.equal(chart.total, 2);
});

test('public model rollups preserve NULL, unknown model, known zero and multimodel turn counts', t => {
  const db = fixture(t, [
    turn('unrecorded', '2026-10-01T10:00:00', 0),
    turn('known-zero', '2026-10-01T11:00:00', 0, { model_usage: [model('A', 0)] }),
    turn('unknown-positive', '2026-10-02T10:00:00', 40, { model_usage: [model('', 40)] }),
    turn('multi-model', '2026-10-02T11:00:00', 100, { model_usage: [model('A', 60), model('B', 40)] }),
    turn('unknown-zero', '2026-10-02T12:00:00', 0, { model_usage: [model('', 0)] }),
  ]);
  for (const excludeEmptyUsage of [false, true]) {
    const filter = { excludeEmptyUsage };
    expect(oracle(db, filter)[0], {
      total_tokens: 140, turn_count: 5, completed_turns: 5, recorded_turns: 3,
      recorded_completed_turns: 3, avg_tokens_per_turn: excludeEmptyUsage ? 140 / 3 : 28,
    });
    const models = oracle(db, filter, 'total', 'Asia/Seoul', 'model');
    assert.equal(models.length, 4);
    expect(models.find(row => row.model === null), {
      total_tokens: 0, turn_count: 2, recorded_turns: 0, avg_tokens_per_turn: excludeEmptyUsage ? null : 0,
    });
    expect(models.find(row => row.model === ''), { total_tokens: 40, turn_count: 1, recorded_turns: 1, avg_tokens_per_turn: 40 });
    expect(models.find(row => row.model === 'A'), { total_tokens: 60, turn_count: 2, recorded_turns: 2, avg_tokens_per_turn: 30 });
    expect(models.find(row => row.model === 'B'), { total_tokens: 40, turn_count: 1, recorded_turns: 1, avg_tokens_per_turn: 40 });
    assert.equal(models.reduce((sum, row) => sum + row.turn_count, 0), 6, 'Model turn counts cannot be summed into provider turn counts');
    for (const grouping of ['project', 'session', 'day', 'month'] as const) oracle(db, filter, grouping, 'Asia/Seoul', 'model');
  }
});

test('public averages preserve cache unknowns and completed duration samples', t => {
  const db = fixture(t, [
    turn('known', '2026-10-01T10:00:00', 100, { cache_write_input_tokens: 10, cache_read_input_tokens: 20, duration_ms: 100 }),
    turn('missing-write-duration', '2026-10-02T10:00:00', 300, {
      cache_write_input_tokens: null, cache_read_input_tokens: 30, duration_ms: null, duration_quality: 'derived',
    }),
    turn('unrecorded', '2026-10-02T11:00:00', 0, {
      cache_write_input_tokens: null, cache_read_input_tokens: null, duration_ms: null, duration_quality: 'missing',
    }),
    turn('running', '2026-10-02T12:00:00', 500, {
      status: 'in_progress', cache_write_input_tokens: 5, cache_read_input_tokens: null, duration_quality: 'approximate',
    }),
  ]);
  for (const excludeEmptyUsage of [false, true]) {
    expect(oracle(db, { excludeEmptyUsage })[0], {
      total_tokens: 900, turn_count: 4, completed_turns: 3, recorded_completed_turns: 2,
      cache_write_input_tokens: null, cache_read_input_tokens: null,
      avg_tokens_per_turn: excludeEmptyUsage ? 200 : 400 / 3,
      avg_cache_write_input_tokens: null, avg_cache_read_input_tokens: excludeEmptyUsage ? 25 : null,
      avg_duration_ms: 100, turns_with_duration: 1, exact_duration_turns: 1,
      derived_duration_turns: 1, approximate_duration_turns: 0, missing_duration_turns: excludeEmptyUsage ? 1 : 2,
    });
    oracle(db, { excludeEmptyUsage }, 'total', 'Asia/Seoul', 'model');
  }
});

test('public daily range decomposition counts exact partial boundaries once and keeps unknown-time policy', t => {
  const db = fixture(t, [
    turn('before', '2026-10-01T11:59:59', 1),
    turn('lower', '2026-10-01T12:00:00', 10),
    turn('whole-day', '2026-10-02T00:00:00', 20),
    turn('upper-inside', '2026-10-03T11:59:59', 30),
    turn('upper-excluded', '2026-10-03T12:00:00', 100),
    turn('unknown', null, 40),
  ]);
  const range = { fromMs: epoch('2026-10-01T12:00:00'), toMs: epoch('2026-10-03T12:00:00') };
  expect(oracle(db, range)[0], { total_tokens: 60, turn_count: 3, avg_tokens_per_turn: 20, unknown_time_turns: 0 });
  expect(oracle(db, { ...range, unknownTime: 'include' })[0], { total_tokens: 100, turn_count: 4, unknown_time_turns: 1 });
  expect(oracle(db, { ...range, unknownTime: 'only' })[0], { total_tokens: 40, turn_count: 1, unknown_time_turns: 1 });
  assert.deepEqual(oracle(db, range, 'day').map(row => [row.period, row.total_tokens]), [
    ['2026-10-01', 10], ['2026-10-02', 20], ['2026-10-03', 30], [null, 40],
  ]);
  expect(oracle(db, { fromMs: range.fromMs, toMs: epoch('2026-10-01T13:00:00') })[0], { total_tokens: 10, turn_count: 1 });
  expect(oracle(db, { fromMs: epoch('2026-10-02T00:00:00'), toMs: epoch('2026-10-03T00:00:00') })[0], { total_tokens: 20, turn_count: 1 });
  assert.deepEqual(oracle(db, { fromMs: range.toMs, toMs: range.fromMs }), []);
  assert.deepEqual(oracle(db, { fromMs: range.fromMs, toMs: range.fromMs }), []);
  for (const unknownTime of ['only', 'include', 'exclude'] as const) {
    for (const grouping of ['total', 'day', 'month'] as const) {
      oracle(db, { ...range, unknownTime }, grouping, 'Asia/Seoul', 'model');
    }
  }
  assert.throws(() => db.queryUsage({ fromMs: 1.5 }), RangeError);
  assert.throws(() => db.queryUsageCount({ toMs: Number.NaN }), RangeError);
});

test('public rollups apply name/provider filters, original session start, metric order and pagination', t => {
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
  const rows = oracle(db, filter, 'session');
  assert.equal(rows.length, 1);
  expect(rows[0], { provider: 'claude', project_key: '/rollup/project', project_name: 'Project%_',
    session_id: 'session-a', session_name: 'Session%_', session_started_at_ms: earliest,
    total_tokens: 20, turn_count: 1, avg_tokens_per_turn: 20 });
  for (const sortBy of ['tokens', 'requests', 'averageTokens', 'averageDuration'] as const) {
    for (const by of ['provider', 'model'] as const) {
      oracle(db, {}, 'day', 'Asia/Seoul', by, { limit: 2, offset: 1, sortBy });
      oracle(db, {}, 'session', 'Asia/Seoul', by, { limit: 2, offset: 1, sortBy });
    }
  }
  assert.deepEqual(oracle(db, { providers: [] }), []);
  assert.deepEqual(oracle(db, { providers: ['codex'], provider: 'claude' }), []);
});

test('public product aggregate path reads stored rollups while detail and costs retain facts', t => {
  const db = fixture(t, [turn('a', '2026-10-01T12:00:00', 100, { model_usage: [model('A', 100)] }),
    turn('b', '2026-10-01T13:00:00', 200, { model_usage: [model('A', 200)] })]);
  const provider = oracle(db);
  const models = oracle(db, {}, 'total', 'Asia/Seoul', 'model');
  assert.equal(db.connection.prepare('SELECT COUNT(*) count FROM usage_request_daily').get()?.count, 1);
  assert.equal(db.connection.prepare('SELECT COUNT(*) count FROM usage_model_daily').get()?.count, 1);
  // Direct SQL below is isolated fault injection: it deliberately bypasses product ingestion hooks.
  db.connection.exec('SAVEPOINT route_probe; DELETE FROM turn_summary;');
  try {
    assert.equal(db.queryTurnsCount(), 0);
    assert.deepEqual(db.queryUsage({}, 'total', 'Asia/Seoul'), provider);
    assert.deepEqual(db.queryUsage({}, 'total', 'Asia/Seoul', {}, 'model'), models);
    assert.equal(db.queryUsageCount({}, 'total', 'Asia/Seoul'), 1);
    assert.deepEqual(db.queryUsage({ includeCosts: true }, 'total', 'Asia/Seoul'), [], 'Costs explicitly use the raw fallback');
  } finally {
    db.connection.exec('ROLLBACK TO route_probe; RELEASE route_probe;');
  }
  oracle(db);
});

test('timezone rebuilds keep one active materialization and preserve UTC, Seoul and DST 23/25-hour days', t => {
  const cases = [
    { timezone: 'America/New_York', day: '2026-03-08', hours: 23 },
    { timezone: 'America/New_York', day: '2026-11-01', hours: 25 },
    { timezone: 'Asia/Seoul', day: '2026-10-01', hours: 24 },
    { timezone: 'UTC', day: '2026-10-01', hours: 24 },
  ];
  const rows: TurnSummaryInput[] = [];
  for (const [index, scenario] of cases.entries()) {
    const bounds = periodBounds(scenario.day, scenario.timezone);
    assert.equal(bounds.toMs - bounds.fromMs, scenario.hours * 3_600_000);
    for (const [suffix, start, tokens] of [
      ['before', bounds.fromMs - 1, 100], ['start', bounds.fromMs, 10],
      ['end-inside', bounds.toMs - 1, 20], ['end-excluded', bounds.toMs, 1000],
    ] as const) rows.push(turn(`${index}-${suffix}`, null, tokens, {
      session_id: `session-${index}`, started_at_ms: start, completed_at_ms: start + 1000,
      model_usage: [model('A', tokens)],
    }));
  }
  const db = fixture(t, rows);
  for (const [index, scenario] of cases.entries()) {
    const bounds = periodBounds(scenario.day, scenario.timezone);
    const filter = { sessionId: `session-${index}`, fromMs: bounds.fromMs, toMs: bounds.toMs };
    for (const by of ['provider', 'model'] as const) {
      expect(oracle(db, filter, 'day', scenario.timezone, by)[0], {
        period: scenario.day, total_tokens: 30, turn_count: 2, avg_tokens_per_turn: 15,
      });
      oracle(db, { ...filter, fromMs: bounds.fromMs + 1 }, 'day', scenario.timezone, by);
    }
    const meta = db.connection.prepare('SELECT * FROM usage_rollup_meta').all();
    assert.equal(meta.length, 1, 'Changing timezone replaces, rather than accumulates, materializations');
    assert.equal(meta[0].timezone, scenario.timezone);
    assert.ok(Number(db.connection.prepare('SELECT COUNT(*) count FROM usage_request_daily').get()?.count) <= rows.length);
  }
  oracle(db, {}, 'day', 'Asia/Seoul');
  const first = snapshot(db, rollupTables);
  oracle(db, {}, 'day', 'UTC');
  oracle(db, {}, 'day', 'Asia/Seoul');
  assert.deepEqual(snapshot(db, rollupTables), first, 'Returning to a timezone reconstructs the same bounded state');
});

test('empty first read, append, historical correction, project move, deletion and clear maintain rollups', t => {
  const db = fixture(t);
  assert.deepEqual(oracle(db), []);
  assert.deepEqual(oracle(db, {}, 'total', 'Asia/Seoul', 'model'), []);
  const original = turn('first', '2026-10-01T12:00:00', 100, { model_usage: [model('A', 100)] });
  const other = turn('other', '2026-10-02T12:00:00', 70, { session_id: 'session-b', model_usage: [model('B', 70)] });
  replace(db, [original, other]);
  const verify = (): void => {
    for (const by of ['provider', 'model'] as const) {
      for (const group of ['total', 'project', 'session', 'day', 'month'] as const) oracle(db, {}, group, 'Asia/Seoul', by);
    }
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  };
  verify();
  const appended = turn('second', '2026-10-03T12:00:00', 200, { model_usage: [model('C', 200)] });
  replace(db, [original, appended]);
  verify();
  expect(oracle(db)[0], { total_tokens: 370, turn_count: 3 });
  const corrected = turn('first', '2026-09-01T12:00:00', 30, { model_usage: [model('D', 30)] });
  replace(db, [corrected, appended]);
  verify();
  assert.ok(!db.queryUsage({}, 'day', 'Asia/Seoul').some(row => row.period === '2026-10-01'));
  const moved = [corrected, appended].map(row => ({ ...row, project_key: '/rollup/moved', project_name: 'Moved', session_name: 'Renamed' }));
  replace(db, moved);
  verify();
  assert.equal(oracle(db, { projectKey: '/rollup/project' }, 'project')[0].total_tokens, 70);
  expect(oracle(db, { projectKey: '/rollup/moved' }, 'session')[0], { total_tokens: 230, session_name: 'Renamed' });
  replace(db, [], [{ provider: 'claude', session_id: 'session-a' }]);
  verify();
  expect(oracle(db)[0], { total_tokens: 70, turn_count: 1 });
  assert.equal(db.connection.prepare("SELECT COUNT(*) count FROM usage_request_daily WHERE session_id='session-a'").get()?.count, 0);
  assert.equal(db.connection.prepare("SELECT COUNT(*) count FROM usage_model_daily WHERE session_id='session-a'").get()?.count, 0);
  db.clearData();
  assert.deepEqual(oracle(db), []);
  assert.equal(db.queryTurnsCount(), 0);
  replace(db, [original]);
  verify();
  expect(oracle(db)[0], { total_tokens: 100, turn_count: 1 });
});

function metadata(): FileMetadata {
  return { provider: 'claude', source_root: '/rollup', path: '/rollup/session.jsonl', session_id: 'session-a',
    size_bytes: 512, mtime_ms: 123456, dev: '1', inode: '2', parser_version: 1 };
}

test('manifest diagnostic updates refresh stale counts and successful replacement clears stale state', t => {
  const db = fixture(t);
  const file = metadata();
  const manifest = db.observeFile(file, 'first');
  const rows = [turn('one', '2026-10-01T12:00:00', 100, { model_usage: [model('A', 100)] }),
    turn('two', '2026-10-02T12:00:00', 200, { model_usage: [model('B', 200)] })];
  const install = (): void => db.replaceSessions({ sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...file, id: manifest.id }], summaries: rows });
  install();
  expect(oracle(db)[0], { stale_turns: 0, total_tokens: 300 });
  for (const status of ['error', 'interrupted'] as const) {
    db.setManifestDiagnostic(manifest.id, status, 'failed-line', null, 17);
    expect(oracle(db)[0], { stale_turns: 2, total_tokens: 300 });
    for (const by of ['provider', 'model'] as const) oracle(db, {}, 'day', 'Asia/Seoul', by);
    install();
    expect(oracle(db)[0], { stale_turns: 0, total_tokens: 300 });
  }
  const before = snapshot(db, rollupTables);
  db.markSeen(manifest.id, 'later');
  db.observeFile(file, 'latest');
  db.setManifestDiagnostic(manifest.id, 'done', 'committed', null);
  assert.deepEqual(snapshot(db, rollupTables), before, 'Presence and non-error file diagnostics do not alter aggregate state');
});

test('v10 upgrade preserves existing IDs, diagnostic/model/cost rows and lazily fills rollups on first aggregate', t => {
  const files = disk(t);
  const previous = files.open();
  const file = metadata();
  const manifest = previous.observeFile(file, 'old');
  previous.replaceSessions({ sessions: [{ provider: 'claude', session_id: 'session-a' }], files: [{ ...file, id: manifest.id }],
    summaries: [turn('preserved', '2026-10-01T12:00:00', 100, {
      diagnostic_file_id: manifest.id, diagnostic_offset: 42, last_error: 'stored-error', billing: 'api',
      model_usage: [model('claude-sonnet-4-6', 100)], capability_usage: [{ category: 'skill', name: 'fixture', usage_count: 2 }],
    })] });
  const facts = snapshot(previous, factTables);
  const originalID = previous.queryTurns()[0].id;
  previous.close();
  const legacy = new DatabaseSync(files.path);
  try {
    legacy.exec('DROP TABLE usage_model_daily; DROP TABLE usage_request_daily; DROP TABLE usage_rollup_meta; PRAGMA user_version=10;');
  } finally { legacy.close(); }
  const migrated = files.open();
  assert.equal(migrated.connection.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  assert.deepEqual(snapshot(migrated, factTables), facts);
  assert.equal(migrated.queryTurns()[0].id, originalID);
  assert.equal(migrated.connection.prepare('SELECT COUNT(*) count FROM usage_request_daily').get()?.count, 0);
  assert.equal(migrated.connection.prepare('SELECT COUNT(*) count FROM usage_model_daily').get()?.count, 0);
  for (const by of ['provider', 'model'] as const) {
    expect(oracle(migrated, {}, 'total', 'Asia/Seoul', by)[0], { total_tokens: 100, stale_turns: 1 });
    oracle(migrated, { includeCosts: true }, 'total', 'Asia/Seoul', by);
  }
  assert.deepEqual(snapshot(migrated, factTables), facts, 'Backfill does not rewrite source/model pricing records');
  const aggregates = snapshot(migrated, rollupTables);
  migrated.close();
  const reopened = files.open();
  assert.deepEqual(snapshot(reopened, factTables), facts);
  assert.deepEqual(snapshot(reopened, rollupTables), aggregates, 'Warm reopen reuses the stored materialization');
  oracle(reopened);
});

for (const version of [14, 15]) test(`v${version} month layout returns to session clustering without rewriting facts`, t => {
  const files = disk(t), previous = files.open();
  const file = metadata(), manifest = previous.observeFile(file, 'v13');
  previous.replaceSessions({ sessions: [{ provider: 'claude', session_id: 'session-a' }], files: [{ ...file, id: manifest.id }], summaries: [
    turn('before-month', '2026-09-30T23:59:00', 100, { diagnostic_file_id: manifest.id, model_usage: [model('A', 100)],
      capability_usage: [{ category: 'skill', name: 'preserved', usage_count: 2 }], billing: 'api' }),
    turn('after-month', '2026-10-01T00:01:00', 200, { model_usage: [model('A', 200)] }),
    turn('unknown-month', null, 30),
  ] });
  oracle(previous, {}, 'month');
  const facts = snapshot(previous, factTables);
  // Recreate the experimental monthly cache; the migration must discard only derived data.
  for (const table of ['usage_request_daily', 'usage_model_daily']) {
    const info = previous.connection.prepare(`PRAGMA table_info(${table})`).all();
    const columns = info.map(c => String(c.name));
    previous.connection.exec(`CREATE TABLE ${table}_monthly (
      ${info.map(c => `${c.name} ${c.type}${c.notnull ? ' NOT NULL' : ''}`).join(',')},
      local_month TEXT NOT NULL CHECK(local_month=substr(local_day,1,7)),
      PRIMARY KEY(local_month,provider,session_id,project_key,local_day${table.includes('model') ? ',model_key' : ''})) WITHOUT ROWID;
      INSERT INTO ${table}_monthly SELECT ${columns},substr(local_day,1,7) FROM ${table};
      DROP TABLE ${table}; ALTER TABLE ${table}_monthly RENAME TO ${table};`);
  }
  if (version === 15) previous.connection.exec(`CREATE TABLE usage_session_months (
    provider TEXT NOT NULL,session_id TEXT NOT NULL,local_month TEXT NOT NULL,min_started_at_ms INTEGER,
    PRIMARY KEY(provider,session_id,local_month)) WITHOUT ROWID;
    INSERT INTO usage_session_months SELECT provider,session_id,local_month,min(min_started_at_ms)
      FROM usage_request_daily GROUP BY provider,session_id,local_month;`);
  previous.connection.exec(`UPDATE usage_rollup_meta SET format_version=${version-12}; PRAGMA user_version=${version}`);
  previous.close();
  const migrated = files.open();
  assert.deepEqual(snapshot(migrated, factTables), facts);
  assert.equal(migrated.connection.prepare('PRAGMA user_version').get()?.user_version, SCHEMA_VERSION);
  assert.equal(migrated.connection.prepare("SELECT count(*) n FROM sqlite_master WHERE name='usage_session_months'").get()?.n,0);
  assert.equal(migrated.connection.prepare('SELECT count(*) n FROM usage_request_daily').get()?.n, 0);
  for (const table of ['usage_request_daily', 'usage_model_daily']) {
    const pk = migrated.connection.prepare(`PRAGMA table_info(${table})`).all().filter(c => Number(c.pk) > 0).sort((a,b) => Number(a.pk)-Number(b.pk));
    assert.deepEqual(pk.slice(0,2).map(c=>c.name), ['provider','session_id']);
  }
  const october = { fromMs: epoch('2026-10-01T00:00:00'), toMs: epoch('2026-11-01T00:00:00') };
  for (const by of ['provider','model'] as const) for (const filter of [october, { ...october, unknownTime: 'exclude' as const },
    { ...october, unknownTime: 'only' as const }, { ...october, fromMs: epoch('2026-10-01T00:00:30') }]) {
    oracle(migrated, filter, 'month', 'Asia/Seoul', by);
  }
  assert.deepEqual(migrated.connection.prepare('SELECT DISTINCT local_day FROM usage_request_daily ORDER BY local_day').all().map(r => r.local_day), ['', '2026-09-30', '2026-10-01']);
  assert.deepEqual(snapshot(migrated, factTables), facts);
});

test('v13 upgrade reuses the populated session-clustered cache without backfill', t => {
  const files=disk(t),previous=files.open();
  replace(previous,[turn('preserved','2026-10-01T00:00:00',200),turn('unknown',null,10)]);
  oracle(previous);const before=snapshot(previous);previous.connection.exec('PRAGMA user_version=13');previous.close();
  const migrated=files.open();assert.deepEqual(snapshot(migrated),before);oracle(migrated);
  assert.deepEqual(snapshot(migrated),before);
});

test('a failure after request rollup refresh rolls back facts, model rollup, diagnostics, names and costs', t => {
  const db = fixture(t);
  const file = metadata();
  const manifest = db.observeFile(file, 'first');
  const install = (tokens: number, name: string): void => db.replaceSessions({
    sessions: [{ provider: 'claude', session_id: 'session-a' }],
    files: [{ ...file, size_bytes: tokens, id: manifest.id }],
    summaries: [turn('same', '2026-10-01T12:00:00', tokens, {
      project_name: name, session_name: name, model_usage: [model('A', tokens)], billing: 'api',
      capability_usage: [{ category: 'skill', name, usage_count: 1 }],
    })],
  });
  install(100, 'Before');
  oracle(db);
  oracle(db, {}, 'total', 'Asia/Seoul', 'model');
  const before = snapshot(db);
  db.connection.exec(`CREATE TEMP TRIGGER reject_model_rollup BEFORE INSERT ON usage_model_daily
    BEGIN SELECT RAISE(ABORT, 'injected rollup failure'); END;`);
  assert.throws(() => install(200, 'After'), /injected rollup failure/);
  assert.deepEqual(snapshot(db), before, 'A single rollback restores every persistent table');
  oracle(db);
  db.connection.exec('DROP TRIGGER reject_model_rollup;');
  install(200, 'After');
  expect(oracle(db)[0], { total_tokens: 200, turn_count: 1 });
  oracle(db, {}, 'total', 'Asia/Seoul', 'model');
});

test('WAL readers observe one complete facts/rollup snapshot across session replacement', t => {
  const files = disk(t);
  const writer = files.open();
  const original = turn('same', '2026-10-01T12:00:00', 100, { model_usage: [model('A', 100)] });
  replace(writer, [original]);
  oracle(writer);
  const reader = files.open();
  reader.connection.exec('BEGIN;');
  try {
    expect(oracle(reader)[0], { total_tokens: 100, turn_count: 1 });
    replace(writer, [turn('same', '2026-10-01T12:00:00', 200, { model_usage: [model('B', 200)] })]);
    expect(oracle(writer)[0], { total_tokens: 200, turn_count: 1 });
    expect(oracle(reader)[0], { total_tokens: 100, turn_count: 1 });
    expect(oracle(reader, {}, 'total', 'Asia/Seoul', 'model')[0], { model: 'A', total_tokens: 100 });
  } finally { reader.connection.exec('COMMIT;'); }
  expect(oracle(reader)[0], { total_tokens: 200, turn_count: 1 });
  expect(oracle(reader, {}, 'total', 'Asia/Seoul', 'model')[0], { model: 'B', total_tokens: 200 });
});

test('stored cost changes keep raw cost fallback current without rebuilding token rollups', t => {
  const db = fixture(t, [turn('known', '2026-10-01T12:00:00', 100, {
    model_usage: [model('claude-sonnet-4-6', 100)], billing: 'unknown',
  })]);
  oracle(db);
  const before = snapshot(db, rollupTables);
  for (const mode of ['api', 'subscription', 'unknown'] as const) {
    db.setSessionBilling('claude', 'session-a', mode);
    for (const by of ['provider', 'model'] as const) {
      oracle(db, { includeCosts: true }, 'total', 'Asia/Seoul', by);
      oracle(db, { includeCosts: true }, 'day', 'Asia/Seoul', by);
    }
    assert.deepEqual(snapshot(db, rollupTables), before, 'Billing does not invalidate token/duration states');
  }
});

test('metadata-only session renames immediately affect rollup dimensions and name filters', t => {
  const db = fixture(t, [turn('same', '2026-10-01T12:00:00', 100)]);
  oracle(db, {}, 'session');
  const before = snapshot(db, rollupTables);
  db.connection.exec(`CREATE TEMP TABLE session_names(provider TEXT,session_id TEXT,session_name TEXT);
    INSERT INTO session_names VALUES ('claude','session-a','Metadata-only rename');`);
  db.transaction(() => applySessionNames(db.connection));
  expect(oracle(db, { sessionName: 'Metadata-only' }, 'session')[0], { session_name: 'Metadata-only rename', total_tokens: 100 });
  assert.deepEqual(oracle(db, { sessionName: 'Session%_' }, 'session'), []);
  assert.deepEqual(snapshot(db, rollupTables), before, 'Names remain normalized instead of duplicating them in rollups');
});

test('two WAL connections can alternate timezones and update sessions without mixing their snapshots', t => {
  const files = disk(t);
  const writer = files.open();
  replace(writer, [turn('same', '2026-10-01T01:00:00', 100, { model_usage: [model('A', 100)] })]);
  oracle(writer, {}, 'day', 'UTC');
  const reader = files.open();
  reader.connection.exec('BEGIN;');
  try {
    assert.deepEqual(oracle(reader, {}, 'day', 'UTC').map(row => row.period), ['2026-09-30']);
    oracle(writer, {}, 'day', 'Asia/Seoul');
    replace(writer, [turn('same', '2026-10-02T01:00:00', 200, { model_usage: [model('B', 200)] })]);
    expect(oracle(reader, {}, 'day', 'UTC')[0], { period: '2026-09-30', total_tokens: 100 });
    // A caller-owned stale snapshot must use raw SQL for a different timezone instead of trying a writer upgrade.
    expect(oracle(reader, {}, 'day', 'Asia/Seoul')[0], { period: '2026-10-01', total_tokens: 100 });
  } finally { reader.connection.exec('COMMIT;'); }
  expect(oracle(reader, {}, 'day', 'UTC')[0], { period: '2026-10-01', total_tokens: 200 });
  expect(oracle(writer, {}, 'day', 'Asia/Seoul', 'model')[0], { period: '2026-10-02', model: 'B', total_tokens: 200 });
  expect(oracle(reader, {}, 'day', 'UTC', 'model')[0], { period: '2026-10-01', model: 'B', total_tokens: 200 });
  assert.equal(reader.connection.prepare('SELECT COUNT(*) count FROM usage_rollup_meta').get()?.count, 1);
});

test('Node 22.15 without isTransaction retains correct raw reads and supports caller transactions', t => {
  const db = fixture(t, [turn('same', '2026-10-01T12:00:00', 100)]);
  oracle(db);
  // Modern Node exposes a non-configurable getter; emulate the older connection surface.
  const compatible = {
    connection: { prepare: db.connection.prepare.bind(db.connection), exec: db.connection.exec.bind(db.connection) },
  } as unknown as SqliteSession;
  Object.assign(compatible, { rollups: new UsageRollupStore(compatible) });
  const reader = new SummaryReader(compatible);
  for (const timezone of ['UTC', 'Asia/Seoul', 'America/New_York']) {
    const query = buildUsageQuery({}, 'day', timezone, 'provider');
    assert.deepEqual(reader.queryUsage({}, 'day', timezone), db.connection.prepare(query.sql).all(...query.values, 100, 0));
    const page = reader.queryUsagePage({}, 'day', timezone);
    assert.deepEqual(page.rows, reader.queryUsage({}, 'day', timezone));
    assert.equal(page.total, 1);
    db.transaction(() => expect(reader.queryUsage()[0], { total_tokens: 100, turn_count: 1 }));
    db.transaction(() => assert.equal(reader.queryUsagePage({}, 'turn', timezone).rows[0].total_tokens, 100));
  }
  oracle(db);
});

test('page rows and counts keep one snapshot across concurrent WAL writes for raw, rollup and legacy reads', t => {
  const files = disk(t), writer = files.open(), db = files.open();
  const original = turn('original', '2026-10-01T13:00:00', 100, { model_usage: [model('A', 100)] });
  const added = turn('added', '2026-10-02T13:00:00', 200, {
    project_key: '/rollup/other', project_name: 'Other', model_usage: [model('B', 200)],
  });
  const cases: { group: UsageGrouping | 'turn'; filter: SummaryFilter; by: UsageBasis }[] = [
    { group: 'turn', filter: { includeCosts: true }, by: 'provider' },
    { group: 'project', filter: { includeCosts: true }, by: 'model' },
    { group: 'day', filter: {}, by: 'provider' },
    { group: 'day', filter: { fromMs: epoch('2026-10-01T12:00:00') }, by: 'model' },
  ];
  for (const legacy of [false, true]) for (const { group, filter, by } of cases) {
    replace(writer, [original]);
    writer.queryUsagePage({}, 'day', 'Asia/Seoul');
    const prepare = db.connection.prepare;
    let injected = false;
    db.connection.prepare = function(sql) {
      const statement = prepare.call(this, sql);
      if (/\bLIMIT\s+\?\s+OFFSET\s+\?/.test(sql)) {
        const all = statement.all;
        statement.all = function(...values) {
          const rows = Reflect.apply(all, this, values);
          if (!injected) { injected = true; replace(writer, [original, added]); }
          return rows;
        };
      }
      return statement;
    };
    try {
      const compatible = { connection: {
        prepare: db.connection.prepare.bind(db.connection), exec: db.connection.exec.bind(db.connection),
      } } as unknown as SqliteSession;
      Object.assign(compatible, { rollups: new UsageRollupStore(compatible) });
      const reader = legacy ? new SummaryReader(compatible) : db;
      const page = reader.queryUsagePage(filter, group, 'Asia/Seoul', {}, by);
      assert.ok(injected, 'Writer commits after the page rows are selected');
      assert.equal(page.rows.length, 1);assert.equal(page.total, 1);
      assert.equal(page.rows[0].total_tokens, 100);
      assert.equal(reader.queryUsagePage(filter, group, 'Asia/Seoul', {}, by).total, 2, 'Next page sees the committed write');
    } finally { db.connection.prepare = prepare; }
  }
});

test('legacy page count failures release their savepoint and preserve the caller transaction', t => {
  const db = fixture(t, [turn('same', '2026-10-01T12:00:00', 100)]);
  const count = buildUsageCountQuery({ includeCosts: true }, 'project', 'UTC', 'provider');
  let failCount = true;
  const compatible = { connection: {
    prepare: (sql: string) => {
      if (failCount && sql === count.sql) throw new Error('injected page count failure');
      return db.connection.prepare(sql);
    },
    exec: db.connection.exec.bind(db.connection),
  } } as unknown as SqliteSession;
  const reader = new SummaryReader(compatible);
  db.transaction(() => {
    db.connection.exec("UPDATE projects SET project_name = 'Caller change'");
    assert.throws(() => reader.queryUsagePage({ includeCosts: true }, 'project'), /injected page count failure/);
    assert.equal(db.connection.isTransaction, true);
    assert.equal(db.connection.prepare('SELECT project_name FROM projects').get()?.project_name, 'Caller change');
    failCount = false;
    assert.equal(reader.queryUsagePage({ includeCosts: true }, 'project').total, 1);
  });
  assert.equal(db.connection.isTransaction, false);
  assert.equal(reader.queryUsagePage({}, 'turn').total, 1, 'The connection remains usable after the caller commits');
});

test('extreme stored years retain numeric date filtering through raw fallback and allow later ingestion', t => {
  const db = fixture(t, [turn('normal', '2026-10-01T12:00:00', 100)]);
  oracle(db);
  replace(db, [turn('future', null, 1, { started_at_ms: Date.parse('+010000-01-01T00:00:00Z') }),
    turn('ancient', null, 10, { started_at_ms: Date.parse('-003000-01-01T00:00:00Z') }),
    turn('normal', '2026-10-01T12:00:00', 100)]);
  for (const filter of [{}, { fromMs: Date.parse('2020-01-01T00:00:00Z') },
    { toMs: Date.parse('2030-01-01T00:00:00Z') }]) {
    for (const group of ['total', 'day', 'month', 'session'] as const) oracle(db, filter, group, 'UTC');
  }
  assert.equal(db.connection.prepare('SELECT COUNT(*) count FROM usage_rollup_meta').get()?.count, 0);
  replace(db, [turn('outside-js-calendar', null, 5, { started_at_ms: Number.MAX_SAFE_INTEGER })]);
  expect(oracle(db, {}, 'total', 'UTC')[0], { total_tokens: 5, turn_count: 1 });
  replace(db, [turn('valid-again', '2026-10-01T12:00:00', 200)]);
  expect(oracle(db)[0], { total_tokens: 200, turn_count: 1 });
  assert.equal(db.connection.prepare('SELECT COUNT(*) count FROM usage_rollup_meta').get()?.count, 1);
});
