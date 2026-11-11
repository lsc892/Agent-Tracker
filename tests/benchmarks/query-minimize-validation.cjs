// 이번 SQL A/B의 신규 INSERT 경계·부분 날짜·실패 복구를 고정 합성 DTO로 대조한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { dirname, join, resolve } = require('node:path');
const { verifyAggregates } = require('./transaction-batch-validation.cjs');

const options = {};
for (const argument of process.argv.slice(2)) {
  const match = /^--(before|after|output)=(.+)$/.exec(argument);
  assert.ok(match, 'Expected --before/after/output'); options[match[1]] = resolve(match[2]);
}
assert.ok(options.before && options.after && options.output);
assert.ok(!fs.existsSync(options.output), 'Never overwrite validation reports');
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) =>
  typeof item === 'number' && !Number.isInteger(item) ? Number(item.toPrecision(12)) : item);
const load = directory => ({
  Database: require(join(directory, 'dist/src/summary/db')).SummaryDatabase,
  raw: require(join(directory, 'dist/src/summary/db/queries')).buildUsageQuery,
});
const apis = { A: load(options.before), B: load(options.after) };
const zone = 'Asia/Seoul', first = Date.UTC(2026, 10, 1, 14);

function row(index) {
  const input = index % 7 === 0 ? 0 : 30, output = input ? 3 : 0;
  const models = index % 5 === 0 ? [] : [{ model: index % 4 ? 'model-A' : '',
    input_tokens: input, output_tokens: output, cache_write_input_tokens: null, cache_read_input_tokens: 0 }];
  if (index % 5 === 2) {
    models[0].input_tokens = input / 3; models[0].output_tokens = output / 3;
    models.push({ ...models[0], model: 'model-B', input_tokens: input * 2 / 3, output_tokens: output * 2 / 3 });
  }
  return { provider: index % 2 ? 'codex' : 'claude', session_id: `session-${index % 3}`,
    project_key: `project-${index % 2}`, project_name: `Project ${index % 2}`, session_name: 'Fixture',
    root_turn_id: `request-${index}`, started_at_ms: index % 11 ? first + index % 5 * 86400000 + index * 900000 : null,
    duration_ms: index % 3 ? 1000 + index : null, duration_quality: index % 3 ? 'exact' : 'missing',
    input_tokens: input, output_tokens: output, total_tokens: input + output,
    cache_write_input_tokens: null, cache_read_input_tokens: 0,
    status: index % 4 === 0 ? 'in_progress' : index % 4 === 1 ? 'failed' : 'completed',
    updated_at: '2026-11-10T00:00:00.000Z', billing: index % 2 ? 'api' : 'subscription',
    model_usage: models.length ? models : undefined,
    capability_usage: [{ category: 'skill', name: `skill-${index % 3}`, usage_count: 1 }] };
}

function replacement(rows, extra = {}) {
  return { sessions: [...new Map(rows.map(item => [canonical([item.provider, item.session_id]),
    { provider: item.provider, session_id: item.session_id }])).values()],
  summaries: rows, files: [], scanId: 'query-minimize-validation', ...extra };
}

function snapshot(db) {
  return canonical(db.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all().map(({ name }) => [name, db.connection.prepare(`SELECT * FROM ${name}`).all()
      .map(item => Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)))]));
}

function paired(action) {
  const databases = Object.fromEntries(Object.entries(apis).map(([key, api]) => [key, new api.Database(':memory:')]));
  try {
    for (const db of Object.values(databases)) db.queryUsagePage({}, 'day', zone, { limit: 100 });
    const result = action(databases);
    assert.equal(snapshot(databases.A), snapshot(databases.B), 'Exact persisted values including IDs');
    for (const db of Object.values(databases)) {
      assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
      assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    }
    return result;
  } finally { for (const db of Object.values(databases)) db.close(); }
}

const boundaries = [0, 1, 31, 32, 33, 64, 65].map(size => paired(databases => {
  const rows = Array.from({ length: size }, (_, index) => row(index));
  let checks = 0;
  for (const variant of ['A', 'B']) {
    databases[variant].replaceMemory(replacement(rows));
    checks += verifyAggregates(databases[variant], apis[variant], rows);
  }
  return { requests: size, independentAggregateChecks: checks, exactIdsAndChildren: true };
}));

