// 같은 증분 저장·조회 경로에서 일별 집계의 rowid 유무만 교차 비교한다.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync, readFileSync, readdirSync, statSync } = require('node:fs');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { cpus, tmpdir } = require('node:os');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync, backup } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildRollupUsageQueries } = require('../../dist/src/summary/db/rollup-queries');
const { buildUsageQuery, buildQueryFilter } = require('../../dist/src/summary/db/queries');
const { periodBounds } = require('../../dist/src/summary/db/timezone');
const { PRICING_VERSION } = require('../../dist/src/summary/pricing');
const { seed, compareResults } = require('./sql-rollup.cjs');
const { describe, stats } = require('./sql-explain.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const variants = ['without-rowid', 'rowid'];
const tables = ['usage_request_daily', 'usage_model_daily'];
const sha = input => createHash('sha256').update(input).digest('hex');
const seoulTime = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const normalized = value => JSON.stringify(value, (_key, v) => typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(10)) : v);

function sourceHashes() {
  const files = directory => readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.name.endsWith('.ts') ? [path] : [];
  });
  return Object.fromEntries([...files('src'), 'tests/benchmarks/sql-rowid.cjs', 'tests/benchmarks/sql-rollup.cjs', 'tests/benchmarks/sql-explain.cjs']
    .map(path => [relative(root, join(root, path)).replaceAll('\\', '/'), sha(readFileSync(join(root, path)))]));
}

/** Rebuild BOTH candidates, preserving column order, constraints and explicit indexes. */
function rebuildDailyTables(db, variant) {
  db.transaction(() => {
    for (const name of tables) {
      const original = db.connection.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name).sql;
      assert.ok(original.includes('WITHOUT ROWID'));
      const indexes = db.connection.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name").all(name);
      assert.equal(indexes.length, 2);
      let sql = original.replace(`CREATE TABLE ${name}`, `CREATE TABLE ${name}_candidate`);
      if (variant === 'rowid') sql = sql.replace(/\s+WITHOUT ROWID\b/, '');
      db.connection.exec(sql);
      db.connection.exec(`INSERT INTO ${name}_candidate SELECT * FROM ${name}
        ORDER BY provider,session_id,project_key,local_day${name === tables[1] ? ',model_key' : ''};
        DROP TABLE ${name}; ALTER TABLE ${name}_candidate RENAME TO ${name};`);
      for (const index of indexes) db.connection.exec(index.sql);
      const info = db.connection.prepare('PRAGMA table_list').all().find(t => t.schema === 'main' && t.name === name);
      assert.equal(info.wr, variant === 'without-rowid' ? 1 : 0);
    }
  });
  db.connection.exec('VACUUM; ANALYZE; PRAGMA wal_checkpoint(TRUNCATE)');
}

function resources(db, path) {
  const scalar = sql => Object.values(db.connection.prepare(sql).get())[0];
  return {
    rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    pageSize: scalar('PRAGMA page_size'), pageCount: scalar('PRAGMA page_count'), freePages: scalar('PRAGMA freelist_count'),
    fileBytes: statSync(path).size,
    rollupRows: Object.fromEntries(tables.map(name => [name, scalar(`SELECT count(*) FROM ${name}`)])),
    objects: db.connection.prepare('SELECT name,sum(pgsize) bytes,count(*) pages FROM dbstat GROUP BY name ORDER BY name').all(),
  };
}

function factDigest(db) {
  const hash = createHash('sha256');
  for (const [name, order] of [
    ['turn_summary', 'id'], ['turn_model_usage', 'turn_id,model'], ['turn_capability_usage', 'turn_id,category,name'],
    ['turn_costs', 'turn_id'], ['projects', 'project_key'], ['sessions', 'provider,session_id'], ['session_billing', 'provider,session_id'],
  ]) {
    hash.update(name);
    for (const row of db.connection.prepare(`SELECT * FROM ${name} ORDER BY ${order}`).iterate()) hash.update(JSON.stringify(row));
  }
  return hash.digest('hex');
}

