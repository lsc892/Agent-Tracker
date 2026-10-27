// 날짜순 INSERT와 raw 날짜 인덱스 후보의 결과·조회·쓰기·저장 공간을 격리 DB에서 비교한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { statSync, readFileSync } = require('node:fs');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { cpus, tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildQueryFilter, buildTurnsQuery, buildTurnsCountQuery, buildUsageQuery, buildUsageCountQuery } = require('../../dist/src/summary/db/queries');
const { seed, compareResults } = require('./sql-rollup.cjs');
const { stats } = require('./sql-explain.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul', DAY = 86400000;
const variants = [
  { name: 'current', order: 'id', sql: '' },
  { name: 'date-insert-preserve-id', order: 'started_at_ms,id', sql: '' },
  { name: 'provider-date-index', order: 'id', sql: 'CREATE INDEX bench_summary_provider_date ON turn_summary(provider,started_at_ms)' },
  { name: 'narrow-date-index', order: 'id', sql: 'DROP INDEX idx_summary_period; CREATE INDEX idx_summary_period ON turn_summary(started_at_ms)' },
];
const sha = value => createHash('sha256').update(value).digest('hex');
const scalar = (db, sql) => Object.values(db.connection.prepare(sql).get())[0];

function optionsFor(args) {
  const options = { sizes: [1000, 100000], samples: 9, warmup: 3, output: resolve(root, 'docs/benchmarks/DateStorageRaw-2026-10-25.json') };
  for (const arg of args) {
    if (arg.startsWith('--sizes=')) options.sizes = arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--samples=')) options.samples = Number(arg.slice(10));
    else if (arg.startsWith('--warmup=')) options.warmup = Number(arg.slice(9));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else throw new Error(`Unknown argument ${arg}`);
  }
  assert.ok(options.sizes.every(value => Number.isSafeInteger(value) && value > 0 && value <= 1000000));
  assert.ok(Number.isInteger(options.samples) && options.samples >= 3 && options.samples <= 21);
  assert.ok(Number.isInteger(options.warmup) && options.warmup >= 1 && options.warmup <= 9);
  return options;
}

function space(db, path) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pageSize = scalar(db, 'PRAGMA page_size'), pageCount = scalar(db, 'PRAGMA page_count');
  const freePages = scalar(db, 'PRAGMA freelist_count');
  const objects = db.connection.prepare('SELECT name,sum(pgsize) bytes,count(*) pages,sum(payload) payloadBytes,sum(unused) unusedBytes FROM dbstat GROUP BY name ORDER BY name').all();
  return { pageSize, pageCount, freePages, allocatedBytes: pageSize * pageCount,
    liveAllocatedBytes: pageSize * (pageCount - freePages), fileBytes: statSync(path).size, objects };
}

function plan(db, query, values) {
  return db.connection.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...values).map(row => row.detail);
}

function specsFor(db) {
  const latest = scalar(db, 'SELECT max(started_at_ms) FROM turn_summary');
  const week = { fromMs: latest + 1 - 7 * DAY, toMs: latest + 1 };
  const project = db.connection.prepare('SELECT provider,project_key FROM turn_summary WHERE started_at_ms>=? GROUP BY provider,project_key ORDER BY count(*) DESC,provider,project_key LIMIT 1').get(latest - 30 * DAY);
  const session = db.connection.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  return [
    { name: 'turn-latest-all', groupBy: 'turn', filter: {}, by: 'provider' },
    { name: 'turn-latest-provider', groupBy: 'turn', filter: { provider: 'claude' }, by: 'provider' },
    { name: 'turn-7-days', groupBy: 'turn', filter: week, by: 'provider' },
    { name: 'turn-7-days-model', groupBy: 'turn', filter: week, by: 'model' },
    { name: 'raw-total-costs', groupBy: 'total', filter: { includeCosts: true }, by: 'provider' },
    { name: 'raw-7-days-costs', groupBy: 'day', filter: { ...week, includeCosts: true }, by: 'provider' },
    { name: 'raw-project-costs', groupBy: 'total', filter: { provider: project.provider, projectKey: project.project_key, includeCosts: true }, by: 'provider' },
    { name: 'raw-session-costs', groupBy: 'session', filter: { provider: session.provider, sessionId: session.session_id, includeCosts: true }, by: 'provider' },
  ].map(spec => ({ ...spec, page: { limit: 100, offset: 0, tableSort: { key: 'period', direction: 'desc' } } }));
}

function read(db, spec) {
  return db.queryUsagePage(spec.filter, spec.groupBy, timezone, spec.page, spec.by);
}

function sqlFor(spec) {
  if (spec.groupBy === 'turn') {
    const rows = buildTurnsQuery(buildQueryFilter(spec.filter), spec.filter.includeCosts, spec.by, true, spec.page.tableSort);
    const count = buildTurnsCountQuery(spec.filter, spec.by);
    return { rows, rowValues: [...rows.values, 0, 100, 0], count, countValues: count.values };
  }
  const rows = buildUsageQuery(spec.filter, spec.groupBy, timezone, spec.by, undefined, spec.page.tableSort);
  const count = buildUsageCountQuery(spec.filter, spec.groupBy, timezone, spec.by);
  return { rows, rowValues: [...rows.values, 100, 0], count, countValues: count.values };
}

