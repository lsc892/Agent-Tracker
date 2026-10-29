// 저장한 JSONL byte offset 뒤의 신규 요청만 INSERT하는 시제품에서 rowid A/B를 측정한다.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { appendFileSync, closeSync, copyFileSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } = require('node:fs');
const { mkdir, mkdtemp, rm, writeFile } = require('node:fs/promises');
const { cpus, tmpdir } = require('node:os');
const { basename, dirname, join, relative, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { SqliteSession } = require('../../dist/src/summary/db/connection');
const { aggregateUsageSource, buildRollupUsageQueries } = require('../../dist/src/summary/db/rollup-queries');
const { buildUsageQuery } = require('../../dist/src/summary/db/queries');
const { ROLLUP_STATES, ROLLUP_TABLES } = require('../../dist/src/summary/db/rollup-state');
const { compareResults } = require('./sql-rollup.cjs');
const { stats } = require('./sql-explain.cjs');
const { querySourceFiles } = require('./query-source-files.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul';
const variants = ['without-rowid', 'rowid'];
const tables = Object.values(ROLLUP_TABLES);
const sha = value => createHash('sha256').update(value).digest('hex');
const seoulTime = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const canonical = value => JSON.stringify(value, (_key, v) => typeof v === 'number' && !Number.isInteger(v) ? Number(v.toPrecision(10)) : v);
const turnColumns = ['id', 'provider', 'project_key', 'session_id', 'root_turn_id', 'started_at_ms', 'completed_at_ms',
  'duration_ms', 'duration_quality', 'input_tokens', 'output_tokens', 'cache_write_input_tokens', 'cache_read_input_tokens',
  'total_tokens', 'status', 'last_error', 'updated_at'];

function hashes() {
  const paths = ['tests/benchmarks/sql-rowid-append.cjs', 'tests/benchmarks/sql-rollup.cjs', 'tests/benchmarks/sql-explain.cjs',
    'src/summary/db/connection.ts', 'src/summary/db/schema.ts', 'src/summary/db/rollup-state.ts', 'src/summary/db/rollups.ts',
    'dist/src/summary/db/connection.js', 'dist/src/summary/db/schema.js', 'dist/src/summary/db/rollup-state.js',
    'dist/src/summary/db/rollups.js', ...querySourceFiles({ compiled: true })];
  return Object.fromEntries(paths.map(path => [path, sha(readFileSync(join(root, path)))]));
}

function record(index, count, turns, append = false) {
  const sid = append ? 0 : Math.floor(index / turns), provider = sid % 2 ? 'codex' : 'claude';
  const pk = `/fixture/project-${Math.floor(sid / 2) % 20}`, id = index + 1;
  const start = index % 101 === 0 ? null : Date.UTC(2026, 6, 1) + (sid * 17 % 90) * 86400000 + (index % turns) * 60000;
  const status = index % 17 === 0 ? 'failed' : index % 11 === 0 ? 'in_progress' : 'completed';
  const empty = index % 41 === 0, input = empty ? 0 : 1000 + index % 19000, output = empty ? 0 : 100 + index % 1900;
  const cacheWrite = empty ? 0 : index % 67 === 0 ? null : 100, cacheRead = empty ? 0 : index % 71 === 0 ? null : 200;
  const duration = status !== 'completed' || index % 59 === 0 ? null : 1000 + index % 10001;
  const quality = status !== 'completed' ? 'missing' : index % 31 === 0 ? 'approximate' : index % 29 === 0 ? 'derived' : 'exact';
  const values = [id, provider, pk, `session-${sid}`, `request-${index}`, start,
    status === 'completed' && start !== null ? start + 1000 : null, duration, quality,
    input, output, cacheWrite, cacheRead, input + output, status, index % 79 === 0 ? 'fixture error' : null, '2026-10-27T00:00:00.000Z'];
  const models = [];
  if (!(empty && index % 2 === 0 || index % 61 === 0)) {
    const name = index % 53 === 0 || index === 123 ? '' : `${provider}-model-${sid % 3}`;
    if (!empty && index % 5 === 0) {
      models.push([name, input - 200, output - 50, cacheWrite, cacheRead], [`${provider}-helper`, 200, 50, cacheWrite === null ? null : 0, cacheRead === null ? null : 0]);
    } else models.push([name, input, output, cacheWrite, cacheRead]);
  }
  return { values, models };
}

function fixture(path, count, turns) {
  const fd = openSync(path, 'wx');
  try {
    for (let from = 0; from < count; from += 256) {
      const rows = [];
      for (let index = from; index < Math.min(from + 256, count); index++) rows.push(JSON.stringify(record(index, count, turns)) + '\n');
      writeSync(fd, rows.join(''));
    }
  } finally { closeSync(fd); }
  return { sha256: sha(readFileSync(path)), bytes: statSync(path).size };
}

function schema(db, variant) {
  const ddl = [];
  db.transaction(() => {
    for (const table of tables) {
      const original = db.connection.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(table).sql;
      const indexes = db.connection.prepare("SELECT name,sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name").all(table);
      assert.equal(indexes.length, 2);
      db.connection.exec(`DROP TABLE ${table}`);
      db.connection.exec(variant === 'rowid' ? original.replace(/\s+WITHOUT ROWID\b/, '') : original);
      for (const index of indexes) db.connection.exec(index.sql);
      ddl.push({ table, sql: db.connection.prepare('SELECT sql FROM sqlite_schema WHERE name=?').get(table).sql, indexes });
      const actual = db.connection.prepare('PRAGMA table_list').all().find(row => row.name === table && row.schema === 'main');
      assert.equal(actual.wr, variant === 'without-rowid' ? 1 : 0);
    }
    db.connection.exec('CREATE TABLE benchmark_source_cursor(singleton INTEGER PRIMARY KEY CHECK(singleton=1),byte_offset INTEGER NOT NULL,last_id INTEGER NOT NULL); INSERT INTO benchmark_source_cursor VALUES(1,0,0)');
  });
  return ddl;
}

function observeSelects(db) {
  const counts = { selects: 0, persistedFactSelects: 0 };
  const original = db.connection.prepare;
  db.connection.prepare = function(sql) {
    const statement = original.call(this, sql);
    if (/^\s*SELECT\b/i.test(sql)) for (const method of ['get', 'all', 'iterate']) {
      const execute = statement[method];
      statement[method] = function(...args) {
        counts.selects++;
        if (/\bFROM\s+turn_summary\b/i.test(sql)) counts.persistedFactSelects++;
        return execute.apply(this, args);
      };
    }
    return statement;
  };
  return counts;
}

function insertStatements(db) {
  const project = db.statement('INSERT OR IGNORE INTO projects VALUES(?,?)');
  const session = db.statement('INSERT OR IGNORE INTO sessions VALUES(?,?,?)');
  const turn = db.statement(`INSERT INTO turn_summary(${turnColumns.join(',')}) VALUES(${turnColumns.map(() => '?').join(',')})`);
  const model = db.statement('INSERT INTO turn_model_usage VALUES(?,?,?,?,?,?,NULL,?)');
  const merges = Object.fromEntries(['provider', 'model'].map(by => {
    const table = ROLLUP_TABLES[by], keys = `provider,session_id,project_key,local_day${by === 'model' ? ',model_key' : ''}`;
    const updates = ROLLUP_STATES.map(state => {
      const current = `${table}.${state.name}`, incoming = `excluded.${state.name}`;
      const expression = state.merge === 'SUM' ? `${current}+${incoming}`
        : `CASE WHEN ${current} IS NULL THEN ${incoming} WHEN ${incoming} IS NULL THEN ${current} ELSE ${state.merge}(${current},${incoming}) END`;
      return `${state.name}=${expression}`;
    });
    const sql = `INSERT INTO ${table} ${aggregateUsageSource(by, 'id > ? AND id <= ?')} ON CONFLICT(${keys}) DO UPDATE SET ${updates.join(',')}`;
    return [by, { statement: db.statement(sql), sql }];
  }));
  return { project, session, turn, model, merges };
}

/** Bounded chunks, durable byte offset; the fixture contains complete normalized request records. */
function ingest(db, statements, path, activeRollup, observations) {
  const baseline = { ...observations }, started = performance.now();
  const cursor = db.statement('SELECT byte_offset,last_id FROM benchmark_source_cursor WHERE singleton=1').get();
  const size = statSync(path).size;
  assert.ok(size >= cursor.byte_offset, 'Append-only fixture was truncated');
  let readParseMs = 0, rollupMs = 0, rows = 0, models = 0, bodyBytes = 0, lastId = cursor.last_id;
  if (size === cursor.byte_offset) return { elapsedMs: performance.now() - started, readParseMs, dbMs: 0, rollupMs,
    rows, models, bodyBytes, offsetBefore: cursor.byte_offset, offsetAfter: size,
    cursorSelects: observations.selects - baseline.selects, persistedFactSelects: observations.persistedFactSelects - baseline.persistedFactSelects };
  const projects = new Set(), sessions = new Set();
  const writeStarted = performance.now();
  db.transaction(() => {
    const fd = openSync(path, 'r'), buffer = Buffer.alloc(128 * 1024);
    let offset = cursor.byte_offset, trailing = '';
    try {
      while (offset < size) {
        const parsing = performance.now();
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
        assert.ok(count > 0); offset += count; bodyBytes += count;
        const lines = (trailing + buffer.toString('utf8', 0, count)).split('\n');
        trailing = lines.pop();
        const records = lines.map(line => JSON.parse(line));
        readParseMs += performance.now() - parsing;
        for (const row of records) {
          assert.ok(row.values[0] > lastId, 'Fixture records must be new ordered request ids');
          const [, provider, pk, sessionId] = row.values;
          if (!projects.has(pk)) { statements.project.run(pk, basename(pk)); projects.add(pk); }
          const sk = `${provider}/${sessionId}`;
          if (!sessions.has(sk)) { statements.session.run(provider, sessionId, sessionId); sessions.add(sk); }
          statements.turn.run(...row.values);
          for (const usage of row.models) statements.model.run(row.values[0], ...usage, 'fixture');
          lastId = row.values[0]; rows++; models += row.models.length;
        }
      }
      assert.equal(trailing, '', 'Fixture must end in a complete newline');
    } finally { closeSync(fd); }
    if (activeRollup) {
      const rollupStarted = performance.now();
      for (const by of ['provider', 'model']) statements.merges[by].statement.run(timezone, cursor.last_id, lastId);
      rollupMs = performance.now() - rollupStarted;
    }
    db.statement('UPDATE benchmark_source_cursor SET byte_offset=?,last_id=? WHERE singleton=1').run(size, lastId);
  });
  const transactionMs = performance.now() - writeStarted;
  assert.equal(observations.persistedFactSelects - baseline.persistedFactSelects, 0, 'Ingest unexpectedly SELECTed old facts');
  return { elapsedMs: performance.now() - started, readParseMs, dbMs: transactionMs - readParseMs - rollupMs,
    transactionMs, rollupMs, rows, models, bodyBytes, offsetBefore: cursor.byte_offset, offsetAfter: size,
    cursorSelects: observations.selects - baseline.selects, persistedFactSelects: observations.persistedFactSelects - baseline.persistedFactSelects };
}

function verify(db, expected, independent) {
  const counts = db.connection.prepare('SELECT count(*) n,sum(total_tokens) tokens FROM turn_summary').get();
  assert.equal(counts.n, expected);
  const hash = createHash('sha256');
  for (const [table, order] of [['turn_summary', 'id'], ['turn_model_usage', 'turn_id,model'],
    ['projects', 'project_key'], ['sessions', 'provider,session_id'],
    ...tables.map(table => [table, `provider,session_id,project_key,local_day${table === ROLLUP_TABLES.model ? ',model_key' : ''}`])]) {
    hash.update(table);
    for (const row of db.connection.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).iterate()) hash.update(canonical(row));
  }
  const aggregates = [];
  if (independent) for (const by of ['provider', 'model']) for (const grouping of ['total', 'day', 'month', 'project', 'session']) {
    const query = buildRollupUsageQueries({}, grouping, timezone, by).rows, raw = buildUsageQuery({}, grouping, timezone, by);
    const actual = db.connection.prepare(query.sql).all(...query.values, 10000000, 0);
    compareResults(db.connection.prepare(raw.sql).all(...raw.values, 10000000, 0), actual, `${grouping}/${by}`);
    aggregates.push(sha(canonical(actual)));
  }
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  return { requestFacts: counts.n, totalTokens: counts.tokens, stateSha256: hash.digest('hex'),
    independentRawQueries: aggregates.length, aggregateSha256: aggregates.length ? sha(aggregates.join('')) : undefined };
}

function resources(db, path) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const objects = db.connection.prepare('SELECT name,sum(pgsize) bytes,count(*) pages FROM dbstat GROUP BY name ORDER BY name').all();
  const names = new Set([...tables, ...tables.map(table => `sqlite_autoindex_${table}_1`),
    ...tables.flatMap(table => [`idx_${table}_day`, `idx_${table}_project_day`]), 'usage_rollup_meta']);
  return { fileBytes: statSync(path).size, pageSize: db.connection.prepare('PRAGMA page_size').get().page_size,
    pageCount: db.connection.prepare('PRAGMA page_count').get().page_count, freePages: db.connection.prepare('PRAGMA freelist_count').get().freelist_count,
    rollupBytes: objects.filter(row => names.has(row.name)).reduce((sum, row) => sum + row.bytes, 0), objects,
    rssBytes: process.memoryUsage().rss, peakRssBytes: process.resourceUsage().maxRSS * 1024 };
}

