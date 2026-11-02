// 독립 기대 값으로 롤업의 평균·모델·날짜·세션 필터 의미를 검증한다.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { SummaryDatabase, type ModelUsageInput, type SummaryFilter, type TurnSummaryInput,
  type UsageGrouping, type UsageRow } from '../../src/summary/db';
import { buildUsageCountQuery, buildUsageQuery, type QuerySql, type UsageBasis } from '../../src/summary/db/queries';

interface Prototype {
  TIMEZONE: string;
  install(database: SummaryDatabase): void;
  refresh(database: SummaryDatabase): void;
  build(filter: SummaryFilter, grouping: UsageGrouping, timezone: string, by: UsageBasis): {
    mode: string; rows: QuerySql; count: QuerySql;
  };
}

// The candidate stays outside product code; this path is relative to dist/tests/node.
const prototype = require(resolve(__dirname, '../../../tests/benchmarks/sql-rollup-prototype.cjs')) as Prototype;
const epoch = (local: string): number => Date.parse(`${local}+09:00`);

function turn(id: string, local: string | null, tokens: number, overrides: Partial<TurnSummaryInput> = {}): TurnSummaryInput {
  const start = local === null ? null : epoch(local);
  return {
    provider: 'claude', project_key: '/fixture/project', project_name: 'Project%_',
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

function fixture(t: TestContext, rows: TurnSummaryInput[]): SummaryDatabase {
  const db = new SummaryDatabase(':memory:');
  t.after(() => db.close());
  const sessions = new Map(rows.map(row => [`${row.provider}:${row.session_id}`, { provider: row.provider, session_id: row.session_id }]));
  db.replaceSessions({ sessions: sessions.values(), files: [], summaries: rows });
  prototype.install(db);
  db.transaction(() => prototype.refresh(db));
  return db;
}

function read(db: SummaryDatabase, filter: SummaryFilter = {}, grouping: UsageGrouping = 'total', by: UsageBasis = 'provider'): UsageRow[] {
  const candidate = prototype.build(filter, grouping, prototype.TIMEZONE, by);
  const query = buildUsageQuery(filter, grouping, prototype.TIMEZONE, by);
  const actual = db.connection.prepare(candidate.rows.sql).all(...candidate.rows.values, 1000, 0) as unknown as UsageRow[];
  const original = db.connection.prepare(query.sql).all(...query.values, 1000, 0) as unknown as UsageRow[];
  assert.deepEqual(actual, original, 'Every output field must agree with the original SQL');
  const originalCount = buildUsageCountQuery(filter, grouping, prototype.TIMEZONE, by);
  assert.equal(db.connection.prepare(candidate.count.sql).get(...candidate.count.values)?.count, actual.length);
  assert.equal(db.connection.prepare(originalCount.sql).get(...originalCount.values)?.count, actual.length);
  return actual;
}

function expect(row: UsageRow | undefined, expected: Partial<UsageRow>): void {
  assert.ok(row, 'Expected an aggregate row');
  for (const key of Object.keys(expected) as (keyof UsageRow)[]) {
    assert.equal(row[key], expected[key], key);
  }
}

test('daily rollups weight completed turns by count while totals include all statuses', t => {
  const db = fixture(t, [
    turn('day-one', '2026-10-01T12:00:00', 100),
    turn('day-two-a', '2026-10-02T10:00:00', 30),
    turn('day-two-b', '2026-10-02T11:00:00', 50),
    turn('day-two-c', '2026-10-02T12:00:00', 120),
    turn('running', '2026-10-02T13:00:00', 500, { status: 'in_progress' }),
    turn('failed', '2026-10-02T14:00:00', 700, { status: 'failed' }),
  ]);
  const daily = read(db, {}, 'day');
  expect(daily[0], { period: '2026-10-01', total_tokens: 100, turn_count: 1, avg_tokens_per_turn: 100 });
  expect(daily[1], { period: '2026-10-02', total_tokens: 1400, turn_count: 5, completed_turns: 3, avg_tokens_per_turn: 200 / 3 });
  for (const grouping of ['total', 'project', 'session', 'month'] as const) {
    expect(read(db, {}, grouping)[0], {
      total_tokens: 1500, input_tokens: 1500, output_tokens: 0,
      turn_count: 6, completed_turns: 4, recorded_turns: 6, recorded_completed_turns: 4,
      avg_tokens_per_turn: 75, avg_input_tokens: 75, avg_output_tokens: 0,
    });
  }
});

test('model groups preserve unknown versus unrecorded usage and count a multi-model turn per model', t => {
  const db = fixture(t, [
    turn('unrecorded', '2026-10-01T10:00:00', 0),
    turn('known-zero', '2026-10-01T11:00:00', 0, { model_usage: [model('A', 0)] }),
    turn('unknown-positive', '2026-10-02T10:00:00', 40, { model_usage: [model('', 40)] }),
    turn('multi-model', '2026-10-02T11:00:00', 100, { model_usage: [model('A', 60), model('B', 40)] }),
    turn('unknown-zero', '2026-10-02T12:00:00', 0, { model_usage: [model('', 0)] }),
  ]);
  for (const excludeEmptyUsage of [false, true]) {
    expect(read(db, { excludeEmptyUsage })[0], {
      total_tokens: 140, turn_count: 5, completed_turns: 5, recorded_turns: 3, recorded_completed_turns: 3,
      avg_tokens_per_turn: excludeEmptyUsage ? 140 / 3 : 28,
    });
    const models = read(db, { excludeEmptyUsage }, 'total', 'model');
    assert.equal(models.length, 4);
    expect(models.find(row => row.model === null), {
      total_tokens: 0, turn_count: 2, recorded_turns: 0, avg_tokens_per_turn: excludeEmptyUsage ? null : 0,
    });
    expect(models.find(row => row.model === ''), { total_tokens: 40, turn_count: 1, recorded_turns: 1, avg_tokens_per_turn: 40 });
    expect(models.find(row => row.model === 'A'), { total_tokens: 60, turn_count: 2, recorded_turns: 2, avg_tokens_per_turn: 30 });
    expect(models.find(row => row.model === 'B'), { total_tokens: 40, turn_count: 1, recorded_turns: 1, avg_tokens_per_turn: 40 });
    assert.equal(models.reduce((sum, row) => sum + row.turn_count, 0), 6, 'Two models share one provider turn');
  }
});

test('cache null propagation uses the selected completed sample and duration excludes nulls', t => {
  const db = fixture(t, [
    turn('known', '2026-10-01T10:00:00', 100, {
      cache_write_input_tokens: 10, cache_read_input_tokens: 20, duration_ms: 100,
    }),
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
    expect(read(db, { excludeEmptyUsage })[0], {
      total_tokens: 900, turn_count: 4, completed_turns: 3, recorded_completed_turns: 2,
      cache_write_input_tokens: null, cache_read_input_tokens: null,
      avg_tokens_per_turn: excludeEmptyUsage ? 200 : 400 / 3,
      avg_cache_write_input_tokens: null, avg_cache_read_input_tokens: excludeEmptyUsage ? 25 : null,
      avg_duration_ms: 100, turns_with_duration: 1, exact_duration_turns: 1,
      derived_duration_turns: 1, approximate_duration_turns: 0, missing_duration_turns: excludeEmptyUsage ? 1 : 2,
    });
  }
});

test('partial-day boundaries are exclusive at the end and unknown time stays in its own group', t => {
  const db = fixture(t, [
    turn('before', '2026-10-01T11:59:59', 1),
    turn('lower', '2026-10-01T12:00:00', 10),
    turn('whole-day', '2026-10-02T00:00:00', 20),
    turn('upper-inside', '2026-10-03T11:59:59', 30),
    turn('upper-excluded', '2026-10-03T12:00:00', 100),
    turn('unknown', null, 40),
  ]);
  const range = { fromMs: epoch('2026-10-01T12:00:00'), toMs: epoch('2026-10-03T12:00:00') };
  assert.equal(prototype.build(range, 'total', prototype.TIMEZONE, 'provider').mode, 'rollup-plus-raw-boundaries');
  expect(read(db, range)[0], { total_tokens: 60, turn_count: 3, avg_tokens_per_turn: 20, unknown_time_turns: 0 });
  expect(read(db, { ...range, unknownTime: 'include' })[0], { total_tokens: 100, turn_count: 4, unknown_time_turns: 1 });
  expect(read(db, { ...range, unknownTime: 'only' })[0], { total_tokens: 40, turn_count: 1, unknown_time_turns: 1 });
  const calendar = read(db, range, 'day');
  assert.deepEqual(calendar.map(row => [row.period, row.total_tokens]), [
    ['2026-10-01', 10], ['2026-10-02', 20], ['2026-10-03', 30], [null, 40],
  ]);
  expect(read(db, { fromMs: range.fromMs, toMs: epoch('2026-10-01T13:00:00') })[0], { total_tokens: 10, turn_count: 1 });
  const aligned = { fromMs: epoch('2026-10-02T00:00:00'), toMs: epoch('2026-10-03T00:00:00') };
  assert.equal(prototype.build(aligned, 'total', prototype.TIMEZONE, 'provider').mode, 'rollup');
  expect(read(db, aligned)[0], { total_tokens: 20, turn_count: 1 });
  assert.deepEqual(read(db, { fromMs: range.toMs, toMs: range.fromMs }), []);
});

test('session start precedes the date filter and names and providers select the intended session', t => {
  const earliest = epoch('2026-09-30T10:00:00');
  const db = fixture(t, [
    turn('earlier', '2026-09-30T10:00:00', 100),
    turn('selected', '2026-10-02T12:00:00', 20),
    turn('other-session', '2026-10-02T12:00:00', 50, { session_id: 'session-b', session_name: 'Other' }),
    turn('other-provider', '2026-09-29T10:00:00', 700, { provider: 'codex' }),
    turn('other-project', '2026-10-02T12:00:00', 1000, {
      project_key: '/fixture/other', project_name: 'Other', session_id: 'session-c', session_name: 'Other',
    }),
  ]);
  const result = read(db, {
    providers: ['claude'], projectKey: '/fixture/project', projectName: '%_', sessionName: '%_',
    fromMs: epoch('2026-10-02T00:00:00'), toMs: epoch('2026-10-03T00:00:00'),
  }, 'session');
  assert.equal(result.length, 1);
  expect(result[0], {
    provider: 'claude', project_key: '/fixture/project', project_name: 'Project%_',
    session_id: 'session-a', session_name: 'Session%_', session_started_at_ms: earliest,
    total_tokens: 20, turn_count: 1, avg_tokens_per_turn: 20,
  });
});