function verify(db, independent) {
  const hashes = [];
  for (const by of ['provider', 'model']) for (const group of ['total', 'day', 'month', 'project', 'session']) {
    const query = buildRollupUsageQueries({}, group, timezone, by).rows;
    const rows = db.connection.prepare(query.sql).all(...query.values, 10000000, 0);
    if (independent) {
      const raw = buildUsageQuery({}, group, timezone, by);
      compareResults(db.connection.prepare(raw.sql).all(...raw.values, 10000000, 0), rows, `${by}/${group}`);
    }
    hashes.push(sha(normalized(rows)));
  }
  for (const name of tables) {
    const hash = createHash('sha256');
    for (const row of db.connection.prepare(`SELECT * FROM ${name} ORDER BY provider,session_id,project_key,local_day${name === tables[1] ? ',model_key' : ''}`).iterate()) hash.update(normalized(row));
    hashes.push(hash.digest('hex'));
  }
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  return { factSha256: factDigest(db), aggregateSha256: sha(hashes.join('')) };
}

function sessionInput(source, all = false) {
  const selected = source.prepare(`SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id
    ORDER BY count(*) DESC,provider,session_id LIMIT 1`).get();
  assert.ok(selected, 'Need at least one request');
  const sessions = all ? source.prepare('SELECT provider,session_id FROM sessions ORDER BY provider,session_id').all() : [selected];
  const models = source.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  const capabilities = source.prepare('SELECT category,name,usage_count FROM turn_capability_usage WHERE turn_id=? ORDER BY category,name');
  const query = source.prepare(`SELECT t.*,p.project_name,s.session_name,c.billing_mode AS billing FROM turn_summary t
    JOIN projects p USING(project_key) JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id
    LEFT JOIN turn_costs c ON c.turn_id=t.id ${all ? '' : 'WHERE t.provider=? AND t.session_id=?'} ORDER BY t.id`);
  function* summaries() {
    for (const { id, ...row } of query.iterate(...(all ? [] : [selected.provider, selected.session_id]))) {
      const modelUsage = models.all(id);
      yield { ...row, model_usage: modelUsage.length ? modelUsage : undefined,
        capability_usage: capabilities.all(id), billing: row.billing ?? 'unknown' };
    }
  }
  return { sessions, files: [], summaries: summaries() };
}

function readSpecs(db, selected) {
  const month = db.connection.prepare(`SELECT substr(local_day,1,length(local_day)-3) period,count(*) n
    FROM usage_request_daily WHERE local_day<>'' GROUP BY period ORDER BY n DESC,period LIMIT 1`).get();
  const cases = [
    { name: 'all-month', group: 'month', filter: {} },
    { name: 'all-session', group: 'session', filter: {} },
    { name: 'all-total', group: 'total', filter: {} },
    { name: 'selected-session', group: 'session', filter: { provider: selected.provider, sessionId: selected.session_id } },
    { name: 'unknown-month', group: 'month', filter: { unknownTime: 'only' } },
  ];
  if (month) cases.push({ name: 'one-month', group: 'month', filter: { ...periodBounds(month.period, timezone), unknownTime: 'exclude' } });
  return { month: month?.period, specs: cases.flatMap(spec => ['provider', 'model'].map(by => ({ ...spec, by }))) };
}

function explain(db, query, values) {
  const plan = db.connection.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...values).map(row => row.detail);
  const opcodes = {};
  for (const row of db.connection.prepare(`EXPLAIN ${query}`).all(...values)) opcodes[row.opcode] = (opcodes[row.opcode] ?? 0) + 1;
  return { plan, opcodes };
}