function timed(db, path, action) {
  db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const value = action();
  return { ...value, walBytes: statSync(`${path}-wal`).size };
}

function reads(db) {
  const queries = buildRollupUsageQueries({}, 'month', timezone, 'provider');
  const rows = db.connection.prepare(queries.rows.sql), count = db.connection.prepare(queries.count.sql);
  const call = () => { rows.all(...queries.rows.values, 100, 0); count.get(...queries.count.values); };
  for (let index = 0; index < 3; index++) call();
  const samples = [];
  for (let sample = 0; sample < 7; sample++) {
    const start = performance.now(); for (let iteration = 0; iteration < 20; iteration++) call();
    samples.push((performance.now() - start) / 20);
  }
  return { timings: stats(samples), sql: queries,
    plans: { rows: db.connection.prepare(`EXPLAIN QUERY PLAN ${queries.rows.sql}`).all(...queries.rows.values, 100, 0),
      count: db.connection.prepare(`EXPLAIN QUERY PLAN ${queries.count.sql}`).all(...queries.count.values) } };
}

async function worker(config) {
  const started = seoulTime(), path = join(config.directory, 'work.sqlite'), input = join(config.directory, 'work.jsonl');
  copyFileSync(config.fixture, input);
  let db = new SqliteSession(path);
  try {
    const ddl = schema(db, config.variant), pragma = {
      journalMode: db.connection.prepare('PRAGMA journal_mode').get().journal_mode,
      synchronous: db.connection.prepare('PRAGMA synchronous').get().synchronous,
      cacheSize: db.connection.prepare('PRAGMA cache_size').get().cache_size,
      mmapSize: db.connection.prepare('PRAGMA mmap_size').get().mmap_size,
      sqlite: db.connection.prepare('SELECT sqlite_version() v').get().v,
    };
    let observations = observeSelects(db), statements = insertStatements(db);
    const initialFacts = timed(db, path, () => ingest(db, statements, input, false, observations));
    const initialMaterialize = timed(db, path, () => {
      const start = performance.now(); db.rollups.read(timezone, () => undefined);
      return { elapsedMs: performance.now() - start };
    });
    // Give both layouts exactly the same validation/cache workload between timed stages.
    const independent = config.pair >= 0;
    const initialCheck = verify(db, config.count, independent), initialResources = resources(db, path), monthRead = reads(db);
    db.close();
    const opening = performance.now(); db = new SqliteSession(path); const reopenMs = performance.now() - opening;
    observations = observeSelects(db); statements = insertStatements(db);
    const unchanged = timed(db, path, () => ingest(db, statements, input, true, observations));
    assert.equal(unchanged.bodyBytes, 0); assert.equal(unchanged.rows, 0); assert.equal(unchanged.persistedFactSelects, 0);
    appendFileSync(input, JSON.stringify(record(config.count, config.count, config.turns, true)) + '\n');
    const appendOne = timed(db, path, () => ingest(db, statements, input, true, observations));
    assert.equal(appendOne.rows, 1);
    const oneCheck = verify(db, config.count + 1, independent);
    appendFileSync(input, Array.from({ length: 100 }, (_, index) => JSON.stringify(record(config.count + 1 + index, config.count, config.turns, true)) + '\n').join(''));
    const append100 = timed(db, path, () => ingest(db, statements, input, true, observations));
    assert.equal(append100.rows, 100);
    const hundredCheck = verify(db, config.count + 101, independent);
    const unchangedAfter = timed(db, path, () => ingest(db, statements, input, true, observations));
    assert.equal(unchangedAfter.bodyBytes, 0); assert.equal(unchangedAfter.rows, 0); assert.equal(unchangedAfter.persistedFactSelects, 0);
    const plans = Object.fromEntries(['provider', 'model'].map(by => [by,
      db.connection.prepare(`EXPLAIN QUERY PLAN ${statements.merges[by].sql}`).all(timezone, config.count, config.count + 101)]));
    assert.deepEqual(db.connection.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok']);
    return { startedAtSeoul: started, endedAtSeoul: seoulTime(), ddl, pragma,
      stages: { initialFacts, initialMaterialize, initialTotal: { elapsedMs: initialFacts.elapsedMs + initialMaterialize.elapsedMs },
        restartOpen: { elapsedMs: reopenMs }, restartUnchanged: unchanged,
        restartTotal: { elapsedMs: reopenMs + unchanged.elapsedMs }, appendOne, append100, unchangedAfter },
      checks: { initial: initialCheck, appendOne: oneCheck, append100: hundredCheck }, initialResources,
      finalResources: resources(db, path), monthRead, appendMergeSql: Object.fromEntries(['provider', 'model'].map(by => [by, statements.merges[by].sql])), appendPlans: plans };
  } finally { db.close(); }
}

function runWorker(config) {
  return new Promise((resolveWorker, reject) => {
    const child = fork(__filename, ['--worker', JSON.stringify(config)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true });
    let result;
    child.on('message', value => { result = value; }); child.on('error', reject);
    child.on('exit', code => code === 0 && result ? resolveWorker(result) : reject(new Error(`Worker failed: ${code}`)));
  });
}

function checkPair(reference, other) {
  assert.deepEqual(other.pragma, reference.pragma);
  for (let index = 0; index < reference.ddl.length; index++) {
    assert.equal(other.ddl[index].sql.replace(/\s+WITHOUT ROWID\b/, ''), reference.ddl[index].sql.replace(/\s+WITHOUT ROWID\b/, ''));
    assert.deepEqual(other.ddl[index].indexes, reference.ddl[index].indexes);
  }
  for (const stage of Object.keys(reference.checks)) for (const field of ['requestFacts', 'totalTokens', 'stateSha256']) assert.equal(other.checks[stage][field], reference.checks[stage][field]);
  for (const stage of ['initialFacts', 'restartUnchanged', 'appendOne', 'append100', 'unchangedAfter']) {
    for (const field of ['rows', 'models', 'bodyBytes', 'offsetBefore', 'offsetAfter', 'persistedFactSelects']) assert.equal(other.stages[stage][field], reference.stages[stage][field]);
  }
}

async function removeDirectory(directory, parent) {
  assert.equal(dirname(resolve(directory)), resolve(parent));
  await rm(directory, { recursive: true, force: true });
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => { const at = arg.indexOf('='); assert.ok(at > 2); return [arg.slice(2, at), arg.slice(at + 1)]; }));
  const samples = Number(args.samples ?? 5), warmup = Number(args.warmup ?? 1);
  assert.ok(Number.isSafeInteger(samples) && samples >= 3 && samples <= 15);
  assert.ok(Number.isSafeInteger(warmup) && warmup >= 1 && warmup <= 3);
  const sizes = (args.sizes ?? '280,100000').split(',').map(Number), turns = (args.turns ?? '100,10000').split(',').map(Number);
  assert.ok([...sizes, ...turns].every(value => Number.isSafeInteger(value) && value > 0 && value <= 1000000));
  const output = resolve(args.output ?? 'docs/benchmarks/2026-10-27/SqlRowidAppend-2026-10-27.json');
  assert.ok(!existsSync(output), 'Choose a new output path; prior measurements are preserved');
  const sourceSha256 = hashes(), directory = await mkdtemp(join(tmpdir(), 'agent-tracker-rowid-append-'));
  const report = { createdAtSeoul: seoulTime(), samples, warmup, sourceSha256,
    environment: { node: process.version, platform: process.platform, cpu: cpus()[0].model },
    method: {
      input: 'Deterministic normalized request-summary JSONL, not native Claude/Codex transcript format. Each line contains ordered turn column values and model usage. ASCII synthetic fixture; production transcript parser, staging and session reconciliation are excluded.',
      pipeline: 'Read only bytes after a durable DB cursor in bounded 128 KiB chunks; JSON.parse complete request lines; prepared plain request/model INSERTs in one BEGIN IMMEDIATE/COMMIT transaction. Project/session INSERT OR IGNORE for each distinct key in the new chunk of input. Cursor and append facts/rollups commit atomically. New input ids strictly increase. Unchanged checks file size and one cursor row; no source body or prior request SELECT.',
      initial: 'Empty facts/daily tables. Initial facts+cursor INSERT commit timed separately from actual UsageRollupStore.read lazy materialization. initialTotal is the sum; checkpoint and verification between the two timings excluded. Schema construction, fixture generation/copy, prepared statement creation and validation excluded.',
      append: 'Experimental additive UPSERT of aggregateUsageSource filtered to new INTEGER PRIMARY KEY id range, using shared ROLLUP_STATES SUM/MIN/MAX and NULL-safe extrema. One and then 100 complete new requests append to existing session-0, with no old request application SELECT. Native SQLite UNIQUE/FK checks remain. Does not support changed old requests, duplicate natural keys appended at new offsets, file truncation/rotation or incomplete native events.',
      comparison: 'Only daily request/model WITHOUT ROWID differs. Both have identical columns, composite PRIMARY KEY/NOT NULL, four explicit date/project indexes, SQL, PRAGMAs and input bytes. Ordinary rowid introduces its intrinsic separate UNIQUE index for the same composite PK. Original facts and model tables remain unchanged.',
      sampling: 'Separate sequential child process per variant and pair. Excluded warmup pair(s), then AB/BA order alternating per pair. All stages are run once per worker; stats are across process samples. These are warm OS file-cache measurements, not cold I/O. No other benchmark process runs concurrently.',
      correctness: 'Full ordered fact/model/name/daily-state hashes after initial,+1,+100 match across A/B and all measured processes. Every measured process independently compares all provider/model x total/day/month/project/session groups against raw product SQL at all three states; both layouts get the same validation/cache workload. FK check every state, final integrity_check. Float hash canonicalization 10 significant digits; raw averages tolerance 1e-9. Statement execution instrumentation verifies zero standalone application SELECTs from turn_summary in ingest (aggregate INSERT SELECT source range reads are intentionally retained).',
      resources: 'dbstat occupied pages including both daily tables, four secondary indexes, intrinsic UNIQUE indexes and rollup metadata. No VACUUM after ingestion; real insertion growth. File/free pages separate. WAL length after pre-stage TRUNCATE is not total device I/O. Process RSS includes fixtures, validation and runtime.',
      excludes: 'No changes to product source/schema, no real account calls, no native transcript parser, crash injection, quota/IPC/UI, production read/write frequency model or generalized duplicate-log support.' }, datasets: [] };
  const save = async () => { await mkdir(dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n'); };
  try {
    for (const count of sizes) for (const density of count <= 280 ? [10] : turns) {
      const label = `synthetic-${count}-session-${density}`, input = join(directory, `${label}.jsonl`);
      const data = { label, requestFacts: count, turnsPerSession: density, sessions: Math.ceil(count / density), fixture: fixture(input, count, density), variants: {} };
      report.datasets.push(data);
      let reference;
      for (let pair = -warmup; pair < samples; pair++) for (const variant of Math.abs(pair) % 2 ? [...variants].reverse() : variants) {
        assert.deepEqual(hashes(), sourceSha256, 'Source or compiled product changed during measurement');
        const work = await mkdtemp(join(directory, 'sample-'));
        console.log(`${label} ${pair < 0 ? 'warmup' : `pair ${pair + 1}/${samples}`} ${variant}`);
        let value;
        try { value = await runWorker({ directory: work, fixture: input, count, turns: density, variant, pair }); }
        finally { await removeDirectory(work, directory); }
        if (pair < 0) continue;
        if (reference) checkPair(reference, value); else reference = value;
        (data.variants[variant] ??= []).push(value);
        console.log(`  initial ${value.stages.initialTotal.elapsedMs.toFixed(3)} ms, +1 ${value.stages.appendOne.elapsedMs.toFixed(3)} ms, +100 ${value.stages.append100.elapsedMs.toFixed(3)} ms`);
        await save();
      }
      data.summary = Object.fromEntries(variants.map(variant => [variant, {
        stages: Object.fromEntries(Object.keys(data.variants[variant][0].stages).map(stage => [stage,
          Object.fromEntries(['elapsedMs', 'readParseMs', 'dbMs', 'rollupMs', 'walBytes'].filter(field => data.variants[variant][0].stages[stage][field] !== undefined)
            .map(field => [field, stats(data.variants[variant].map(value => value.stages[stage][field]))]))])),
        initialRollupBytes: data.variants[variant][0].initialResources.rollupBytes,
        finalRollupBytes: data.variants[variant][0].finalResources.rollupBytes,
        monthRead: stats(data.variants[variant].map(value => value.monthRead.timings.medianMs)),
      }]));
      await save();
    }
    assert.deepEqual(hashes(), sourceSha256);
    report.completedAtSeoul = seoulTime(); report.complete = true; await save();
    console.log(`Saved ${relative(root, output)}`);
  } finally {
    assert.ok(basename(directory).startsWith('agent-tracker-rowid-append-'));
    await removeDirectory(directory, tmpdir());
  }
}

if (process.argv[2] === '--worker') worker(JSON.parse(process.argv[3])).then(value => process.send(value)).catch(error => { console.error(error); process.exitCode = 1; });
else if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
