// 고정 DB 사본에서 실제 세션 저장과 월/일 배치 후보를 교차 측정한다.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync, statSync, existsSync } = require('node:fs');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { cpus, tmpdir } = require('node:os');
const { resolve, join, dirname, basename } = require('node:path');
const { performance } = require('node:perf_hooks');
const { DatabaseSync, backup } = require('node:sqlite');
const { SummaryDatabase } = require('../../dist/src/summary/db');
const { buildRollupUsageQueries } = require('../../dist/src/summary/db/rollup-queries');
const { seed, compareResults } = require('./sql-rollup.cjs');
const { describe, stats } = require('./sql-explain.cjs');
const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const sha = value => createHash('sha256').update(value).digest('hex');
const variants = ['before', 'incremental', 'session-period', 'month-session', 'month-model', 'day-provider'];
const writesProduct = variant => ['before', 'incremental', 'session-period'].includes(variant);

function layout(db, variant) {
  if (!['month-session', 'month-model', 'day-provider'].includes(variant)) return;
  db.transaction(() => {
    for (const name of ['usage_request_daily', 'usage_model_daily']) {
      let sql = db.connection.prepare('SELECT sql FROM sqlite_master WHERE name=?').get(name).sql;
      const model = name === 'usage_model_daily';
      let key = variant === 'day-provider' ? 'local_day,provider,session_id,project_key' : 'local_month,provider,session_id,project_key,local_day';
      if (model) key = variant === 'month-model' ? 'local_month,provider,model_key,session_id,project_key,local_day' : `${key},model_key`;
      sql = sql.replace(`CREATE TABLE ${name}`, `CREATE TABLE ${name}_candidate`)
        .replace(/PRIMARY KEY\([^\n]+\)/, `${variant === 'day-provider' ? '' : 'local_month TEXT NOT NULL,\n'}PRIMARY KEY(${key})`);
      db.connection.exec(sql);
      db.connection.exec(`INSERT INTO ${name}_candidate SELECT *${variant === 'day-provider' ? '' : ",substr(local_day,1,7)"} FROM ${name};
        DROP TABLE ${name}; ALTER TABLE ${name}_candidate RENAME TO ${name};
        CREATE INDEX idx_${name}_day ON ${name}(local_day,provider);
        CREATE INDEX idx_${name}_project_day ON ${name}(provider,project_key,local_day);
        CREATE INDEX idx_${name}_session ON ${name}(provider,session_id);`);
      if (model) db.connection.exec(`CREATE INDEX idx_${name}_model ON ${name}(provider,model_key,local_day)`);
    }
  });
}

function inputFor(db, all = false) {
  const session = db.connection.prepare(`SELECT provider,session_id FROM turn_summary GROUP BY provider,session_id
    ORDER BY count(*) DESC,provider,session_id LIMIT 1`).get();
  const sessions = all ? db.connection.prepare('SELECT provider,session_id FROM sessions ORDER BY provider,session_id').all() : [session];
  const models = db.connection.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  const capabilities = db.connection.prepare('SELECT category,name,usage_count FROM turn_capability_usage WHERE turn_id=? ORDER BY category,name');
  const rows = db.connection.prepare(`SELECT t.*,p.project_name,s.session_name,c.billing_mode AS billing FROM turn_summary t
    JOIN projects p USING(project_key) JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id
    LEFT JOIN turn_costs c ON c.turn_id=t.id ${all ? '' : 'WHERE t.provider=? AND t.session_id=?'} ORDER BY t.id`);
  function* summaries() {
    for (const { id, ...row } of rows.iterate(...(all ? [] : [session.provider, session.session_id]))) {
      // A separate connection supplies this iterator, so mutations cannot change its cursor.
      const modelUsage = models.all(id);
      yield { ...row, model_usage: modelUsage.length ? modelUsage : undefined, capability_usage: capabilities.all(id), billing: row.billing ?? 'unknown' };
    }
  }
  return { sessions, files: [], summaries: summaries() };
}