function measureReads(db, selected, independent, samples) {
  const { month, specs } = readSpecs(db, selected), result = [];
  for (const spec of specs) {
    const query = buildRollupUsageQueries(spec.filter, spec.group, timezone, spec.by);
    assert.equal(query.mode, 'rollup');
    const rows = db.connection.prepare(query.rows.sql), count = db.connection.prepare(query.count.sql);
    const full = rows.all(...query.rows.values, 10000000, 0);
    const total = count.get(...query.count.values).count;
    assert.equal(full.length, total);
    if (independent) {
      const raw = buildUsageQuery(spec.filter, spec.group, timezone, spec.by);
      compareResults(db.connection.prepare(raw.sql).all(...raw.values, 10000000, 0), full, spec.name);
    }
    const plans = { rows: explain(db, query.rows.sql, [...query.rows.values, 100, 0]),
      count: explain(db, query.count.sql, query.count.values) };
    const call = () => db.queryUsagePage(spec.filter, spec.group, timezone, { limit: 100 }, spec.by);
    let value;
    for (let i = 0; i < 2; i++) value = call();
    compareResults(full.slice(0, 100), value.rows, `${spec.name} API`);
    assert.equal(value.total, total);
    const start = performance.now(); call();
    const iterations = Math.min(20, Math.max(1, Math.ceil(5 / Math.max(performance.now() - start, .01))));
    const times = { api: [], rows: [], count: [] };
    for (let sample = 0; sample < samples; sample++) {
      let apiMs = 0, rowsMs = 0, countMs = 0;
      for (let i = 0; i < iterations; i++) {
        const a = performance.now(); value = call(); const b = performance.now();
        rows.all(...query.rows.values, 100, 0); const c = performance.now();
        count.get(...query.count.values); const d = performance.now();
        apiMs += b - a; rowsMs += c - b; countMs += d - c;
      }
      times.api.push(apiMs / iterations); times.rows.push(rowsMs / iterations); times.count.push(countMs / iterations);
    }
    const rawFilter = buildQueryFilter(spec.filter);
    const matchingRequests = db.connection.prepare(`SELECT count(*) n FROM turn_summary WHERE ${rawFilter.sql}`).get(...rawFilter.values).n;
    if (spec.name === 'selected-session') assert.equal(matchingRequests,
      db.connection.prepare('SELECT count(*) n FROM turn_summary WHERE provider=? AND session_id=?').get(selected.provider, selected.session_id).n);
    result.push({ name: spec.name, by: spec.by, group: spec.group, mode: query.mode, matchingRequests,
      totalGroups: total, returnedGroups: value.rows.length, fullResultSha256: sha(normalized(full)), iterationsPerSample: iterations,
      timings: Object.fromEntries(Object.entries(times).map(([key, values]) => [key, stats(values)])),
      plans, sql: { rows: query.rows.sql, count: query.count.sql } });
  }
  return { selectedMonth: month, cases: result };
}

function measureReplay(db, path) {
  for (const name of tables) db.connection.exec(`CREATE TEMP TABLE saved_${name} AS SELECT * FROM ${name}`);
  const samples = [];
  for (let i = 0; i < 4; i++) {
    db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const start = performance.now();
    db.transaction(() => { for (const name of tables) db.connection.exec(`DELETE FROM ${name}; INSERT INTO ${name} SELECT * FROM saved_${name}`); });
    const elapsedMs = performance.now() - start;
    if (i) samples.push({ elapsedMs, walBytes: statSync(`${path}-wal`).size });
  }
  for (const name of tables) db.connection.exec(`DROP TABLE saved_${name}`);
  return samples;
}

function timedReplace(db, input, path) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  let begins = 0, commits = 0;
  const original = db.connection.exec;
  db.connection.exec = function(sql) {
    if (sql.trim() === 'BEGIN IMMEDIATE') begins++;
    if (sql.trim() === 'COMMIT') commits++;
    return original.call(this, sql);
  };
  const start = performance.now();
  try { db.replaceSessions(input); }
  finally { db.connection.exec = original; }
  const elapsedMs = performance.now() - start;
  assert.equal(begins, 1); assert.equal(commits, 1);
  return { elapsedMs, begins, commits, walBytes: statSync(`${path}-wal`).size };
}

