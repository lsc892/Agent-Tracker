// 현재 UI의 최신 요청 정렬과 정확히 일치하는 expression 인덱스의 조회·쓰기·공간을 비교한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { copyFile, mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { cpus, tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildQueryFilter, buildTurnsQuery, buildTurnsCountQuery } = require('../../dist/src/summary/db/queries');
const { seed, compareResults } = require('./sql-rollup.cjs');
const { stats } = require('./sql-explain.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul', day = 86400000;
const indexName = 'bench_summary_ui_date_order';
// Current ORDER BY repeats the NULL expression. Preserve its exact term sequence; rowid supplies the final id ASC.
const indexExpression = '(started_at_ms IS NULL),(started_at_ms IS NULL),started_at_ms DESC,provider';
const indexSql = `CREATE INDEX ${indexName} ON turn_summary(${indexExpression})`;
const variants = ['current', 'expression-date-order-index'];
const sha = value => createHash('sha256').update(value).digest('hex');
const scalar = (db, sql) => Object.values(db.connection.prepare(sql).get())[0];

function optionsFor(args) {
  const options = { sizes: [1000, 100000], samples: 9, warmup: 3,
    output: resolve(root, 'docs/benchmarks/DateStorageOrder-2026-10-25.json') };
  for (const arg of args) {
    if (arg.startsWith('--sizes=')) options.sizes = arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--samples=')) options.samples = Number(arg.slice(10));
    else if (arg.startsWith('--warmup=')) options.warmup = Number(arg.slice(9));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else throw new Error(`Unknown option ${arg}`);
  }
  assert.ok(options.sizes.length && options.sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000));
  assert.ok(Number.isSafeInteger(options.samples) && options.samples >= 3 && options.samples <= 31);
  assert.ok(Number.isSafeInteger(options.warmup) && options.warmup >= 1 && options.warmup <= 9);
  return options;
}

function specsFor(db) {
  const latest = scalar(db, 'SELECT max(started_at_ms) FROM turn_summary');
  const week = { fromMs: latest + 1 - 7 * day, toMs: latest + 1 };
  return [
    ['turn-latest-all', 'provider', {}],
    ['turn-latest-claude', 'provider', { provider: 'claude' }],
    ['turn-week-provider', 'provider', week],
    ['turn-latest-all-model', 'model', {}],
    ['turn-week-model', 'model', week],
  ].map(([name, by, filter]) => ({ name, by,
    filter: { providers: ['claude', 'codex'], excludeEmptyUsage: true, ...filter },
    page: { limit: 100, offset: 0, tableSort: { key: 'period', direction: 'desc' } } }));
}

function sqlFor(spec) {
  const rows = buildTurnsQuery(buildQueryFilter(spec.filter), false, spec.by, true, spec.page.tableSort);
  const count = buildTurnsCountQuery(spec.filter, spec.by);
  return { rows, count, rowValues: [...rows.values, 0, spec.page.limit, spec.page.offset], countValues: count.values };
}

function plans(db, spec) {
  const query = sqlFor(spec);
  const explain = (sql, values) => db.connection.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...values).map(row => row.detail);
  return { rows: explain(query.rows.sql, query.rowValues), count: explain(query.count.sql, query.countValues) };
}

function read(db, spec) { return db.queryUsagePage(spec.filter, 'turn', timezone, spec.page, spec.by); }

function minimalKeyProbe(db) {
  const spec = specsFor(db)[0];
  const candidates = [
    ['single-null-implicit-id', '(started_at_ms IS NULL),started_at_ms DESC,provider'],
    ['double-null-implicit-id', indexExpression],
    ['double-null-explicit-id', `${indexExpression},id`],
  ];
  return candidates.map(([name, expression]) => {
    db.connection.exec(`CREATE INDEX bench_date_order_probe ON turn_summary(${expression}); ANALYZE`);
    try {
      const plan = plans(db, spec).rows;
      return { name, expression, plan, indexBytes: scalar(db, "SELECT sum(pgsize) FROM dbstat WHERE name='bench_date_order_probe'"),
        avoidsTempSort: !plan.some(value => /USE TEMP B-TREE.*ORDER BY/.test(value)) };
    } finally { db.connection.exec('DROP INDEX bench_date_order_probe'); }
  });
}

