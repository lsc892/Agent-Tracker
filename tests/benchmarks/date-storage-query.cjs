// 날짜 미상 OR 조건의 분리·특수화를 현재 제품 SQL과 비교한다.
const assert = require('node:assert/strict');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildRollupUsageQueries } = require('../../dist/src/summary/db/rollup-queries');
const { calendarPeriod, periodBounds } = require('../../dist/src/summary/db/timezone');
const { seed, compareResults } = require('./sql-rollup.cjs');
const { stats } = require('./sql-explain.cjs');

const variants = ['current-or', 'disjoint-union', 'specialized-union'];
const timezone = 'Asia/Seoul', day = 86400000;
const root = resolve(__dirname, '../..');
const references = [
  { url: 'https://www.sqlite.org/optoverview.html#or_optimizations', reason: 'OR terms may already use separate indexes; the cost-based planner can choose a scan.' },
  { url: 'https://www.sqlite.org/optoverview.html#subquery_flattening', reason: 'A compound subquery inside an aggregate cannot always be flattened; UNION ALL has overhead.' },
  { url: 'https://www.sqlite.org/eqp.html', reason: 'SEARCH, SCAN, temporary GROUP BY/ORDER BY and compound query plans.' },
];

function optionsFor(args) {
  const options = { sizes: [1000, 100000], turnsPerSession: 10, samples: 9, warmup: 3,
    output: resolve(root, 'docs/benchmarks/DateStorageQuery-2026-10-25.json') };
  for (const arg of args) {
    if (arg.startsWith('--sizes=')) options.sizes = arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--samples=')) options.samples = Number(arg.slice(10));
    else if (arg.startsWith('--warmup=')) options.warmup = Number(arg.slice(9));
    else if (arg.startsWith('--turns-per-session=')) options.turnsPerSession = Number(arg.slice(20));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else throw new Error(`Unknown option ${arg}`);
  }
  assert.ok(options.sizes.length && options.sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000));
  assert.ok(Number.isSafeInteger(options.turnsPerSession) && options.turnsPerSession > 0);
  assert.ok(Number.isSafeInteger(options.samples) && options.samples >= 3 && options.samples <= 31);
  assert.ok(Number.isSafeInteger(options.warmup) && options.warmup >= 1);
  return options;
}

/** Benchmark-only rewrite of the exact generated first rollup SELECT, preserving outer aggregation and raw boundaries. */
function rewrite(query, variant) {
  if (variant === 'current-or') return query;
  const pattern = /SELECT (provider,project_key,session_id,local_day[\s\S]*?) FROM (usage_(?:request|model)_daily) AS turn_summary\s+WHERE ([\s\S]*?) AND \(\(([^)]*?)\) OR local_day = ''\)/;
  const match = pattern.exec(query.sql);
  if (!match) return { ...query, changed: false };
  const [, columns, table, dimensions, known] = match;
  // The generated first source has no earlier bindings. Assert rather than silently misbinding after a future builder change.
  assert.equal((query.sql.slice(0, match.index).match(/\?/g) || []).length, 0);
  const dimensionCount = (dimensions.match(/\?/g) || []).length;
  const knownCount = (known.match(/\?/g) || []).length;
  const dimensionValues = query.values.slice(0, dimensionCount);
  const from = `SELECT ${columns} FROM ${table} AS turn_summary WHERE ${dimensions}`;
  const noKnown = /\b0 = 1\b/.test(known);
  const allKnown = known === "local_day <> ''";
  if (variant === 'specialized-union' && allKnown) {
    return { sql: query.sql.replace(match[0], from), values: [...query.values], changed: true };
  }
  if (variant === 'specialized-union' && noKnown) {
    assert.equal(knownCount, 0);
    return { sql: query.sql.replace(match[0], `${from} AND local_day = ''`), values: [...query.values], changed: true };
  }
  const replacement = `${from} AND (${known}) UNION ALL ${from} AND local_day = ''`;
  return { sql: query.sql.replace(match[0], replacement),
    values: [...query.values.slice(0, dimensionCount + knownCount), ...dimensionValues, ...query.values.slice(dimensionCount + knownCount)], changed: true };
}

function workloads(db) {
  const latest = db.connection.prepare('SELECT max(started_at_ms) n FROM turn_summary').get().n;
  const end = periodBounds(calendarPeriod(latest, timezone, 'day'), timezone).toMs;
  const week = { fromMs: end - 7 * day, toMs: end };
  const project = db.connection.prepare('SELECT provider,project_key FROM turn_summary GROUP BY provider,project_key ORDER BY count(*) DESC,provider,project_key LIMIT 1').get();
  const cases = [
    ['all-day-provider', 'day', 'provider', {}],
    ['all-total-model', 'total', 'model', {}],
    ['week-day-provider', 'day', 'provider', week],
    ['week-day-model', 'day', 'model', week],
    ['week-project-model', 'project', 'model', { ...week, provider: project.provider, projectKey: project.project_key, unknownTime: 'include' }],
    ['week-known-control', 'day', 'provider', { ...week, unknownTime: 'exclude' }],
    ['only-unknown', 'day', 'model', { ...week, unknownTime: 'only' }],
    ['partial-day-provider', 'day', 'provider', { fromMs: week.fromMs + 9 * 3600000, toMs: end - 3 * 3600000 }],
    ['partial-day-model', 'day', 'model', { fromMs: week.fromMs + 9 * 3600000, toMs: end - 3 * 3600000 }],
  ];
  return cases.map(([name, grouping, by, filter]) => ({ name, grouping, by,
    diagnosticOnly: filter.unknownTime === 'only',
    filter: { providers: ['claude', 'codex'], excludeEmptyUsage: true, ...filter } }));
}