function semanticDigest(db) {
  const hash = createHash('sha256');
  for (const [name, query] of [
    ['turn', 'SELECT * FROM turn_summary ORDER BY provider,session_id,root_turn_id'],
    ['model', 'SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_model_usage m JOIN turn_summary t ON t.id=m.turn_id ORDER BY t.provider,t.session_id,t.root_turn_id,m.model'],
    ['capability', 'SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_capability_usage m JOIN turn_summary t ON t.id=m.turn_id ORDER BY t.provider,t.session_id,t.root_turn_id,m.category,m.name'],
    ['cost', 'SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_costs m JOIN turn_summary t ON t.id=m.turn_id ORDER BY t.provider,t.session_id,t.root_turn_id'],
  ]) {
    hash.update(name);
    for (const value of db.connection.prepare(query).iterate()) {
      const row = { ...value }; delete row.id; delete row.turn_id;
      hash.update(JSON.stringify(row));
    }
  }
  return hash.digest('hex');
}

function resources(db) {
  return { rssBytes: process.memoryUsage().rss, heapUsedBytes: process.memoryUsage().heapUsed,
    peakRssBytes: process.resourceUsage().maxRSS * 1024,
    objects: db.connection.prepare('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY name').all() };
}

function verify(db, independent = false) {
  const raw = require('../../dist/src/summary/db/queries');
  const hashes = [];
  for (const by of ['provider', 'model']) for (const group of ['total', 'day', 'month', 'project', 'session']) {
    const roll = buildRollupUsageQueries({}, group, timezone, by).rows;
    const query = raw.buildUsageQuery({}, group, timezone, by);
    const b = db.connection.prepare(roll.sql).all(...roll.values, 10000000, 0);
    if (independent) {
      const a = db.connection.prepare(query.sql).all(...query.values, 10000000, 0);
      compareResults(a, b, `${by}/${group}`);
    }
    hashes.push(sha(JSON.stringify(b, (_key, value) => typeof value === 'number' && !Number.isInteger(value) ? Number(value.toPrecision(10)) : value)));
  }
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  return sha(hashes.join(''));
}