function space(db, path) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pageSize = scalar(db, 'PRAGMA page_size'), pageCount = scalar(db, 'PRAGMA page_count');
  const freePages = scalar(db, 'PRAGMA freelist_count');
  return { pageSize, pageCount, freePages, allocatedBytes: pageSize * pageCount,
    liveAllocatedBytes: pageSize * (pageCount - freePages), fileBytes: statSync(path).size,
    objects: db.connection.prepare('SELECT name,sum(pgsize) bytes,count(*) pages,sum(payload) payloadBytes,sum(unused) unusedBytes FROM dbstat GROUP BY name ORDER BY name').all() };
}

function measureReads(dbs, options) {
  return specsFor(dbs[0]).map(spec => {
    const initial = dbs.map(db => read(db, spec));
    assert.equal(initial[0].total, initial[1].total);
    compareResults(initial[0].rows, initial[1].rows, `${spec.name} first page`);
    const query = sqlFor(spec), fullValues = [...query.rowValues];
    fullValues[fullValues.length - 2] = 10000000;
    const full = dbs.map(db => db.connection.prepare(query.rows.sql).all(...fullValues));
    const fullSha = compareResults(full[0], full[1], `${spec.name} full sorted results`);
    assert.equal(full[0].length, initial[0].total);
    for (const db of dbs) for (let i = 0; i < options.warmup; i++) read(db, spec);
    const samples = dbs.map(() => []), iterations = dbs.map(() => []);
    for (let sample = 0; sample < options.samples; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      let count = 0, elapsed;
      do { read(dbs[index], spec); count++; elapsed = performance.now() - start; } while (elapsed < 16 && count < 1000);
      samples[index].push(elapsed / count); iterations[index].push(count);
    }
    dbs.forEach((db, i) => assert.equal(sha(JSON.stringify(read(db, spec))), sha(JSON.stringify(initial[i])), `${spec.name} final page`));
    const baseline = stats(samples[0]).medianMs;
    return { ...spec, totalRows: initial[0].total, returnedRows: initial[0].rows.length, fullSortedResultSha256: fullSha,
      variants: variants.map((variant, i) => ({ variant, latency: stats(samples[i]), iterationsPerSample: iterations[i],
        speedup: baseline / stats(samples[i]).medianMs, reductionPercent: (1 - stats(samples[i]).medianMs / baseline) * 100,
        plans: plans(dbs[i], spec) })) };
  });
}

function replacementFor(db) {
  const session = db.connection.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  const rows = db.connection.prepare('SELECT t.*,p.project_name,s.session_name FROM turn_summary t JOIN projects p USING(project_key) JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id WHERE t.provider=? AND t.session_id=? ORDER BY id').all(session.provider, session.session_id);
  const model = db.connection.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  return { sessions: [session], files: [], summaries: rows.map(row => {
    const { id, ...input } = row, models = model.all(id);
    return { ...input, model_usage: models.length ? models : undefined };
  }) };
}

function measureWrites(dbs, paths, options) {
  const replacement = replacementFor(dbs[0]), samples = dbs.map(() => []), walBytes = dbs.map(() => []);
  for (const db of dbs) for (let i = 0; i < options.warmup; i++) db.replaceSessions(replacement);
  for (let sample = 0; sample < options.samples; sample++) for (const index of sample % 2 ? [1, 0] : [0, 1]) {
    dbs[index].connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const start = performance.now();
    dbs[index].replaceSessions(replacement);
    samples[index].push(performance.now() - start);
    walBytes[index].push(statSync(`${paths[index]}-wal`).size);
  }
  const baseline = stats(samples[0]).medianMs;
  return { scenario: 'actual replaceSessions, same 100-turn session, unmaterialized rollups', inputTurns: replacement.summaries.length,
    variants: variants.map((variant, i) => ({ variant, latency: stats(samples[i]), walBytes: walBytes[i],
      addedMedianMs: stats(samples[i]).medianMs - baseline, increasePercent: (stats(samples[i]).medianMs / baseline - 1) * 100 })) };
}

