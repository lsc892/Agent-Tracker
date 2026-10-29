// manifest 뒤의 세션 일괄 교체가 스트리밍 입력·원자성·정확한 집계 결과를 유지하는지 검증한다.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SummaryDatabase, type TurnSummaryInput } from '../../src/summary/db';
import { buildUsageQuery } from '../../src/summary/db/queries';

function row(id: string, date: string | null, tokens = 10): TurnSummaryInput {
  return { provider: 'codex', session_id: 's', project_key: 'p', project_name: 'Project', root_turn_id: id,
    started_at_ms: date === null ? null : Date.parse(date), input_tokens: tokens, output_tokens: 0, total_tokens: tokens,
    duration_ms: 1, duration_quality: 'exact', status: 'completed',
    model_usage: [{ model: 'gpt-5.6-sol', input_tokens: tokens, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }],
    capability_usage: [{ category: 'skill', name: 'test', usage_count: 1 }] };
}

const sessions = [{ provider: 'codex' as const, session_id: 's' }];
function replace(db: SummaryDatabase, summaries: Iterable<TurnSummaryInput>): void {
  db.replaceSessions({ sessions, files: [], summaries });
}

function audit(db: SummaryDatabase): void {
  db.connection.exec('CREATE TEMP TABLE writes(name TEXT, key TEXT)');
  for (const name of ['turn_summary', 'turn_model_usage', 'turn_capability_usage', 'turn_costs', 'usage_request_daily', 'usage_model_daily']) {
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      const ref = action === 'DELETE' ? 'old' : 'new';
      const key = name.startsWith('usage_') ? `${ref}.local_day` : name === 'turn_summary' ? `${ref}.root_turn_id` : `CAST(${ref}.turn_id AS TEXT)`;
      db.connection.exec(`CREATE TEMP TRIGGER audit_${name}_${action} AFTER ${action} ON main.${name}
        BEGIN INSERT INTO writes VALUES ('${name}',${key}); END`);
    }
  }
}

function exact(db: SummaryDatabase): void {
  for (const timezone of ['Asia/Seoul', 'America/New_York']) for (const by of ['provider', 'model'] as const) {
    for (const group of ['total', 'month', 'day', 'session', 'project'] as const) {
      const raw = buildUsageQuery({}, group, timezone, by);
      assert.deepEqual(db.queryUsage({}, group, timezone, { limit: 1000 }, by),
        db.connection.prepare(raw.sql).all(...raw.values, 1000, 0));
    }
  }
}

test('identical streamed snapshots replace session rows and preserve their semantic statistics', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  const rows = [row('a', '2026-10-01T00:00:00Z'), row('b', null)];
  replace(db, rows); db.queryUsage({}, 'total', 'Asia/Seoul');
  const semantics = () => db.queryTurns().map(({ id: _id, updated_at: _updated, ...value }) => value);
  const before = semantics(); audit(db);
  replace(db, (function* () { yield* rows; })());
  assert.deepEqual(semantics(), before);
  assert.ok(db.connection.prepare("SELECT 1 FROM writes WHERE name='turn_summary'").get(), 'Accepted sessions use the restored bulk replacement path');
  assert.equal(db.connection.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE name IN ('db_next_models','db_next_capabilities','db_replacement_turns','db_rollup_dirty','db_rollup_inputs')").get()?.n, 0);
  exact(db);
});

test('session replacement rebuilds existing day buckets and historical moves and deletes restore extrema', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  const a = row('a', '2026-03-08T06:30:00Z'), b = row('b', '2026-03-09T06:30:00Z');
  replace(db, [a, b]); db.queryUsage({}, 'total', 'America/New_York'); audit(db);
  const added = row('c', '2026-03-08T07:30:00Z', 20);
  replace(db, [a, b, added]);
  assert.deepEqual(db.connection.prepare("SELECT DISTINCT key FROM writes WHERE name='turn_summary' ORDER BY key").all().map(r => r.key), ['a', 'b', 'c']);
  assert.deepEqual(db.connection.prepare("SELECT DISTINCT key FROM writes WHERE name LIKE 'usage_%' ORDER BY key").all().map(r => r.key), ['2026-03-08', '2026-03-09']);
  exact(db);
  const moved = { ...a, started_at_ms: null, project_key: 'other', project_name: 'Other', model_usage: undefined };
  replace(db, [moved, b]); exact(db);
  replace(db, [b]); exact(db);
  assert.equal(db.queryUsage()[0].turn_count, 1);
});

test('model replacement, preserved Skill counts and invalid one-shot snapshots remain atomic', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  const original = row('a', '2026-10-01T00:00:00Z'); replace(db, [original]);
  db.queryUsage({}, 'total', 'Asia/Seoul');
  const changed = { ...original, capability_usage: undefined,
    model_usage: [{ model: 'new-model', input_tokens: 10, output_tokens: 0, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }] };
  db.replaceSessions({ sessions, files: [], summaries: [changed], preserveCapabilities: true });
  assert.equal(db.queryTurns()[0].root_turn_id, original.root_turn_id);
  assert.equal(db.queryCapabilities({}, 'skill').totalUses, 1);
  exact(db);
  const before = db.queryTurns();
  function* invalid(): IterableIterator<TurnSummaryInput> { yield row('next', null); yield { ...changed, input_tokens: -1 }; }
  assert.throws(() => replace(db, invalid())); assert.deepEqual(db.queryTurns(), before); exact(db);
  assert.throws(() => replace(db, [changed, changed])); assert.deepEqual(db.queryTurns(), before);
  replace(db, [row('valid', null)]); exact(db);
});

test('out-of-calendar writes invalidate rollups and retain raw fallback without evaluating an invalid date', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  replace(db, [row('a', null)]); db.queryUsage({}, 'total', 'Asia/Seoul');
  replace(db, [{ ...row('a', null), started_at_ms: Number.MAX_SAFE_INTEGER }]);
  assert.equal(db.connection.prepare('SELECT count(*) n FROM usage_rollup_meta').get()?.n, 0);
  assert.equal(db.queryUsage()[0].total_tokens, 10);
});

test('dense historical corrections rebuild the session and preserve exact multi-day state', t => {
  const db = new SummaryDatabase(':memory:'); t.after(() => db.close());
  const rows = Array.from({ length: 40 }, (_, index) => row(`r${index}`,
    new Date(Date.UTC(2026, 0, 1 + index)).toISOString(), index + 1));
  replace(db, rows); db.queryUsage({}, 'total', 'Asia/Seoul');
  const roots = db.queryTurns().map(r => r.root_turn_id);
  replace(db, rows.map(r => ({ ...r, status: 'failed', duration_ms: null, duration_quality: 'missing' })));
  assert.deepEqual(db.queryTurns().map(r => r.root_turn_id), roots);
  assert.equal(db.queryUsage()[0].completed_turns, 0); exact(db);
  assert.equal(db.connection.prepare("SELECT count(*) n FROM sqlite_temp_master WHERE name='db_rollup_dirty'").get()?.n, 0);
});