async function worker(config) {
  const Before = require(join(config.baseline, 'dist/src/summary/db')).SummaryDatabase;
  const Db = config.variant === 'before' ? Before : SummaryDatabase;
  const sourceConnection = new DatabaseSync(config.snapshot, { readOnly: true });
  sourceConnection.exec('PRAGMA query_only=ON; PRAGMA cache_size=-4096; PRAGMA mmap_size=0');
  const source = { connection: sourceConnection, close: () => sourceConnection.close() }, db = new Db(config.path);
  const records = [];
  const check = () => verify(db, !config.referenceValidated && config.variant === 'before' && config.pair === 0);
  try {
    db.queryUsagePage({}, 'total', timezone);
    const initialRollupDigest = check();
    if (config.variant === 'session-period') db.connection.exec('CREATE INDEX bench_summary_session_period ON turn_summary(provider,session_id,started_at_ms)');
    // Index layouts only: write API stays on the incremental product variant. Candidate
    // schemas have an extra month column, so their write cost is measured by replaying
    // the same resulting daily snapshot, separately from replaceSessions below.
    layout(db, config.variant);
    {
      db.connection.exec('ANALYZE');
      const tables = ['usage_request_daily', 'usage_model_daily'];
      for (const name of tables) db.connection.exec(`CREATE TEMP TABLE saved_${name} AS SELECT * FROM ${name}`);
      for (let i = 0; i < 4; i++) {
        db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        const start = performance.now();
        db.transaction(() => { for (const name of tables) db.connection.exec(`DELETE FROM ${name}; INSERT INTO ${name} SELECT * FROM saved_${name}`); });
        if (i) records.push({ name: 'layout-full-rollup-replay', elapsedMs: performance.now() - start, walBytes: statSync(`${config.path}-wal`).size });
      }
    }
    if (writesProduct(config.variant)) {
      const selected = inputFor(source), rows = Array.from(selected.summaries);
      // Materializing only the selected session is fixture preparation, outside timing.
      const append = structuredClone(rows.at(-1)); append.root_turn_id = 'benchmark-appended-turn';
      append.started_at_ms = Date.UTC(2026, 9, 26); append.updated_at = '2026-10-26T00:00:00.000Z';
      const changed = structuredClone(rows); changed[0].request_title = 'benchmark changed title';
      changed[0].started_at_ms = Date.UTC(2026, 0, 1); changed[0].project_key = '/fixture/moved'; changed[0].project_name = 'Moved';
      const cases = [['same-session', rows], ['append-one', [...rows, append]], ['update-one-move-day-project', changed], ['delete-one', rows.slice(1)]];
      for (const [name, summaries] of cases) {
        db.replaceSessions({ ...selected, summaries: rows });
        db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        let begins = 0, commits = 0;
        const exec = db.connection.exec;
        db.connection.exec = function(sql) { if (sql.trim() === 'BEGIN IMMEDIATE') begins++; if (sql.trim() === 'COMMIT') commits++; return exec.call(this, sql); };
        const start = performance.now();
        try { db.replaceSessions({ ...selected, summaries }); }
        finally { db.connection.exec = exec; }
        const elapsedMs = performance.now() - start;
        assert.equal(begins, 1); assert.equal(commits, 1);
        records.push({ name, elapsedMs, begins, commits, inputTurns: summaries.length, walBytes: statSync(`${config.path}-wal`).size,
          digest: semanticDigest(db), rollupDigest: check() });
        console.log(`${config.variant} ${name}: ${elapsedMs.toFixed(3)} ms`);
      }
      for (const changed of [false, true]) {
        const input = inputFor(source, true), original = input.summaries;
        if (changed) input.summaries = (function* () { for (const row of original) yield { ...row, request_title: 'full replacement change' }; })();
        db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        const start = performance.now(); db.replaceSessions(input);
        records.push({ name: changed ? 'full-changed' : 'full-unchanged', elapsedMs: performance.now() - start,
          walBytes: statSync(`${config.path}-wal`).size, digest: semanticDigest(db), rollupDigest: check() });
        console.log(`${config.variant} ${records.at(-1).name}: ${records.at(-1).elapsedMs.toFixed(3)} ms`);
      }
    }
    const reads = [];
    for (const by of ['provider', 'model']) for (const group of ['month', 'session', 'total']) {
      const query = buildRollupUsageQueries({}, group, timezone, by);
      const plan = db.connection.prepare(`EXPLAIN QUERY PLAN ${query.rows.sql}`).all(...query.rows.values, 100, 0).map(r => r.detail);
      const opcodes = {};
      for (const r of db.connection.prepare(`EXPLAIN ${query.rows.sql}`).all(...query.rows.values, 100, 0)) opcodes[r.opcode] = (opcodes[r.opcode] ?? 0) + 1;
      const times = [];
      for (let i = 0; i < 4; i++) { const start = performance.now(); db.queryUsagePage({}, group, timezone, { limit: 100 }, by); if (i) times.push(performance.now() - start); }
      reads.push({ by, group, timing: stats(times), plan, opcodes, sql: query.rows.sql });
    }
    db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { records, reads, resources: resources(db), initialRollupDigest, rollupDigest: check() };
  } finally { source.close(); db.close(); }
}

