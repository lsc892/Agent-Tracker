// 일별 집계의 세션 선두 PK와 날짜 선두 PK를 동일한 제품 API로 비교한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { cpus, tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { backup } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildRollupUsageQueries } = require('../../dist/src/summary/db/rollup-queries');
const { buildUsageQuery } = require('../../dist/src/summary/db/queries');
const { calendarPeriod, periodBounds } = require('../../dist/src/summary/db/timezone');
const { seed, compareResults } = require('./sql-rollup.cjs');
const { workloads, stats } = require('./sql-explain.cjs');
const { querySourceFiles } = require('./query-source-files.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const tables = ['usage_request_daily', 'usage_model_daily'];
const variants = ['current-session-pk', 'provider-date-pk', 'provider-date-pk-session-index'];
const sha = value => createHash('sha256').update(value).digest('hex');
const time = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());

function optionsFor(args) {
  const options = { sizes: [1000, 100000], turns: [10, 100], samples: 9, warmup: 3,
    output: resolve(root, 'docs/benchmarks/DateStorageRollup-2026-10-25.json') };
  for (const arg of args) {
    if (arg.startsWith('--sizes=')) options.sizes = arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--turns=')) options.turns = arg.slice(8).split(',').map(Number);
    else if (arg.startsWith('--samples=')) options.samples = Number(arg.slice(10));
    else if (arg.startsWith('--warmup=')) options.warmup = Number(arg.slice(9));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else throw new Error(`Unknown option ${arg}`);
  }
  assert.ok(options.sizes.every(n => Number.isInteger(n) && n > 0 && n <= 1000000));
  assert.ok(options.turns.every(n => Number.isInteger(n) && n > 0 && n <= 10000));
  assert.ok(Number.isInteger(options.samples) && options.samples >= 3 && options.samples <= 31);
  assert.ok(Number.isInteger(options.warmup) && options.warmup >= 1 && options.warmup <= 10);
  return options;
}