function prepared(db, queries) {
  const rows = db.connection.prepare(queries.rows.sql), count = db.connection.prepare(queries.count.sql);
  const rowValues = [...queries.rows.values, 100, 0], countValues = queries.count.values;
  const explain = (sql, values) => db.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => row.detail);
  return { rows, count, rowValues, countValues,
    sql: { rows: queries.rows.sql, rowValues, count: queries.count.sql, countValues },
    changed: Boolean(queries.rows.changed),
    plan: { rows: explain(queries.rows.sql, rowValues), count: explain(queries.count.sql, countValues) } };
}

function execute(db, query) {
  const start = performance.now();
  db.connection.exec('SAVEPOINT date_query_page');
  try {
    const rows = query.rows.all(...query.rowValues);
    const total = query.count.get(...query.countValues).count;
    db.connection.exec('RELEASE date_query_page');
    return { rows, total, ms: performance.now() - start };
  } catch (error) {
    db.connection.exec('ROLLBACK TO date_query_page; RELEASE date_query_page');
    throw error;
  }
}

function measure(db, spec, options) {
  const base = buildRollupUsageQueries(spec.filter, spec.grouping, timezone, spec.by);
  assert.ok(base);
  const queries = variants.map(variant => prepared(db, { rows: rewrite(base.rows, variant), count: rewrite(base.count, variant) }));
  const initial = queries.map(query => execute(db, query));
  const publicResult = db.queryUsagePage(spec.filter, spec.grouping, timezone, { limit: 100 }, spec.by);
  assert.equal(publicResult.total, initial[0].total);
  compareResults(publicResult.rows, initial[0].rows, `${spec.name} product API`);
  // Validate every group, not just the timed first page. Digest includes tolerant float normalization from existing helper.
  const full = queries.map(query => query.rows.all(...query.rowValues.slice(0, -2), 10000000, 0));
  const digests = queries.map((query, i) => {
    assert.equal(initial[i].total, initial[0].total);
    assert.equal(full[i].length, initial[i].total);
    compareResults(initial[0].rows, initial[i].rows, `${spec.name} page ${variants[i]}`);
    return compareResults(full[0], full[i], `${spec.name} all groups ${variants[i]}`);
  });
  const iterations = Math.min(20, Math.max(1, Math.ceil(12 / Math.max(...initial.map(value => value.ms), 0.01))));
  for (const query of queries) for (let i = 0; i < options.warmup; i++) execute(db, query);
  const samples = variants.map(() => []);
  for (let i = 0; i < options.samples; i++) {
    // Rotate the first variant and reverse alternate samples, balancing position across nine samples.
    const order = variants.map((_, j) => (i + j) % variants.length);
    if (i % 2) order.reverse();
    for (const index of order) {
      let elapsed = 0;
      for (let j = 0; j < iterations; j++) elapsed += execute(db, queries[index]).ms;
      samples[index].push(elapsed / iterations);
    }
  }
  const result = variants.map((variant, i) => ({ variant, changed: queries[i].changed, ...stats(samples[i]),
    samplesMs: samples[i], fullGroupsDigest: digests[i], plan: queries[i].plan, query: queries[i].sql }));
  const baseline = result[0].medianMs;
  for (const item of result) {
    item.speedup = baseline / item.medianMs;
    item.reductionPercent = (1 - item.medianMs / baseline) * 100;
  }
  return { ...spec, mode: base.mode, totalGroups: full[0].length, iterations, variants: result };
}

async function main(args = process.argv.slice(2)) {
  const options = optionsFor(args), directory = await mkdtemp(join(tmpdir(), 'agent-tracker-date-query-'));
  const report = { measuredAt: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date()),
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length },
    options, references,
    scope: 'Benchmark-only generated SQL rewrite; current product schema and facts, identical connection and warm caches. Rows+count+SAVEPOINT are timed with prepared SQL; SQL generation/preparation and rollup construction are excluded. Not end-to-end UI/worker latency, not cold filesystem-cache latency.',
    storage: 'No persistent table/index changes; zero added persistent bytes or write-maintenance cost. Query scratch space is not measured.',
    diagnosticWorkload: 'unknownTime=only is supported by the internal DB API but is not exposed by the current usage UI input parser; its speedup is not a current user-visible UI speedup.',
    datasets: [] };
  try {
    for (const size of options.sizes) {
      const db = new SummaryDatabase(join(directory, `${size}.sqlite`));
      try {
        seed(db, size, options.turnsPerSession);
        db.queryUsagePage({}, 'day', timezone, { limit: 100 });
        db.connection.exec('ANALYZE');
        report.environment.sqlite = db.connection.prepare('SELECT sqlite_version() n').get().n;
        report.datasets.push({ rawRows: size, turnsPerSession: options.turnsPerSession,
          rollupRows: db.connection.prepare('SELECT count(*) n FROM usage_request_daily').get().n,
          modelRollupRows: db.connection.prepare('SELECT count(*) n FROM usage_model_daily').get().n,
          unknownTimeFacts: db.connection.prepare('SELECT count(*) n FROM turn_summary WHERE started_at_ms IS NULL').get().n,
          reads: workloads(db).map(spec => measure(db, spec, options)) });
      } finally { db.close(); }
    }
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved ${options.output}; all full-group, count and public API results matched`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-date-query-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { optionsFor, rewrite, workloads, measure };