function alternating(sample) {
  const sequence = variants.map((_value, i) => i);
  const shift = Math.floor(sample / 2) % sequence.length;
  const rotated = [...sequence.slice(shift), ...sequence.slice(0, shift)];
  return sample % 2 ? rotated.reverse() : rotated;
}

function measureReads(dbs, options) {
  return specsFor(dbs[0]).map(spec => {
    const initial = dbs.map(db => read(db, spec));
    const digests = initial.map(result => sha(JSON.stringify(result)));
    for (const result of initial) {
      assert.equal(result.total, initial[0].total);
      compareResults(initial[0].rows, result.rows, spec.name);
    }
    // Full-query validation uses one SQL pass outside timing, rather than many OFFSET pages.
    const sql = sqlFor(spec);
    const fullValues = [...sql.rowValues]; fullValues[fullValues.length - 2] = 10000000;
    const full = dbs.map(db => db.connection.prepare(sql.rows.sql).all(...fullValues));
    full.slice(1).forEach(rows => compareResults(full[0], rows, `${spec.name} full result`));
    const fullDigest = compareResults(full[0], full[0], `${spec.name} digest`);
    for (const db of dbs) for (let i = 0; i < options.warmup; i++) read(db, spec);
    const samples = dbs.map(() => []), iterations = dbs.map(() => []), batches = dbs.map(() => []);
    for (let sample = 0; sample < options.samples; sample++) for (const index of alternating(sample)) {
      const start = performance.now();
      let count = 0, elapsed = 0;
      do { read(dbs[index], spec); count++; elapsed = performance.now() - start; } while (elapsed < 12 && count < 1000);
      samples[index].push(elapsed / count); iterations[index].push(count); batches[index].push(elapsed);
    }
    dbs.forEach((db, i) => assert.equal(sha(JSON.stringify(read(db, spec))), digests[i], `${spec.name} timed final output`));
    return { name: spec.name, groupBy: spec.groupBy, by: spec.by, filter: spec.filter,
      totalGroups: initial[0].total, returnedRows: initial[0].rows.length, fullResultSha256: fullDigest,
      variants: Object.fromEntries(variants.map((variant, index) => [variant.name, {
        latency: stats(samples[index]), speedup: stats(samples[0]).medianMs / stats(samples[index]).medianMs,
        iterationsPerSample: iterations[index], batchMs: batches[index],
        plans: { rows: plan(dbs[index], sql.rows, sql.rowValues), count: plan(dbs[index], sql.count, sql.countValues) },
      }])) };
  });
}

function replacementFor(db) {
  const session = db.connection.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  const rows = db.connection.prepare('SELECT t.*,p.project_name,s.session_name FROM turn_summary t JOIN projects p USING(project_key) JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id WHERE t.provider=? AND t.session_id=? ORDER BY id').all(session.provider, session.session_id);
  const model = db.connection.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  return { sessions: [session], files: [], summaries: rows.map(row => {
    const { id, ...input } = row;
    const models = model.all(id);
    return { ...input, model_usage: models.length ? models : undefined };
  }) };
}

function measureWrites(dbs, paths, options) {
  const replacement = replacementFor(dbs[0]);
  const samples = dbs.map(() => []), walBytes = dbs.map(() => []);
  for (const db of dbs) for (let i = 0; i < options.warmup; i++) db.replaceSessions(replacement);
  for (let sample = 0; sample < options.samples; sample++) for (const index of alternating(sample)) {
    dbs[index].connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const start = performance.now();
    dbs[index].replaceSessions(replacement);
    samples[index].push(performance.now() - start);
    walBytes[index].push(statSync(`${paths[index]}-wal`).size);
  }
  return { scenario: 'public replaceSessions same 100-turn session, rollup not materialized', inputTurns: replacement.summaries.length,
    variants: Object.fromEntries(variants.map((variant, index) => [variant.name, { latency: stats(samples[index]), walBytes: walBytes[index] }])),
    validation: 'public session replacement succeeds; post-write all public workload outputs compared across candidates; IDs may change together as normal replacement behavior',
  };
}

function load(db, variant) {
  const start = performance.now();
  db.transaction(() => {
    db.connection.exec(`INSERT INTO projects SELECT * FROM fixture.projects;
      INSERT INTO sessions SELECT * FROM fixture.sessions;
      INSERT INTO turn_summary SELECT * FROM fixture.turn_summary ORDER BY ${variant.order};
      INSERT INTO turn_model_usage SELECT * FROM fixture.turn_model_usage;`);
  });
  return performance.now() - start;
}

function clear(db) {
  db.transaction(() => db.connection.exec('DELETE FROM turn_model_usage; DELETE FROM turn_summary; DELETE FROM sessions; DELETE FROM projects'));
}