function installCandidate(db, variant) {
  if (variant === variants[0]) return;
  db.transaction(() => {
    for (const table of tables) {
      const old = db.connection.prepare('SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?').get(table).sql;
      const model = table === 'usage_model_daily' ? ', model_key' : '';
      const prefix = 'provider, local_day';
      const create = old.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${table}_candidate`)
        .replace(/PRIMARY KEY\([^)]*\)/, `PRIMARY KEY(${prefix}, session_id, project_key${model})`);
      assert.notEqual(old, create);
      db.connection.exec(create);
      db.connection.exec(`INSERT INTO ${table}_candidate SELECT * FROM ${table}; DROP TABLE ${table};
        ALTER TABLE ${table}_candidate RENAME TO ${table};
        CREATE INDEX idx_${table}_project_day ON ${table}(provider, project_key, local_day);`);
      if (variant === variants[2]) db.connection.exec(`CREATE INDEX idx_${table}_session ON ${table}(provider, session_id)`);
    }
  });
}

function publicRead(db, spec, offset = 0) {
  const start = performance.now();
  const result = db.queryUsagePage(spec.filter, spec.groupBy, timezone, { limit: 100, offset, sortBy: spec.sortBy }, spec.by);
  return { ...result, elapsedMs: performance.now() - start };
}

function rebuild(db) {
  // Clear and checkpoint outside the timed interval; first public read does the real lazy build.
  db.transaction(() => db.connection.exec('DELETE FROM usage_request_daily; DELETE FROM usage_model_daily; DELETE FROM usage_rollup_meta;'));
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return publicRead(db, { filter: { excludeEmptyUsage: true }, groupBy: 'total', by: 'provider' });
}

function orderFor(sample) {
  const rotated = variants.map((_, i) => (i + sample) % variants.length);
  return sample % 2 ? rotated.reverse() : rotated;
}

function measureBuild(dbs, options) {
  const samples = dbs.map(() => []);
  for (let i = 0; i < options.warmup; i++) for (const index of orderFor(i)) rebuild(dbs[index]);
  for (let i = 0; i < options.samples; i++) for (const index of orderFor(i)) samples[index].push(rebuild(dbs[index]).elapsedMs);
  return Object.fromEntries(variants.map((name, i) => [name, stats(samples[i])]));
}

function fullRows(db, spec) {
  const query = buildRollupUsageQueries(spec.filter, spec.groupBy, timezone, spec.by, spec.sortBy);
  assert.ok(query, `Expected rollup path for ${spec.name}`);
  return { rows: db.connection.prepare(query.rows.sql).all(...query.rows.values, 10000000, 0), query };
}

function validate(dbs, spec) {
  const full = dbs.map(db => fullRows(db, spec));
  const pages = dbs.map(db => publicRead(db, spec));
  const digest = compareResults(full[0].rows, full[0].rows, `${spec.name} self`);
  for (let i = 0; i < dbs.length; i++) {
    compareResults(full[0].rows, full[i].rows, `${spec.name} full ${variants[i]}`);
    compareResults(pages[0].rows, pages[i].rows, `${spec.name} first page ${variants[i]}`);
    assert.equal(pages[i].total, full[i].rows.length, `${spec.name} count ${variants[i]}`);
  }
  const raw = buildUsageQuery(spec.filter, spec.groupBy, timezone, spec.by, spec.sortBy);
  const rawRows = dbs[0].connection.prepare(raw.sql).all(...raw.values, 10000000, 0);
  compareResults(rawRows, full[0].rows, `${spec.name} raw independent oracle`);
  // A second page and a final page catch hidden ordering/page-boundary differences.
  if (pages[0].total > 100) for (const offset of [100, Math.floor((pages[0].total - 1) / 100) * 100]) {
    const values = dbs.map(db => publicRead(db, spec, offset));
    for (let i = 1; i < values.length; i++) compareResults(values[0].rows, values[i].rows, `${spec.name} offset ${offset}`);
  }
  return { full, pages, digest };
}

function measureRead(dbs, spec, options) {
  const checked = validate(dbs, spec);
  const iterations = Math.min(30, Math.max(1, Math.ceil(10 / Math.max(...checked.pages.map(v => v.elapsedMs), .01))));
  const samples = dbs.map(() => []);
  for (let i = 0; i < options.warmup; i++) for (const index of orderFor(i)) publicRead(dbs[index], spec);
  for (let i = 0; i < options.samples; i++) for (const index of orderFor(i)) {
    let elapsed = 0;
    for (let j = 0; j < iterations; j++) elapsed += publicRead(dbs[index], spec).elapsedMs;
    samples[index].push(elapsed / iterations);
  }
  const measured = Object.fromEntries(variants.map((name, i) => [name, { latency: stats(samples[i]),
    plans: { rows: dbs[i].connection.prepare(`EXPLAIN QUERY PLAN ${checked.full[i].query.rows.sql}`)
      .all(...checked.full[i].query.rows.values, 100, 0).map(v => v.detail),
    count: dbs[i].connection.prepare(`EXPLAIN QUERY PLAN ${checked.full[i].query.count.sql}`)
      .all(...checked.full[i].query.count.values).map(v => v.detail) } } ]));
  return { name: spec.name, groupBy: spec.groupBy, by: spec.by, filter: spec.filter,
    mode: checked.full[0].query.mode, totalGroups: checked.pages[0].total, fullDigestSha256: checked.digest,
    iterationsPerSample: iterations, variants: measured,
    candidatePercentChange: Object.fromEntries(variants.slice(1).map(name => [name,
      100 * (measured[name].latency.medianMs / measured[variants[0]].latency.medianMs - 1)])) };
}

function space(db, path) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pageSize = db.connection.prepare('PRAGMA page_size').get().page_size;
  const pageCount = db.connection.prepare('PRAGMA page_count').get().page_count;
  const freePages = db.connection.prepare('PRAGMA freelist_count').get().freelist_count;
  const objects = db.connection.prepare('SELECT name,sum(pgsize) bytes,count(*) pages FROM dbstat GROUP BY name ORDER BY name').all();
  return { pageSize, pageCount, freePages, allocatedBytes: pageSize * pageCount,
    liveBytes: pageSize * (pageCount - freePages), fileBytes: statSync(path).size,
    rollupBytes: objects.filter(v => tables.some(t => v.name.includes(t))).reduce((total, v) => total + v.bytes, 0), objects };
}

function sessionInput(db) {
  const session = db.connection.prepare('SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id ORDER BY count(*) DESC,provider,session_id LIMIT 1').get();
  const rows = db.connection.prepare(`SELECT t.*,p.project_name,s.session_name FROM turn_summary t
    JOIN projects p USING(project_key) JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id
    WHERE t.provider=? AND t.session_id=? ORDER BY t.id`).all(session.provider, session.session_id);
  const models = db.connection.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  return { sessions: [session], files: [], summaries: rows.map(({ id, ...row }) => {
    const model_usage = models.all(id); return { ...row, model_usage: model_usage.length ? model_usage : undefined };
  }) };
}

function writeOne(db, input, path) {
  const exec = db.connection.exec;
  let begin = 0, commit = 0, rollback = 0;
  db.connection.exec = function(sql) {
    if (sql.trim() === 'BEGIN IMMEDIATE') begin++;
    if (sql.trim() === 'COMMIT') commit++;
    if (sql.trim() === 'ROLLBACK') rollback++;
    return exec.call(this, sql);
  };
  const start = performance.now(); let elapsedMs;
  try { db.replaceSessions(input); elapsedMs = performance.now() - start; }
  finally { db.connection.exec = exec; }
  assert.equal(begin, 1); assert.equal(commit, 1); assert.equal(rollback, 0);
  return { elapsedMs, begin, commit, rollback, walBytes: statSync(`${path}-wal`).size };
}

function measureWrites(dbs, paths, options) {
  const base = sessionInput(dbs[0]), appended = structuredClone(base), corrected = structuredClone(base);
  const extra = structuredClone(base.summaries.at(-1));
  extra.root_turn_id = 'date-storage-appended'; extra.started_at_ms = Date.UTC(2026, 9, 15); appended.summaries.push(extra);
  corrected.summaries[0].started_at_ms = Date.UTC(2026, 4, 1);
  corrected.summaries[0].updated_at = '2026-10-25T00:00:00.000Z';
  const scenarios = [['replace-session', base], ['append-one-turn', appended], ['historical-date-correction', corrected],
    ['delete-session', { sessions: base.sessions, files: [], summaries: [] }]];
  const result = [];
  for (const [name, input] of scenarios) {
    const samples = dbs.map(() => []);
    const one = index => {
      dbs[index].replaceSessions(base);
      dbs[index].connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      return writeOne(dbs[index], input, paths[index]);
    };
    for (let i = 0; i < options.warmup; i++) for (const index of orderFor(i)) one(index);
    for (let i = 0; i < options.samples; i++) for (const index of orderFor(i)) samples[index].push(one(index));
    for (const by of ['provider', 'model']) for (const groupBy of ['total', 'day', 'project', 'session']) {
      validate(dbs, { name: `after-${name}-${by}-${groupBy}`, filter: { excludeEmptyUsage: true }, groupBy, by });
    }
    result.push({ name, inputTurns: input.summaries.length, variants: Object.fromEntries(variants.map((variant, i) =>
      [variant, { latency: stats(samples[i].map(v => v.elapsedMs)), samples: samples[i] }])) });
  }
  dbs.forEach(db => db.replaceSessions(base));
  return result;
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-date-rollup-'));
  const report = { createdAtSeoul: time(), environment: { node: process.version, cpu: cpus()[0]?.model, platform: process.platform, arch: process.arch },
    sourceSha256: Object.fromEntries(['tests/benchmarks/date-storage-rollup.cjs', 'src/summary/db/rollup-state.ts',
      'src/summary/db/rollups.ts', 'src/summary/db/reader.ts', 'tests/benchmarks/sql-rollup.cjs', ...querySourceFiles()]
      .map(path => [path, sha(readFileSync(join(root, path)))])),
    method: { ...options, variants, timezone, order: 'rotate variants and reverse every other sample; same-process warm SQLite/OS caches',
      read: 'actual public queryUsagePage, includes snapshot, metadata/calendar readiness, statement preparation, rows/count; 100 rows; full-group/page validation and EXPLAIN outside timings',
      build: 'actual first public provider/total query including lazy rollup build/commit; DELETE/reset and TRUNCATE checkpoint outside timing; repeated rebuild of identical facts',
      write: 'actual replaceSessions including one BEGIN IMMEDIATE/COMMIT with already ready rollups; restored same input and checkpoint outside timing; WAL autocheckpoint disabled',
      space: 'dbstat live allocated pages and file/page_count/freelist separated; after compact VACUUM then ANALYZE before reads; no claim of physical I/O',
      correctness: 'all groups all fields; numeric avg_/cost_usd tolerance 1e-9; exact other values; first/second/final pages; unknown dates/model and unaligned bounds included',
      limitations: 'synthetic fixture and warm cache; no parser/UI/IPC; same process memory not attributed; not a production migration or durability change' },
    references: ['https://www.sqlite.org/withoutrowid.html', 'https://www.sqlite.org/queryplanner.html', 'https://www.sqlite.org/dbstat.html'], datasets: [] };
  try {
    for (const size of options.sizes) for (const turns of options.turns) {
      const label = `synthetic-${size}-turns-${turns}`, paths = variants.map(name => join(directory, `${label}-${name}.sqlite`));
      const source = new SummaryDatabase(join(directory, `${label}-source.sqlite`));
      try { seed(source, size, turns); for (const path of paths) await backup(source.connection, path); }
      finally { source.close(); }
      const dbs = paths.map(path => new SummaryDatabase(path));
      try {
        dbs.forEach((db, i) => { db.connection.exec('PRAGMA wal_autocheckpoint=0'); installCandidate(db, variants[i]); });
        report.environment.sqlite = dbs[0].connection.prepare('SELECT sqlite_version() v').get().v;
        const dataset = { label, rawFacts: size, turnsPerSession: turns,
          build: measureBuild(dbs, options), reads: [] };
        for (const table of tables) {
          const rows = dbs.map(db => db.connection.prepare(`SELECT * FROM ${table} ORDER BY provider,session_id,project_key,local_day${table === 'usage_model_daily' ? ',model_key' : ''}`).all());
          for (let i = 1; i < rows.length; i++) compareResults(rows[0], rows[i], `${label} ${table} stored states ${variants[i]}`);
        }
        // Equal compaction/statistics state prevents candidate DDL freelist from biasing stored bytes.
        dbs.forEach(db => db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; ANALYZE;'));
        dataset.space = Object.fromEntries(variants.map((name, i) => [name, space(dbs[i], paths[i])]));
        dataset.rows = Object.fromEntries(tables.map(table => [table, dbs[0].connection.prepare(`SELECT count(*) n FROM ${table}`).get().n]));
        const latest = dbs[0].connection.prepare('SELECT max(started_at_ms) n FROM turn_summary').get().n;
        const bounds = periodBounds(calendarPeriod(latest, timezone, 'day'), timezone);
        const specs = [...workloads(dbs[0]), ...['provider', 'model'].map(by => ({ name: `day-7-aligned-${by}`, by, groupBy: 'day',
          filter: { fromMs: bounds.toMs - 7 * 86400000, toMs: bounds.toMs, excludeEmptyUsage: true, unknownTime: 'exclude' } })),
        { name: 'unknown-time-only-model', by: 'model', groupBy: 'day', filter: { unknownTime: 'only', excludeEmptyUsage: true } }];
        for (const spec of specs) {
          if (spec.name === 'project-average-provider') spec.sortBy = 'averageTokens';
          dataset.reads.push(measureRead(dbs, spec, options));
        }
        dataset.writes = measureWrites(dbs, paths, options);
        report.datasets.push(dataset);
        await mkdir(dirname(options.output), { recursive: true });
        await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
        console.log(`${label}: verified ${dataset.reads.length} read workloads and ${dataset.writes.length} write scenarios`);
      } finally { dbs.forEach(db => db.close()); }
    }
    console.log(`Saved ${options.output}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-date-rollup-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