async function dataset(directory, size, options) {
  const basePath = join(directory, `${size}-base.sqlite`), fixture = new SummaryDatabase(basePath);
  let probes;
  try { seed(fixture, size, 100); probes = minimalKeyProbe(fixture); fixture.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)'); }
  finally { fixture.close(); }
  const paths = variants.map(name => join(directory, `${size}-${name}.sqlite`));
  for (const path of paths) await copyFile(basePath, path);
  const dbs = paths.map(path => new SummaryDatabase(path));
  try {
    const indexStart = performance.now();
    dbs[1].connection.exec(indexSql);
    const indexCreationMs = performance.now() - indexStart;
    for (const db of dbs) db.connection.exec('ANALYZE; PRAGMA main.optimize; PRAGMA wal_autocheckpoint=0');
    const storage = dbs.map((db, i) => ({ variant: variants[i], ...space(db, paths[i]) }));
    const reads = measureReads(dbs, options), writes = measureWrites(dbs, paths, options);
    for (const spec of specsFor(dbs[0])) {
      const before = read(dbs[0], spec), after = read(dbs[1], spec);
      assert.equal(before.total, after.total);
      compareResults(before.rows, after.rows, `post-write ${spec.name}`);
    }
    return { rawRows: size, turnsPerSession: 100, unknownTimeRows: scalar(dbs[0], 'SELECT count(*) FROM turn_summary WHERE started_at_ms IS NULL'),
      sqliteVersion: scalar(dbs[0], 'SELECT sqlite_version()'), schemaVersion: scalar(dbs[0], 'PRAGMA user_version'), probes,
      chosenIndex: { sql: indexSql, indexCreationMs, reason: 'single NULL expression failed to match duplicated ORDER BY; duplicate expression matched. Explicit id omitted because the implicit rowid ASC tie-break matched and uses fewer bytes.' },
      storage, extraIndexBytes: storage[1].objects.find(object => object.name === indexName).bytes,
      extraLiveAllocatedBytes: storage[1].liveAllocatedBytes - storage[0].liveAllocatedBytes, reads, writes,
      validation: 'all sorted SQL results and public first-page/count values matched before timing; public first pages/counts matched again after replacement writes' };
  } finally { for (const db of dbs) db.close(); }
}

async function main() {
  const options = optionsFor(process.argv.slice(2)), directory = await mkdtemp(join(tmpdir(), 'agent-tracker-date-order-'));
  const report = { createdAtSeoul: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date()),
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, logicalCpus: cpus().length,
      sourceSha256: Object.fromEntries(['src/summary/db/schema.ts', 'src/summary/db/queries.ts', 'src/summary/db/sorting.ts'].map(path => [path, sha(readFileSync(join(root, path)))])) },
    options, references: [
      { url: 'https://www.sqlite.org/expridx.html', reason: 'Expression indexes must match the query expression; algebraic equivalence does not suffice.' },
      { url: 'https://www.sqlite.org/optoverview.html#order_by_optimizations', reason: 'The planner balances WHERE search and ORDER BY index cost; partial prefixes can still require sorting.' },
      { url: 'https://www.sqlite.org/queryplanner.html', reason: 'Secondary indexes carry rowid as the tie-breaker; sorting/index search behavior.' },
    ], method: { samples: options.samples, warmup: options.warmup, readTiming: 'actual current queryUsagePage turn API; rows + count + prepare + SAVEPOINT snapshot. Each sample averages >=16ms batches (1000-call cap). AB/BA alternates. Warm SQLite and OS cache; no worker IPC or UI rendering.',
      fixture: 'same sql-rollup seed; 100 turns/session; explicit original ids preserved, unknown times and timestamp ties included; copies of identical checkpointed DB',
      minimalIndexProbe: 'three candidate index definitions are tested separately with EXPLAIN and dbstat before copying the fixture; only one chosen index exists in the timed candidate',
      writeTiming: 'actual replaceSessions transaction+commit, same 100-turn session, checkpoint excluded, rollups not materialized; warmup may reuse pages',
      storage: 'checkpointed dbstat object allocation plus page/freelist/file sizes before writes; WAL byte counts are file lengths, not physical I/O',
      caveats: ['provider-basis latest sort index only; model unknown-order expressions do not fully match', 'arbitrary header sorts, deep offsets, provider selectivity and cold caches may behave differently', 'index creation time is one observation, not a sampled A/B result', 'fixture probe drop leaves recyclable free pages equally in both copies; live bytes and index dbstat bytes distinguish allocation from physical file length', 'product source and installed/private DBs are unchanged'] }, datasets: [] };
  try {
    for (const size of options.sizes) { console.log(`date order ${size}`); report.datasets.push(await dataset(directory, size, options)); }
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved ${options.output}; all sorted results and post-write public pages matched`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-date-order-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { optionsFor, dataset, minimalKeyProbe };