async function dataset(directory, size, options) {
  const basePath = join(directory, `base-${size}.sqlite`), base = new SummaryDatabase(basePath);
  try { seed(base, size, 100); base.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
  finally { base.close(); }
  const paths = variants.map(variant => join(directory, `${size}-${variant.name}.sqlite`));
  const dbs = paths.map(path => new SummaryDatabase(path));
  try {
    dbs.forEach((db, i) => {
      db.connection.exec('PRAGMA wal_autocheckpoint=0');
      if (variants[i].sql) db.connection.exec(variants[i].sql);
      db.connection.prepare('ATTACH DATABASE ? AS fixture').run(basePath);
    });
    const buildSamples = dbs.map(() => []);
    // Fresh first load retained separately; later iterations reuse empty B-trees/pages.
    const firstLoadMs = dbs.map((db, i) => load(db, variants[i]));
    for (const db of dbs) for (let i = 0; i < options.warmup; i++) {
      clear(db); load(db, variants[dbs.indexOf(db)]);
    }
    for (let sample = 0; sample < options.samples; sample++) for (const index of alternating(sample)) {
      clear(dbs[index]); dbs[index].connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      buildSamples[index].push(load(dbs[index], variants[index]));
    }
    dbs.forEach(db => { db.connection.exec('DETACH DATABASE fixture; ANALYZE; PRAGMA main.optimize'); });
    const idDigest = dbs.map(db => sha(JSON.stringify(db.connection.prepare('SELECT id,provider,session_id,root_turn_id,started_at_ms FROM turn_summary ORDER BY id').all())));
    idDigest.slice(1).forEach(value => assert.equal(value, idDigest[0]));
    const beforeSpace = Object.fromEntries(variants.map((variant, i) => [variant.name, space(dbs[i], paths[i])]));
    const reads = measureReads(dbs, options);
    const writes = measureWrites(dbs, paths, options);
    // Public replacement changes IDs equally in all four copies; validate all rows again after writes.
    for (const spec of specsFor(dbs[0])) {
      const initial = read(dbs[0], spec);
      dbs.slice(1).forEach(db => { const value = read(db, spec); assert.equal(value.total, initial.total); compareResults(initial.rows, value.rows, `post-write ${spec.name}`); });
    }
    return { rows: size, turnsPerSession: 100, sqliteVersion: scalar(dbs[0], 'SELECT sqlite_version()'), schemaVersion: scalar(dbs[0], 'PRAGMA user_version'),
      unknownTimeRows: scalar(dbs[0], 'SELECT count(*) FROM turn_summary WHERE started_at_ms IS NULL'),
      originalIdMappingSha256: idDigest[0], build: Object.fromEntries(variants.map((variant, i) => [variant.name, { firstLoadMs: firstLoadMs[i], refill: stats(buildSamples[i]) }])),
      storage: beforeSpace, reads, writes };
  } finally { dbs.forEach(db => db.close()); }
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-date-raw-'));
  try {
    const report = { createdAtSeoul: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date()),
      environment: { node: process.version, cpu: cpus()[0]?.model, logicalCpus: cpus().length, platform: process.platform,
        sourceSha256: Object.fromEntries(['src/summary/db/schema.ts', 'src/summary/db/queries.ts', 'src/summary/db/sorting.ts'].map(path => [path, sha(readFileSync(join(root, path)))])) },
      method: { samples: options.samples, warmup: options.warmup, variants, cacheKiB: 4096, tempStore: 'FILE', pageLimit: 100,
        readTiming: 'actual queryUsagePage API, rows + COUNT + prepare + snapshot; warm SQLite/OS caches; no UI/worker IPC; each sample averages a batch of at least 12ms (1000-call cap); alternating/reversing and rotating variant order',
        buildTiming: 'INSERT SELECT transaction/commit with indexes already present; base fixture generation/schema creation excluded; first load separately; repeated refill uses recycled pages',
        writeTiming: 'actual replaceSessions transaction/commit; checkpoints excluded; no rollup materialization', statistics: 'ANALYZE then main.optimize on every isolated variant after loading',
        storage: 'checkpointed allocated/live page bytes and dbstat object allocations; pre-write after repeated refill; WAL bytes are logical file lengths, not physical I/O',
        correctness: 'all full SQL result rows before timings, exact integer/string/null and relative/absolute 1e-9 for averages/cost; same public first page + counts after timing and writes; explicit id mappings preserved in initial load',
        caveats: ['sorted INSERT preserves id; rowid B-tree logical key order stays id, while page fill/free-space can differ', 'all-row cost fallback deliberately uses raw facts; normal aggregates use existing rollups', 'date-index changes cannot remove all current computed unknown-last sorting', 'no installed DB or private source logs read or mutated'] },
      references: ['https://www.sqlite.org/queryplanner.html', 'https://www.sqlite.org/rowidtable.html', 'https://www.sqlite.org/withoutrowid.html'], datasets: [] };
    for (const size of options.sizes) { process.stdout.write(`raw date storage ${size}\n`); report.datasets.push(await dataset(directory, size, options)); }
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`Saved ${options.output}\n`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-date-raw-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { optionsFor, dataset };
