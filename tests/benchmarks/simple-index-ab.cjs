// 같은 제품 빌드와 DB 사본에서 작은 보조 인덱스의 공개 조회·저장·공간 비용을 비교한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { resolve, join, dirname, basename } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync, backup } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const raw = require('../../dist/src/summary/db/queries');
const { buildRollupUsageQueries } = require('../../dist/src/summary/db/rollup-queries');
const { periodBounds } = require('../../dist/src/summary/db/timezone');
const { syntheticRows, normalize, factsHash } = require('./inline-cost-ab.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul', DAY = 86400000;
const variants = [
  { name: 'current', sql: '' },
  { name: 'raw-session-time', sql: 'CREATE INDEX bench_summary_session_time ON turn_summary(provider,session_id,started_at_ms);' },
  { name: 'daily-session-min', sql: 'CREATE INDEX bench_daily_session_min ON usage_request_daily(provider,session_id,min_started_at_ms);' },
  { name: 'raw-provider-time', sql: 'CREATE INDEX bench_summary_provider_time ON turn_summary(provider,started_at_ms);' },
  { name: 'shared-session-time', sql: 'CREATE INDEX bench_summary_session_time ON turn_summary(provider,session_id,started_at_ms);', rewriteSessionStart: true },
];
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isInteger(item)
  ? Number(item.toPrecision(12)) : item);
