// Compare the frozen pre-change public database API with the actual product implementation.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { backup } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const raw = require('../../dist/src/summary/db/queries');
const { buildRollupUsageQueries } = require('../../dist/src/summary/db/rollup-queries');
const { calendarPeriod, periodBounds } = require('../../dist/src/summary/db/timezone');
const { seed, compareResults } = require('./sql-rollup.cjs');
const { workloads, stats } = require('./sql-explain.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const variants = ['before', 'product-rollup'];
const sha = value => createHash('sha256').update(value).digest('hex');

function optionsFor(args) {
  const options = { sizes: [280, 100000], turns: [10, 100], samples: 3, warmup: 1,
    baseline: undefined, output: resolve(root, 'docs/benchmarks/SqlRollupProductBenchmark-2026-10-15.json') };
  for (const arg of args) {
    if (arg.startsWith('--baseline=')) options.baseline = resolve(arg.slice(11));
    else if (arg.startsWith('--sizes=')) options.sizes = arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--turns=')) options.turns = arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--samples=')) options.samples = Number(arg.slice(10));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else throw new Error(`Unknown option: ${arg}`);
  }
  assert.ok(options.baseline, '--baseline must name the preserved source/dist snapshot directory');
  assert.ok(options.sizes.every(n => Number.isInteger(n) && n > 0 && n <= 1000000));
  assert.ok(options.turns.every(n => Number.isInteger(n) && n > 0 && n <= 10000));
  assert.ok(Number.isInteger(options.samples) && options.samples >= 3 && options.samples <= 15);
  return options;
}

function publicRead(db, spec) {
  const start = performance.now();
  if (spec.cumulative) {
    const result = db.queryCumulative(spec.filter, spec.by, 0);
    return { rows: result.rows, total: result.total, bundleMs: performance.now() - start };
  }
  const rows = db.queryUsage(spec.filter, spec.groupBy, timezone, { limit: 100, sortBy: spec.sortBy }, spec.by);
  const middle = performance.now();
  const total = db.queryUsageCount(spec.filter, spec.groupBy, timezone, spec.by);
  const end = performance.now();
  return { rows, total, rowsMs: middle - start, countMs: end - middle, bundleMs: end - start };
}

function compare(a, b, name) {
  assert.equal(a.total, b.total, `${name}: count`);
  return compareResults(a.rows, b.rows, name);
}

function explain(db, query, page) {
  const values = page ? [...query.values, 100, 0] : query.values;
  const steps = db.connection.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...values);
  const bytecode = db.connection.prepare(`EXPLAIN ${query.sql}`).all(...values), opcodes = {};
  for (const row of bytecode) opcodes[row.opcode] = (opcodes[row.opcode] || 0) + 1;
  return { sql: query.sql, steps: steps.map(({ id, parent, detail }) => ({ id, parent, detail })),
    instructions: bytecode.length, opcodes };
}

function measureRead(dbs, spec, options, beforeQueries) {
  const initial = dbs.map(db => publicRead(db, spec));
  const digest = compare(initial[0], initial[1], spec.name);
  let fullGroupDigest, plans;
  if (!spec.cumulative) {
    const a = beforeQueries.buildUsageQuery(spec.filter, spec.groupBy, timezone, spec.by, spec.sortBy);
    const b = buildRollupUsageQueries(spec.filter, spec.groupBy, timezone, spec.by, spec.sortBy);
    const chosen = b || { rows: raw.buildUsageQuery(spec.filter, spec.groupBy, timezone, spec.by, spec.sortBy),
      count: raw.buildUsageCountQuery(spec.filter, spec.groupBy, timezone, spec.by) };
    const fullA = dbs[0].connection.prepare(a.sql).all(...a.values, 10000000, 0);
    const fullB = dbs[1].connection.prepare(chosen.rows.sql).all(...chosen.rows.values, 10000000, 0);
    fullGroupDigest = compareResults(fullA, fullB, `${spec.name} all groups`);
    assert.equal(fullA.length, initial[0].total);
    plans = { before: { rows: explain(dbs[0], a, true), count: explain(dbs[0],
      beforeQueries.buildUsageCountQuery(spec.filter, spec.groupBy, timezone, spec.by), false) },
    product: { mode: b?.mode || 'raw-fallback', rows: explain(dbs[1], chosen.rows, true), count: explain(dbs[1], chosen.count, false) } };
  }
  const iterations = Math.min(20, Math.max(1, Math.ceil(8 / Math.max(...initial.map(v => v.bundleMs), .01))));
  for (const db of dbs) for (let i = 0; i < options.warmup; i++) publicRead(db, spec);
  const samples = dbs.map(() => ({ bundle: [], rows: [], count: [] }));
  for (let i = 0; i < options.samples; i++) for (const variant of i % 2 ? [1, 0] : [0, 1]) {
    let bundle = 0, rows = 0, count = 0;
    for (let j = 0; j < iterations; j++) {
      const value = publicRead(dbs[variant], spec);
      bundle += value.bundleMs; rows += value.rowsMs || 0; count += value.countMs || 0;
    }
    samples[variant].bundle.push(bundle / iterations);
    samples[variant].rows.push(rows / iterations); samples[variant].count.push(count / iterations);
  }
  compare(publicRead(dbs[0], spec), publicRead(dbs[1], spec), `${spec.name} after timed reads`);
  const measured = Object.fromEntries(variants.map((v, i) => [v, { bundle: stats(samples[i].bundle),
    ...(spec.cumulative ? {} : { rows: stats(samples[i].rows), count: stats(samples[i].count) }) }]));
  return { name: spec.name, groupBy: spec.groupBy, by: spec.by, cumulative: !!spec.cumulative,
    pageDigest: digest, fullGroupDigest, totalGroups: initial[0].total, iterationsPerSample: iterations,
    variants: measured, percentChange: (measured['product-rollup'].bundle.medianMs / measured.before.bundle.medianMs - 1) * 100,
    plans };
}