const mixed = paired(databases => {
  const seed = Array.from({ length: 65 }, (_, index) => row(index));
  for (const db of Object.values(databases)) db.replaceMemory(replacement(seed));
  const rows = [row(100), seed[0], row(101), { ...seed[1], request_title: 'Changed fixture title' },
    row(102), ...seed.slice(2)];
  for (const db of Object.values(databases)) db.replaceMemory(replacement(rows));
  let consumptions = 0, expectedConsumptions = 0;
  const once = values => {
    if (values === undefined) return undefined;
    expectedConsumptions++;
    return { [Symbol.iterator]() {
      consumptions++; let index = 0;
      return { next: () => index < values.length ? { value: values[index++], done: false } : { done: true } };
    } };
  };
  for (const db of Object.values(databases)) {
    const additions = Array.from({ length: 33 }, (_, offset) => row(200 + offset));
    const singleUseRows = additions.map(item => ({ ...item, model_usage: once(item.model_usage),
      capability_usage: once(item.capability_usage) }));
    db.replaceMemory(replacement(singleUseRows, { summaries: once(singleUseRows) }));
    const before = snapshot(db);
    db.connection.exec(`CREATE TEMP TRIGGER fail_new_model BEFORE INSERT ON turn_model_usage
      WHEN NEW.model='fail-model' BEGIN SELECT RAISE(ABORT,'query-minimize failure'); END;`);
    const failing = Array.from({ length: 33 }, (_, offset) => row(300 + offset));
    failing[17].model_usage = [{ model: 'fail-model', input_tokens: 30, output_tokens: 3,
      cache_write_input_tokens: null, cache_read_input_tokens: 0 }];
    assert.throws(() => db.replaceMemory(replacement(failing)), /query-minimize failure/);
    assert.equal(snapshot(db), before, 'All parent, child and rollup writes roll back');
    db.connection.exec('DROP TRIGGER fail_new_model');
    db.replaceMemory(replacement(failing.map((item, index) => index === 17 ? row(317) : item)));
  }
  assert.equal(consumptions, expectedConsumptions);
  return { mixedNewExistingOrder: true, singleUseIterableConsumptions: consumptions,
    childFailureRollbackAndRetry: true };
});

const boundariesAndFilters = paired(databases => {
  const rows = Array.from({ length: 65 }, (_, index) => row(index));
  for (const db of Object.values(databases)) db.replaceMemory(replacement(rows));
  let comparisons = 0;
  for (const timezone of ['Asia/Seoul', 'America/New_York']) {
    for (const unknownTime of ['include', 'exclude', 'only']) {
      for (const by of ['provider', 'model']) for (const group of ['day', 'month', 'session', 'project']) {
        const filter = { fromMs: first + 1234567, toMs: first + 2 * 86400000 + 7654321,
          unknownTime, excludeEmptyUsage: true };
        const actual = [];
        for (const variant of ['A', 'B']) {
          const db = databases[variant], page = db.queryUsagePage(filter, group, timezone, { limit: 1000 }, by);
          const raw = apis[variant].raw(filter, group, timezone, by);
          const expected = db.connection.prepare(raw.sql).all(...raw.values, 1000, 0);
          assert.equal(canonical(page.rows), canonical(expected), 'Partial dates agree with raw aggregation');
          const empty = db.queryUsagePage(filter, group, timezone, { limit: 100, offset: 100000 }, by);
          assert.deepEqual(empty.rows, []); assert.equal(empty.total, page.total);
          actual.push(page); comparisons++;
        }
        assert.equal(canonical(actual[0]), canonical(actual[1]), 'Partial dates and unknown policy A/B');
      }
    }
  }
  return { comparisons, partialDateUnionAll: true, unknownPolicies: 3, timezones: 2, emptyPageTotals: true };
});

const report = { dateSeoul: '2026-11-10', runnerSha256: hash(fs.readFileSync(__filename)),
  products: Object.fromEntries(Object.entries(options).filter(([name]) => ['before', 'after'].includes(name))
    .map(([name, directory]) => [name, Object.fromEntries(['src/summary/db/memoryStore.ts',
      'src/summary/db/queries/rollup/source.ts', 'dist/src/summary/db/memoryStore.js',
      'dist/src/summary/db/queries/rollup/source.js'].map(file => [file, hash(fs.readFileSync(join(directory, file)))]))])),
  scope: 'Correctness checks for the explicitly requested query A/B; no general test suite',
  boundaries, mixed, boundariesAndFilters };
fs.mkdirSync(dirname(options.output), { recursive: true });
fs.writeFileSync(options.output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
console.log(`A/B boundary validation passed: ${boundaries.length} batch sizes, ${boundariesAndFilters.comparisons} filtered comparisons.`);