async function worker(config) {
  const source = new DatabaseSync(config.snapshot, { readOnly: true }), db = new SummaryDatabase(config.path);
  const started = seoulTime(), cpuStart = process.cpuUsage();
  source.exec('PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA mmap_size=0');
  const independent = config.variant === variants[0] && config.pair === 0;
  try {
    rebuildDailyTables(db, config.variant);
    const initialResources = resources(db, config.path), initialCheck = verify(db, independent);
    const base = sessionInput(source), selected = base.sessions[0], rows = Array.from(base.summaries);
    const reads = measureReads(db, selected, independent, config.readSamples);
    const replay = measureReplay(db, config.path);
    assert.deepEqual(verify(db, false), initialCheck, 'Read/replay changed semantic data');
    const appended = structuredClone(rows.at(-1));
    appended.root_turn_id = 'benchmark-rowid-appended'; appended.started_at_ms = Date.UTC(2026, 9, 27);
    appended.updated_at = '2026-10-27T00:00:00.000Z';
    const moved = structuredClone(rows);
    moved[0].started_at_ms = Date.UTC(2026, 0, 1); moved[0].project_key = '/fixture/rowid-moved'; moved[0].project_name = 'Moved';
    const titled = structuredClone(rows); titled[0].request_title = 'benchmark changed title';
    const cases = [['same-session', rows], ['append-one', [...rows, appended]], ['update-one-title', titled],
      ['update-one-move-day-project', moved], ['delete-one', rows.slice(1)]];
    const writes = [];
    for (const [name, summaries] of cases) {
      db.replaceSessions({ ...base, summaries: rows });
      const value = timedReplace(db, { ...base, summaries }, config.path);
      writes.push({ name, inputTurns: summaries.length, ...value, ...verify(db, independent) });
      console.log(`${config.variant} ${name}: ${value.elapsedMs.toFixed(3)} ms`);
    }
    for (const changed of [false, true]) {
      const input = sessionInput(source, true), original = input.summaries;
      if (changed) input.summaries = (function* () { for (const row of original) yield { ...row, request_title: 'benchmark full title change' }; })();
      const value = timedReplace(db, input, config.path), name = changed ? 'full-changed' : 'full-reapply';
      writes.push({ name, ...value, ...verify(db, independent) });
      console.log(`${config.variant} ${name}: ${value.elapsedMs.toFixed(3)} ms`);
    }
    db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.deepEqual(db.connection.prepare('PRAGMA integrity_check').all().map(r => r.integrity_check), ['ok']);
    return { startedAtSeoul: started, endedAtSeoul: seoulTime(), cpuMicroseconds: process.cpuUsage(cpuStart),
      independentRawValidated: independent, selectedSessionRequests: rows.length, initialCheck, initialResources,
      reads, replay, writes, finalResources: resources(db, config.path),
      schemas: Object.fromEntries(tables.map(name => [name, db.connection.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(name).sql])) };
  } finally { source.close(); db.close(); }
}