function space(db, path) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pageSize = db.connection.prepare('PRAGMA page_size').get().page_size;
  const pageCount = db.connection.prepare('PRAGMA page_count').get().page_count;
  const freePages = db.connection.prepare('PRAGMA freelist_count').get().freelist_count;
  return { allocatedBytes: pageSize * pageCount, liveBytes: pageSize * (pageCount - freePages), fileBytes: statSync(path).size,
    objects: db.connection.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY name').all() };
}

function sessionInput(db) {
  const session = db.connection.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  const rows = db.connection.prepare('SELECT t.*,p.project_name,s.session_name FROM turn_summary t JOIN projects p USING(project_key) JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id WHERE t.provider=? AND t.session_id=? ORDER BY t.id').all(session.provider, session.session_id);
  const models = db.connection.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  return { sessions: [session], files: [], summaries: rows.map(({ id, ...row }) => {
    const model_usage = models.all(id); return { ...row, model_usage: model_usage.length ? model_usage : undefined };
  }) };
}

function writeOne(db, input, path) {
  const exec = db.connection.exec;
  let begin = 0, commit = 0;
  db.connection.exec = function(sql) {
    if (sql.trim() === 'BEGIN IMMEDIATE') begin++;
    if (sql.trim() === 'COMMIT') commit++;
    return exec.call(this, sql);
  };
  const start = performance.now(); let elapsedMs;
  try { db.replaceSessions(input); elapsedMs = performance.now() - start; }
  finally { db.connection.exec = exec; }
  assert.equal(begin, 1); assert.equal(commit, 1);
  let walBytes = 0;
  try { walBytes = statSync(`${path}-wal`).size; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { elapsedMs, beginImmediate: begin, commits: commit, walBytes };
}

function measureWrites(dbs, paths, options) {
  const input = sessionInput(dbs[0]), appended = structuredClone(input);
  const extra = structuredClone(input.summaries.at(-1));
  extra.root_turn_id = 'appended-product-turn'; extra.started_at_ms = Date.UTC(2026, 9, 15);
  appended.summaries.push(extra);
  const result = [];
  for (const [name, value] of [['replace-same-session', input], ['append-one-turn', appended]]) {
    const samples = [[], []];
    for (let i = 0; i < options.samples; i++) for (const variant of i % 2 ? [1, 0] : [0, 1]) {
      dbs[variant].replaceSessions(input);
      dbs[variant].connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      samples[variant].push(writeOne(dbs[variant], value, paths[variant]));
    }
    for (const by of ['provider', 'model']) compare(publicRead(dbs[0], { filter: {}, groupBy: 'total', by }),
      publicRead(dbs[1], { filter: {}, groupBy: 'total', by }), `post ${name} ${by}`);
    const values = Object.fromEntries(variants.map((v, i) => [v, { latency: stats(samples[i].map(s => s.elapsedMs)), samples: samples[i] }]));
    result.push({ name, inputTurns: value.summaries.length, variants: values,
      percentChange: (values['product-rollup'].latency.medianMs / values.before.latency.medianMs - 1) * 100 });
  }
  return result;
}

async function main() {
  const options = optionsFor(process.argv.slice(2)), manifest = JSON.parse(readFileSync(join(options.baseline, 'manifest.json'), 'utf8'));
  const Before = require(join(options.baseline, 'dist/src/summary/db')).SummaryDatabase;
  const beforeQueries = require(join(options.baseline, 'dist/src/summary/db/queries'));
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-product-rollup-'));
  const sourcePaths = ['src/summary/db/schema.ts', 'src/summary/db/connection.ts', 'src/summary/db/reader.ts',
    'src/summary/db/queries.ts', 'src/summary/db/rollup-state.ts', 'src/summary/db/rollup-queries.ts', 'src/summary/db/rollups.ts',
    'src/summary/db/sessions.ts', 'src/summary/db/manifest.ts', 'tests/benchmarks/sql-rollup-product.cjs', 'tests/benchmarks/sql-rollup.cjs'];
  const report = { createdAtSeoul: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date()),
    environment: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform, arch: process.arch },
    baseline: { head: manifest.head, sourceSha256: manifest.sourceSha256 },
    sourceSha256: Object.fromEntries(sourcePaths.map(p => [p, sha(readFileSync(join(root, p)))])),
    method: { sizes: options.sizes, turnsPerSession: options.turns, samples: options.samples, warmup: options.warmup,
      pageLimit: 100, timezone, scope: 'Actual public queryUsage + queryUsageCount and queryCumulative; includes SQL preparation, rollup snapshot/metadata checks. Fixtures/full-group verification/EXPLAIN/UI/parser excluded. Alternating warm-cache variants.',
      firstQuery: 'first public provider total query + COUNT; product includes lazy rollup backfill, warm OS cache; single observation',
      writes: 'actual replaceSessions with already initialized rollups; BEGIN IMMEDIATE + COMMIT once; preparation/restoration and TRUNCATE checkpoint excluded; wal_autocheckpoint=0',
      memory: 'shared-process RSS observations include correctness/fixtures and do not isolate A/B peak',
      note: 'Frozen pre-change dist API is the baseline, not the current raw builder presented as an old product. Original benchmark artifacts preserved.' }, datasets: [] };
  try {
    for (const size of options.sizes) for (const turns of options.turns) {
      const label = `synthetic-${size}-turns-${turns}`, paths = variants.map(v => join(directory, `${label}-${v}.sqlite`));
      const base = new Before(join(directory, `${label}-seed.sqlite`));
      try { seed(base, size, turns); for (const path of paths) await backup(base.connection, path); } finally { base.close(); }
      const dbs = [new Before(paths[0]), new SummaryDatabase(paths[1])];
      try {
        for (const db of dbs) db.connection.exec('PRAGMA wal_autocheckpoint=0; ANALYZE');
        report.environment.sqlite = dbs[1].connection.prepare('SELECT sqlite_version() v').get().v;
        const beforeFirst = space(dbs[0], paths[0]), productBeforeFirst = space(dbs[1], paths[1]);
        const firstSpec = { filter: { excludeEmptyUsage: true }, groupBy: 'total', by: 'provider' };
        const first = dbs.map(db => publicRead(db, firstSpec)); compare(first[0], first[1], 'first query');
        const dataset = { label, requestFacts: size, turnsPerSession: turns, schema: dbs.map(db => db.connection.prepare('PRAGMA user_version').get().user_version),
          firstQueryMs: Object.fromEntries(variants.map((v, i) => [v, first[i].bundleMs])),
          spaceBeforeFirst: { before: beforeFirst, product: productBeforeFirst },
          space: Object.fromEntries(dbs.map((db, i) => [variants[i], space(db, paths[i])])),
          rollupRows: { request: dbs[1].connection.prepare('SELECT count(*) n FROM usage_request_daily').get().n,
            model: dbs[1].connection.prepare('SELECT count(*) n FROM usage_model_daily').get().n },
          facts: { sessions: dbs[0].connection.prepare('SELECT count(*) n FROM sessions').get().n,
            models: dbs[0].connection.prepare('SELECT count(*) n FROM turn_model_usage').get().n,
            modelJoinInputs: dbs[0].connection.prepare('SELECT count(*) n FROM turn_summary t LEFT JOIN turn_model_usage m ON m.turn_id=t.id').get().n }, reads: [] };
        const latest = dbs[0].connection.prepare('SELECT max(started_at_ms) latest FROM turn_summary').get().latest;
        const bounds = periodBounds(calendarPeriod(latest, timezone, 'day'), timezone);
        const specs = [...workloads(dbs[0]), { name: 'day-7-aligned-provider', by: 'provider', groupBy: 'day',
          filter: { fromMs: bounds.toMs - 7 * 86400000, toMs: bounds.toMs, excludeEmptyUsage: true, unknownTime: 'exclude' } }];
        for (const spec of specs) {
          if (spec.name === 'project-average-provider') spec.sortBy = 'averageTokens';
          const value = measureRead(dbs, spec, options, beforeQueries); dataset.reads.push(value);
          console.log(`${label} ${spec.name}: ${value.variants.before.bundle.medianMs.toFixed(3)} -> ${value.variants['product-rollup'].bundle.medianMs.toFixed(3)} ms (${value.percentChange.toFixed(2)}%)`);
          await new Promise(resolveNext => setImmediate(resolveNext));
        }
        for (const by of ['provider', 'model']) dataset.reads.push(measureRead(dbs,
          { name: `cumulative-${by}`, cumulative: true, filter: { excludeEmptyUsage: true }, groupBy: 'total', by }, options, beforeQueries));
        dataset.writes = measureWrites(dbs, paths, options);
        dataset.observedSharedProcess = { rssBytes: process.memoryUsage().rss, lifetimePeakBytes: process.resourceUsage().maxRSS * 1024 };
        report.datasets.push(dataset);
        await mkdir(dirname(options.output), { recursive: true }); await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
      } finally { dbs.forEach(db => db.close()); }
    }
    console.log(`Saved ${options.output}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-product-rollup-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