function runWorker(config) {
  return new Promise((resolveWorker, reject) => {
    const child = fork(__filename, ['--worker', JSON.stringify(config)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    let result;
    child.on('message', message => { result = message; }); child.on('error', reject);
    child.on('exit', code => code === 0 && result ? resolveWorker(result) : reject(new Error(`Worker failed: ${code}`)));
  });
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(s => { const i = s.indexOf('='); assert.ok(i > 2); return [s.slice(2, i), s.slice(i + 1)]; }));
  assert.ok(args.baseline, '--baseline required');
  const baseline = resolve(args.baseline), output = resolve(args.output ?? 'docs/benchmarks/SqlWrites-2026-10-26.json');
  const expected = args.expected ? JSON.parse(readFileSync(resolve(args.expected), 'utf8')) : undefined;
  const selectedVariants = args.variants ? args.variants.split(',') : variants;
  assert.ok(selectedVariants.every(v => variants.includes(v)));
  const samples = Number(args.samples ?? 3); assert.ok(Number.isInteger(samples) && samples >= 3);
  const dir = await mkdtemp(join(tmpdir(), 'agent-tracker-sql-writes-'));
  const sourcePaths = ['src/summary/db/sessions.ts', 'src/summary/db/rollups.ts', 'src/summary/db/billing.ts', 'tests/benchmarks/sql-writes.cjs'];
  const report = { createdAtSeoul: new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date()),
    environment: { node: process.version, cpu: cpus()[0].model, platform: process.platform }, samples,
    sourceSha256: Object.fromEntries(sourcePaths.map(p => [p, sha(readFileSync(join(root, p)))])),
    method: { writes: 'Actual replaceSessions including BEGIN IMMEDIATE/COMMIT; input preparation, checkpoints, digest and EXPLAIN excluded. One reset before each sparse case warms the path. Three or more independent-process pairs in alternating order. Default WAL autocheckpoint and synchronous settings preserved.',
      layout: 'Daily rollup WITHOUT ROWID physical PK candidates, full daily-table replay transaction measured separately from replaceSessions. Other facts retain stable integer IDs. Existing date/project secondary indexes plus session and model secondaries on candidates. Extra stored month is derived from local_day.',
      reads: 'Public queryUsagePage with rows+COUNT, limit=100; first read excluded, 3 warm repetitions per process, same final full-changed input for product variants; layout candidates retain initial input, with numeric distributions unchanged by title-only full-changed.',
      memory: 'Fresh process per pair/variant; RSS/heap after verification and lifetime peak include fixture/result allocations, not an isolated transaction peak. Main DB object bytes from dbstat after checkpoint. No RSS fixed-bound claims.',
      correctness: 'Fact hashes normalize only physical row IDs; first baseline process independently checks every sparse/full mutation against raw SQL for both bases and 5 groupings (1e-9 relative float tolerance). All pairs compare before/after fact and complete rollup hashes; noninteger aggregate values use 10 significant digits to ignore floating accumulation order. Layout candidates compare the initial snapshot, product writes compare each resulting mutation. foreign_key_check on each mutation.',
      excludes: 'No JSONL parsing, discovery, worker IPC, quota calls or VS Code rendering. Warm OS cache; no cold I/O or 3-second UI freeze claim.' },
    baseline: JSON.parse(readFileSync(join(baseline, 'manifest.json'), 'utf8')), datasets: [] };
  if (expected) report.reference = { sha256: sha(readFileSync(resolve(args.expected))), sourceSha256: expected.sourceSha256,
    method: 'Reuses independently validated baseline samples on a byte-identical normalized SQLite snapshot; each final fact and aggregate hash is checked again.' };
  try {
    const sizes = (args.sizes ?? '280,100000').split(',').map(Number);
    assert.ok(sizes.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000));
    const densities = (args.turns ?? '100,10000').split(',').map(Number);
    assert.ok(densities.every(n => Number.isSafeInteger(n) && n > 0 && n <= 1000000));
    const datasets = sizes.flatMap(size => (size <= 280 ? [10] : densities).map(turns => ({ label: `synthetic-${size}-session-${turns}`, size, turns })));
    if (args['real-db']) datasets.unshift({ label: 'current-local', real: resolve(args['real-db']) });
    for (const data of datasets) {
      const snapshot = join(dir, `${data.label}-snapshot.sqlite`);
      if (data.real) {
        assert.ok(existsSync(data.real));
        const source = new DatabaseSync(data.real, { readOnly: true });
        try { source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000'); await backup(source, snapshot); } finally { source.close(); }
      } else {
        const db = new SummaryDatabase(snapshot);
        try {
          seed(db, data.size, data.turns);
          // Match the persisted product pricing format; avoid counting an artificial
          // fixture-version migration as an unchanged write benchmark.
          const version = require('../../dist/src/summary/pricing').PRICING_VERSION;
          db.connection.prepare('UPDATE turn_model_usage SET pricing_version=?').run(version);
          db.connection.prepare(`INSERT INTO turn_costs SELECT t.id,'unknown',NULL,max(1,count(m.model)),?
            FROM turn_summary t LEFT JOIN turn_model_usage m ON m.turn_id=t.id GROUP BY t.id`).run(version);
        } finally { db.close(); }
      }
      const db = new SummaryDatabase(snapshot);
      let description;
      try { db.queryUsagePage({}, 'total', timezone); description = describe(db); } finally { db.close(); }
      const versionDb = new DatabaseSync(':memory:');
      report.environment.sqlite = versionDb.prepare('SELECT sqlite_version() v').get().v; versionDb.close();
      const result = { label: data.label, ...description, snapshotSha256: sha(readFileSync(snapshot)), variants: {} };
      const reference = expected?.datasets.find(d => d.label === data.label);
      if (expected) {
        assert.ok(reference, `Reference missing ${data.label}`);
        assert.equal(result.snapshotSha256, reference.snapshotSha256, 'Reference snapshot must be byte-identical');
      }
      for (let pair = 0; pair < samples; pair++) for (const variant of pair % 2 ? [...selectedVariants].reverse() : selectedVariants) {
        const path = join(dir, `${data.label}-${pair}-${variant}.sqlite`), source = new DatabaseSync(snapshot, { readOnly: true });
        try { await backup(source, path); } finally { source.close(); }
        console.log(`${data.label} pair ${pair + 1}/${samples} ${variant}`);
        const value = await runWorker({ baseline, snapshot, path, variant, pair, referenceValidated: !!reference });
        (result.variants[variant] ??= []).push(value);
        const before = result.variants.before?.[pair], after = result.variants.incremental?.[pair];
        if (before && after) for (let i = 0; i < before.records.length; i++) {
          assert.equal(before.records[i].digest, after.records[i].digest, `${data.label} ${before.records[i].name} facts`);
          assert.equal(before.records[i].rollupDigest, after.records[i].rollupDigest, `${data.label} ${before.records[i].name} aggregates`);
        }
        if (writesProduct(variant) && result.variants.before?.[0]) {
          const expected = result.variants.before[0];
          for (let i = 0; i < value.records.length; i++) {
            assert.equal(value.records[i].digest, expected.records[i].digest, `${variant} facts across pairs`);
            assert.equal(value.records[i].rollupDigest, expected.records[i].rollupDigest, `${variant} rollups across pairs`);
          }
        }
        if (reference && writesProduct(variant)) for (let i = 0; i < value.records.length; i++) {
          assert.equal(value.records[i].digest, reference.variants.before[0].records[i].digest, `${variant} reference facts`);
          assert.equal(value.records[i].rollupDigest, reference.variants.before[0].records[i].rollupDigest, `${variant} reference aggregates`);
        }
        if (result.variants.before?.[0]) assert.equal(value.rollupDigest,
          writesProduct(variant) ? result.variants.before[0].rollupDigest : result.variants.before[0].initialRollupDigest, `${variant} final complete aggregates`);
      }
      report.datasets.push(result);
      await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    }
    console.log(`Saved ${output}`);
  } finally {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('agent-tracker-sql-writes-'));
    await rm(dir, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') worker(JSON.parse(process.argv[3])).then(value => process.send(value)).catch(error => { console.error(error); process.exitCode = 1; });
else if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