function runWorker(config) {
  return new Promise((resolveWorker, reject) => {
    const child = fork(__filename, ['--worker', JSON.stringify(config)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    let result;
    child.on('message', value => { result = value; }); child.on('error', reject);
    child.on('exit', code => code === 0 && result ? resolveWorker(result) : reject(new Error(`Worker failed: ${code}`)));
  });
}

function compareSamples(reference, value) {
  assert.deepEqual(value.initialCheck, reference.initialCheck);
  assert.equal(value.writes.length, reference.writes.length);
  for (let i = 0; i < value.writes.length; i++) for (const field of ['name', 'factSha256', 'aggregateSha256']) assert.equal(value.writes[i][field], reference.writes[i][field]);
  for (let i = 0; i < value.reads.cases.length; i++) for (const field of ['name', 'by', 'matchingRequests', 'totalGroups', 'fullResultSha256']) assert.equal(value.reads.cases[i][field], reference.reads.cases[i][field]);
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const at = arg.indexOf('='); assert.ok(at > 2); return [arg.slice(2, at), arg.slice(at + 1)];
  }));
  const samples = Number(args.samples ?? 3), readSamples = Number(args['read-samples'] ?? 5);
  assert.ok(Number.isInteger(samples) && samples >= 3 && samples <= 15);
  assert.ok(Number.isInteger(readSamples) && readSamples >= 3 && readSamples <= 25);
  const output = resolve(args.output ?? 'docs/benchmarks/SqlRowid-2026-10-27.json');
  assert.ok(!existsSync(output), 'Choose a new output path; existing measurements are preserved');
  const sizes = (args.sizes ?? '280,100000').split(',').map(Number), densities = (args.turns ?? '100,10000').split(',').map(Number);
  assert.ok([...sizes, ...densities].every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000));
  const datasets = sizes.flatMap(size => (size <= 280 ? [10] : densities).map(turns => ({ label: `synthetic-${size}-session-${turns}`, size, turns })));
  if (args['real-db']) datasets.unshift({ label: 'current-local', real: resolve(args['real-db']) });
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-sql-rowid-'));
  const hashes = sourceHashes();
  const report = { createdAtSeoul: seoulTime(), samples, readSamples, sourceSha256: hashes,
    environment: { node: process.version, cpu: cpus()[0].model, platform: process.platform },
    method: {
      comparison: 'Same current incremental product for both variants. Rebuild both daily tables with identical columns, composite PRIMARY KEY, NOT NULL and two existing explicit date/project indexes; only remove WITHOUT ROWID for rowid. Implicit rowid adds no application column; composite PK becomes a separate UNIQUE index. No extra session index.',
      preparation: 'Read-only source backup, deterministic synthetic seed, same frozen snapshot per dataset. Both layouts copied in composite-PK order, VACUUM and ANALYZE before measurement. Separate sequential process per variant/pair; order alternates. Source remains read-only in workers.',
      writes: 'Actual replaceSessions BEGIN IMMEDIATE through COMMIT. Before each sparse case restore original selected session once. Checkpoint TRUNCATE before timing. Full-reapply restores the preceding deleted request and compares all input. Input preparation, verification and checkpoint excluded; streamed full input consumption included.',
      reads: 'Initial identical snapshot before mutations. Public queryUsagePage rows+COUNT limit 100, plus separately prepared rows and COUNT times. Three preparation calls then 5 or configured samples, 1..20 iterations chosen to target 5 ms per sample. All-month has no date filter; one-month uses busiest calendar month range with unknownTime=exclude. Warm cache only.',
      replay: 'Separately timed full daily snapshot DELETE/INSERT transaction; one warmup and three repeats. This is not a request update or an isolated incremental-rollup timing.',
      resources: 'Main object pages from dbstat at compact initial state and after mutations. File bytes/free pages separate; WAL is post-operation file length after pre-operation TRUNCATE, not total device I/O. RSS/heap and lifetime peak include fixture/verification/runtime; no isolated allocation claim.',
      correctness: 'First WITHOUT ROWID process per dataset checks all 5 groupings x provider/model and all read filters against independent raw SQL before/after every mutation. All workers compare complete fact/ID hashes, all aggregate groups, ordered daily-state hashes and read-filter result hashes. Float aggregates normalized to 10 significant digits; raw averages/cost tolerance 1e-9. FK check each state and final integrity_check.',
      excludes: 'No live DB writes, product schema migration, JSONL scanning/parsing, quota, IPC/UI latency, cold I/O or measured read/write production-frequency mix.' },
    datasets: [] };
  const save = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
  try {
    for (const data of datasets) {
      const snapshot = join(directory, `${data.label}-snapshot.sqlite`);
      if (data.real) {
        const source = new DatabaseSync(data.real, { readOnly: true });
        try { source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000'); await backup(source, snapshot); }
        finally { source.close(); }
      } else {
        const db = new SummaryDatabase(snapshot);
        try {
          seed(db, data.size, data.turns);
          db.connection.prepare('UPDATE turn_model_usage SET pricing_version=?').run(PRICING_VERSION);
          db.connection.prepare(`INSERT INTO turn_costs SELECT t.id,'unknown',NULL,max(1,count(m.model)),?
            FROM turn_summary t LEFT JOIN turn_model_usage m ON m.turn_id=t.id GROUP BY t.id`).run(PRICING_VERSION);
        } finally { db.close(); }
      }
      const source = new SummaryDatabase(snapshot);
      let description;
      try {
        source.queryUsagePage({}, 'total', timezone); description = describe(source);
        report.environment.sqlite = source.connection.prepare('SELECT sqlite_version() v').get().v;
      } finally { source.close(); }
      const result = { label: data.label, ...description, snapshotSha256: sha(readFileSync(snapshot)), variants: {} };
      report.datasets.push(result);
      for (let pair = 0; pair < samples; pair++) for (const variant of pair % 2 ? [...variants].reverse() : variants) {
        assert.deepEqual(sourceHashes(), hashes, 'Source changed during benchmark');
        const path = join(directory, `${data.label}-${pair}-${variant}.sqlite`), connection = new DatabaseSync(snapshot, { readOnly: true });
        try { await backup(connection, path); } finally { connection.close(); }
        console.log(`${data.label} pair ${pair + 1}/${samples} ${variant}`);
        const value = await runWorker({ snapshot, path, variant, pair, readSamples });
        if (result.variants[variants[0]]?.[0]) compareSamples(result.variants[variants[0]][0], value);
        (result.variants[variant] ??= []).push(value);
        await save();
      }
    }
    assert.deepEqual(sourceHashes(), hashes);
    report.completedAtSeoul = seoulTime(); report.complete = true; await save();
    console.log(`Saved ${output}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir())); assert.ok(basename(directory).startsWith('agent-tracker-sql-rowid-'));
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') worker(JSON.parse(process.argv[3])).then(value => process.send(value)).catch(error => { console.error(error); process.exitCode = 1; });
else if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