const digest = rows => hash(canonical(rows.map(normalize)));
const seoulTime = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { medianMs: sorted[Math.floor(sorted.length / 2)], minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values };
}
function order(pair) {
  const rotated = variants.map((_v, i) => (i + Math.floor(pair / 2)) % variants.length);
  return pair % 2 ? rotated.reverse() : rotated;
}
function optionsFor(args) {
  const options = { output: resolve(root, 'tests/results/benchmarks/simple-index-ab.json'), smoke: false,
    realDb: join(process.env.APPDATA, 'Code/User/globalStorage/agenttracker.agent-tracker/agent-tracker.sqlite'), samples: 9, iterations: 2, writeSamples: 5 };
  for (const arg of args) {
    if (arg === '--smoke') Object.assign(options, { smoke: true, samples: 3, iterations: 1, writeSamples: 3 });
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else if (arg.startsWith('--real-db=')) options.realDb = resolve(arg.slice(10));
    else throw new Error(`Unknown option ${arg}`);
  }
  assert.ok(!fs.existsSync(options.output), 'Use a new output path');
  return options;
}
function sourceHashes() {
  const files = ['package-lock.json', 'tests/benchmarks/simple-index-ab.cjs', 'tests/benchmarks/inline-cost-ab.cjs', 'tests/benchmarks/cost-storage.cjs'];
  for (const directory of ['src', 'dist/src']) for (const path of fs.readdirSync(join(root, directory), { recursive: true })) {
    if (/\.(ts|js)$/.test(path)) files.push(join(directory, path).replaceAll('\\', '/'));
  }
  return Object.fromEntries(files.sort().map(path => [path, hash(fs.readFileSync(join(root, path)))]));
}
function integrity(db) {
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}
function space(db, path) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return { fileBytes: fs.statSync(path).size,
    objects: db.connection.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY name').all() };
}
function workload(db) {
  const c = db.connection, latest = c.prepare('SELECT max(started_at_ms) n FROM turn_summary').get().n;
  const day = new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(latest);
  const end = periodBounds(day, timezone).toMs;
  const session = c.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  const project = c.prepare('SELECT provider,project_key FROM turn_summary GROUP BY provider,project_key ORDER BY count(*) DESC,provider,project_key LIMIT 1').get();
  const result = [];
  for (const includeCosts of [false, true]) for (const by of ['provider', 'model']) {
    const base = { providers: ['claude', 'codex'], includeCosts, excludeEmptyUsage: true };
    const add = (label, group, filter = base) => result.push({ name: `${includeCosts ? 'costs' : 'tokens'}/${label}/${by}`, group, by, filter });
    for (const group of ['day', 'month', 'project', 'session']) add(group, group);
    add('week-total', 'total', { ...base, fromMs: end - 7 * DAY, toMs: end, unknownTime: 'exclude' });
    add('month-total', 'total', { ...base, fromMs: end - 30 * DAY, toMs: end, unknownTime: 'exclude' });
    add('one-project-month', 'month', { ...base, provider: project.provider, projectKey: project.project_key, fromMs: end - 30 * DAY, toMs: end, unknownTime: 'exclude' });
    add('one-session', 'session', { ...base, provider: session.provider, sessionId: session.session_id });
    add('one-session-month', 'session', { ...base, provider: session.provider, sessionId: session.session_id, fromMs: end - 30 * DAY, toMs: end, unknownTime: 'exclude' });
    add('turns', 'turn');
  }
  return result;
}
const sort = { key: 'period', direction: 'desc' };
function page(db, spec) {
  return db.queryUsagePage(spec.filter, spec.group, timezone, { limit: 100, tableSort: sort }, spec.by);
}
function sqlFor(spec) {
  if (spec.group === 'turn') {
    const rows = raw.buildTurnsQuery(raw.buildQueryFilter(spec.filter), spec.filter.includeCosts, spec.by, true, sort);
    const count = raw.buildTurnsCountQuery(spec.filter, spec.by);
    return { mode: 'raw-detail', rows: { ...rows, args: [...rows.values, 0, 100, 0] }, count: { ...count, args: count.values } };
  }
  const queries = buildRollupUsageQueries(spec.filter, spec.group, timezone, spec.by, undefined, sort) ?? {
    mode: 'raw', rows: raw.buildUsageQuery(spec.filter, spec.group, timezone, spec.by, undefined, sort),
    count: raw.buildUsageCountQuery(spec.filter, spec.group, timezone, spec.by),
  };
  return { mode: queries.mode, rows: { ...queries.rows, args: [...queries.rows.values, 100, 0] }, count: { ...queries.count, args: queries.count.values } };
}
function rewriteSql(sql, variant) {
  if (!variant.rewriteSessionStart) return sql;
  // Preserve the all-time session minimum while sharing the request time index with cost queries.
  return sql.replace(/SELECT MIN\(d\.min_started_at_ms\)\s+FROM usage_request_daily d\s+WHERE d\.provider = turn_summary\.provider AND d\.session_id = turn_summary\.session_id/g,
    'SELECT MIN(d.started_at_ms) FROM turn_summary d WHERE d.provider = turn_summary.provider AND d.session_id = turn_summary.session_id');
}
function readMeasurements(dbs, options) {
  return workload(dbs[0]).map(spec => {
    const expected = page(dbs[0], spec), queries = sqlFor(spec);
    const args = [...queries.rows.args]; args[args.length - 2] = 10000000;
    const allRows = dbs.map(db => db.connection.prepare(queries.rows.sql).all(...args));
    const fullHash = digest(allRows[0]);
    dbs.forEach((db, i) => {
      assert.equal(digest(allRows[i]), fullHash, `${spec.name} full rows`);
      const actual = page(db, spec);
      assert.equal(actual.total, expected.total);
      assert.equal(digest(actual.rows), digest(expected.rows));
      assert.equal(actual.total, allRows[i].length);
      for (let warmup = 0; warmup < 2; warmup++) page(db, spec);
    });
    const samples = dbs.map(() => []);
    for (let pair = 0; pair < options.samples; pair++) for (const i of order(pair)) {
      global.gc?.();
      const start = performance.now(); let actual;
      for (let repeat = 0; repeat < options.iterations; repeat++) actual = page(dbs[i], spec);
      samples[i].push((performance.now() - start) / options.iterations);
      assert.equal(actual.total, expected.total); assert.equal(digest(actual.rows), digest(expected.rows));
    }
    return { name: spec.name, mode: queries.mode, groups: expected.total, fullResultSha256: fullHash,
      sql: { rows: queries.rows.sql, count: queries.count.sql },
      variants: Object.fromEntries(dbs.map((db, i) => [variants[i].name, {
        ...stats(samples[i]), changePercent: (stats(samples[i]).medianMs / stats(samples[0]).medianMs - 1) * 100,
        fasterPairs: samples[i].filter((ms, j) => ms < samples[0][j]).length,
        ...(rewriteSql(queries.rows.sql, variants[i]) !== queries.rows.sql
          ? { rewrittenRowsSql: rewriteSql(queries.rows.sql, variants[i]) } : {}),
        plans: Object.fromEntries(['rows', 'count'].map(key => [key,
          db.connection.prepare(`EXPLAIN QUERY PLAN ${queries[key].sql}`).all(...queries[key].args).map(row => row.detail)])),
      }])) };
  });
}
function replacement(db) {
  const c = db.connection, session = c.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  const models = c.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  const caps = c.prepare('SELECT category,name,usage_count FROM turn_capability_usage WHERE turn_id=? ORDER BY category,name');
  const rows = c.prepare(`SELECT t.*,p.project_name,s.session_name,coalesce(b.billing_mode,c.billing_mode,'unknown') billing
    FROM turn_summary t JOIN projects p USING(project_key)
    JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id
    LEFT JOIN session_billing b ON b.provider=t.provider AND b.session_id=t.session_id
    LEFT JOIN turn_costs c ON c.turn_id=t.id WHERE t.provider=? AND t.session_id=? ORDER BY t.id`).all(session.provider, session.session_id)
    .map(({ id, ...row }) => { const model_usage = models.all(id); return { ...row, model_usage: model_usage.length ? model_usage : undefined, capability_usage: caps.all(id) }; });
  const appended = structuredClone(rows[0]);
  Object.assign(appended, { root_turn_id: 'simple-index-benchmark-added', request_title: 'Benchmark append',
    diagnostic_file_id: null, diagnostic_offset: null, last_error: null });
  return { sessions: [session], files: [], summaries: [...rows, appended] };
}
async function writeMeasurements(directory, dbs, options) {
  const input = replacement(dbs[0]), samples = dbs.map(() => []);
  for (let pair = -1; pair < options.writeSamples; pair++) {
    const hashes = [];
    for (const i of order(pair + 1)) {
      const path = join(directory, `append-${pair}-${i}.sqlite`);
      await backup(dbs[i].connection, path);
      const db = new SummaryDatabase(path);
      try {
        db.queryUsagePage({}, 'total', timezone);
        global.gc?.();
        const start = performance.now(); db.replaceSessions(input); const storeMs = performance.now() - start;
        const readStart = performance.now(); db.queryUsagePage({}, 'day', timezone, { limit: 100 }, 'model');
        const firstAggregateMs = performance.now() - readStart;
        if (pair >= 0) samples[i].push({ storeMs, firstAggregateMs });
        integrity(db); hashes.push(factsHash(db));
      } finally {
        db.close();
        assert.equal(dirname(resolve(path)), resolve(directory));
        for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true });
      }
    }
    assert.ok(hashes.every(value => value === hashes[0]), 'Post-append facts differ');
  }
  return { operation: 'append-one-via-replaceSessions', originalSessionRequests: input.summaries.length - 1,
    variants: Object.fromEntries(samples.map((values, i) => [variants[i].name, {
      store: stats(values.map(value => value.storeMs)), firstAggregate: stats(values.map(value => value.firstAggregateMs)),
      changePercent: (stats(values.map(value => value.storeMs)).medianMs / stats(samples[0].map(value => value.storeMs)).medianMs - 1) * 100,
      fasterPairs: values.filter((value, j) => value.storeMs < samples[0][j].storeMs).length,
    }])) };
}
async function main() {
  const options = optionsFor(process.argv.slice(2)), hashes = sourceHashes();
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-simple-index-'));
  const report = { startedAtSeoul: seoulTime(), head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    sourceSha256: hashes, variants, environment: { node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
      cacheKiB: 4096, tempStore: 'FILE', mmapBytes: 0 },
    method: { readSamples: options.samples, readIterations: options.iterations, writeSamples: options.writeSamples,
      reads: 'Warm public queryUsagePage, first 100 rows plus grouped COUNT, same facts/SQL/build; two warmups; rotated/reversed order; GC outside timer; full SQL result and count equality before timing.',
      writes: 'One appended request through public replaceSessions including commit; restore identical pre-state for every sample; one warmup; indexes and ready daily rollups retained; open/backup/input/correctness excluded.',
      stats: 'Product PRAGMA main.optimize=0x10002 after index creation for ALL variants; no forced ANALYZE.',
      queryPrototype: 'shared-session-time rewrites only the rollup session-start MIN subquery at connection.prepare, so the public reader uses the raw time index for the same all-time minimum. No product file is modified. Full results and selected-session ranges are compared against unchanged SQL.',
      dates: 'Last 7/30 days ending at local midnight after latest recorded request, not wall clock today.',
      space: 'Checkpointed file bytes and dbstat object pages, no VACUUM; index creation may reuse existing free pages.',
      limits: 'DB only; no parsing/worker/UI/OS-cache reset; one machine and two synthetic distributions. Private paths/titles/session IDs omitted. Physical IDs/update timestamps ignored only in comparison hashes; floats rounded to 12 significant digits only for comparison.' }, datasets: [] };
  try {
    const datasets = options.smoke ? [{ name: 'smoke', count: 200, turns: 20 }] : [
      { name: 'installed-snapshot', real: true },
      { name: 'synthetic-10000-short', count: 10000, turns: 100 },
      { name: 'synthetic-10000-long', count: 10000, turns: 1000 },
    ];
    for (const dataset of datasets) {
      console.log(`Dataset ${dataset.name}`);
      const work = join(directory, dataset.name); await mkdir(work);
      const basePath = join(work, 'base.sqlite');
      if (dataset.real) {
        const original = new DatabaseSync(options.realDb, { readOnly: true });
        try { original.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000;'); await backup(original, basePath); }
        finally { original.close(); }
      }
      const base = new SummaryDatabase(basePath), dbs = [], paths = [];
      try {
        if (!dataset.real) {
          const rows = syntheticRows(dataset.count, dataset.turns);
          const sessions = [...new Map(rows.map(row => [row.session_id, { provider: row.provider, session_id: row.session_id }])).values()];
          base.replaceSessions({ sessions, files: [], summaries: rows });
        }
        base.queryUsagePage({}, 'day', timezone, { limit: 100 }, 'model');
        const originalHash = factsHash(base);
        const input = { ...base.connection.prepare('SELECT count(*) requests,count(DISTINCT project_key) projects FROM turn_summary').get(),
          sessions: base.connection.prepare('SELECT count(*) n FROM sessions').get().n };
        report.environment.sqlite = base.connection.prepare('SELECT sqlite_version() v').get().v;
        const storage = {};
        for (const variant of variants) {
          const path = join(work, `${variant.name}.sqlite`); paths.push(path); await backup(base.connection, path);
          const db = new SummaryDatabase(path); dbs.push(db);
          if (variant.sql) db.connection.exec(variant.sql);
          if (variant.rewriteSessionStart) {
            const prepare = db.connection.prepare.bind(db.connection);
            db.connection.prepare = sql => prepare(rewriteSql(sql, variant));
          }
          db.connection.exec('PRAGMA main.optimize=0x10002;');
          assert.equal(factsHash(db), originalHash); integrity(db);
          storage[variant.name] = space(db, path);
        }
        const reads = readMeasurements(dbs, options);
        console.log(`${dataset.name}: ${reads.length} read cases passed`);
        const writes = await writeMeasurements(work, dbs, options);
        for (const db of dbs) { assert.equal(factsHash(db), originalHash); integrity(db); }
        report.datasets.push({ name: dataset.name, input, inputSha256: originalHash, storage, reads, writes });
        await mkdir(dirname(options.output), { recursive: true });
        await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
      } finally { dbs.forEach(db => db.close()); base.close(); }
    }
    assert.deepEqual(sourceHashes(), hashes);
    report.completedAtSeoul = seoulTime();
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved ${options.output}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-simple-index-') && !fs.lstatSync(directory).isSymbolicLink());
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
