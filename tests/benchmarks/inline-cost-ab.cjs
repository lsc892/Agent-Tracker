// 비용 별도/통합 워크트리의 공개 조회·저장·스키마 전환·공간을 같은 DB 사본으로 비교한다.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const { mkdtemp, mkdir, rm, writeFile } = require('node:fs/promises');
const { tmpdir, cpus } = require('node:os');
const { join, resolve, dirname, basename, relative } = require('node:path');
const { DatabaseSync, backup } = require('node:sqlite');
const { performance } = require('node:perf_hooks');
const { costSource, requestSource } = require('./cost-storage.cjs');

const root = resolve(__dirname, '../..'), timezone = 'Asia/Seoul', DAY = 86400000;
const variants = ['A', 'B'];
const sha = value => createHash('sha256').update(value).digest('hex');
const time = () => new Intl.DateTimeFormat('sv-SE', { timeZone: timezone, dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const order = pair => pair % 2 ? ['B', 'A'] : variants;
function canonical(value) {
  return JSON.stringify(value, (_key, item) => typeof item === 'number' && !Number.isInteger(item)
    ? Number(item.toPrecision(12)) : item);
}
function normalize(row) {
  return Object.fromEntries(Object.keys(row).sort().filter(key => !['id', 'turn_id', 'updated_at', 'last_successful_update'].includes(key))
    .map(key => [key, row[key]]));
}
const digestRows = rows => sha(canonical(rows.map(normalize)));
function stats(values) {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2);
  return { medianMs: sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: values };
}
function comparison(samples, field) {
  const a = stats(samples.A.map(sample => sample[field])), b = stats(samples.B.map(sample => sample[field]));
  return { A: a, B: b, changePercent: (b.medianMs / a.medianMs - 1) * 100,
    bFasterPairs: samples.A.filter((sample, i) => samples.B[i][field] < sample[field]).length,
    pairedDifferenceMs: stats(samples.A.map((sample, i) => samples.B[i][field] - sample[field])) };
}
function optionsFor(args) {
  const options = { before: resolve(root, 'tests/.cache/inline-cost-ab-20261103/a'),
    after: resolve(root, 'tests/.cache/inline-cost-ab-20261103/b'),
    realDb: join(process.env.APPDATA, 'Code/User/globalStorage/agenttracker.agent-tracker/agent-tracker.sqlite'),
    output: resolve(root, 'tests/results/benchmarks/inline-cost-ab.json'), pairs: 5, readPairs: 9, iterations: 3, smoke: false };
  for (const arg of args) {
    if (arg === '--smoke') options.smoke = true;
    else if (arg.startsWith('--before=')) options.before = resolve(arg.slice(9));
    else if (arg.startsWith('--after=')) options.after = resolve(arg.slice(8));
    else if (arg.startsWith('--real-db=')) options.realDb = resolve(arg.slice(10));
    else if (arg.startsWith('--output=')) options.output = resolve(arg.slice(9));
    else throw new Error(`Unknown option ${arg}`);
  }
  if (options.smoke) Object.assign(options, { pairs: 1, readPairs: 3, iterations: 1 });
  assert.ok(!fs.existsSync(options.output), 'Use a new report path');
  return options;
}
function sourceHashes(path) {
  const files = [];
  for (const directory of ['src', 'dist/src']) for (const file of fs.readdirSync(join(path, directory), { recursive: true })) {
    if (/\.(ts|js)$/.test(file)) files.push(join(directory, file));
  }
  files.push('package-lock.json');
  return Object.fromEntries(files.sort().map(file => [file.replaceAll('\\', '/'), sha(fs.readFileSync(join(path, file)))]));
}
function load(path) {
  return { Database: require(join(path, 'dist/src/summary/db')).SummaryDatabase,
    raw: require(join(path, 'dist/src/summary/db/queries')),
    rollup: require(join(path, 'dist/src/summary/db/rollup-queries')),
    schema: require(join(path, 'dist/src/summary/db/schema')).SCHEMA_VERSION };
}
function inventory(db) {
  const c = db.connection;
  return { ...c.prepare(`SELECT count(*) requests,count(DISTINCT project_key) projects,sum(total_tokens) tokens,
      min(started_at_ms) earliestMs,max(started_at_ms) latestMs FROM turn_summary`).get(),
    sessions: c.prepare('SELECT count(*) n FROM sessions').get().n,
    models: c.prepare('SELECT count(*) n FROM turn_model_usage').get().n,
    sourceFiles: c.prepare('SELECT count(*) n FROM manifest').get().n,
    maxSessionRequests: c.prepare('SELECT max(n) n FROM (SELECT count(*) n FROM turn_summary GROUP BY provider,session_id)').get().n,
    billing: c.prepare(`SELECT billing_mode,count(*) requests FROM ${costSource(c)} GROUP BY billing_mode`).all() };
}
function factsHash(db) {
  const c = db.connection, h = createHash('sha256');
  const queries = [
    ['requests', `SELECT * FROM ${requestSource(c)} ORDER BY provider,session_id,root_turn_id`],
    ['models', `SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_summary t JOIN turn_model_usage m ON m.turn_id=t.id
      ORDER BY t.provider,t.session_id,t.root_turn_id,m.model`],
    ['capabilities', `SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_summary t JOIN turn_capability_usage m ON m.turn_id=t.id
      ORDER BY t.provider,t.session_id,t.root_turn_id,m.category,m.name`],
    ['costs', `SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_summary t JOIN ${costSource(c)} m ON m.turn_id=t.id
      ORDER BY t.provider,t.session_id,t.root_turn_id`],
    ['projects', 'SELECT * FROM projects ORDER BY project_key'], ['sessions', 'SELECT * FROM sessions ORDER BY provider,session_id'],
    ['billing', 'SELECT * FROM session_billing ORDER BY provider,session_id'],
    ['manifest', 'SELECT * FROM manifest ORDER BY id'],
  ];
  for (const [name, sql] of queries) {
    h.update(name);
    for (const row of c.prepare(sql).iterate()) h.update(canonical(normalize(row)));
  }
  return h.digest('hex');
}
function integrity(db) {
  assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
}
function space(db, path) {
  const c = db.connection;
  c.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const pageSize = c.prepare('PRAGMA page_size').get().page_size,
    pages = c.prepare('PRAGMA page_count').get().page_count,
    freePages = c.prepare('PRAGMA freelist_count').get().freelist_count;
  let objects;
  try { objects = c.prepare('SELECT name,count(*) pages,sum(pgsize) allocatedBytes,sum(payload) payloadBytes FROM dbstat GROUP BY name ORDER BY name').all(); }
  catch { objects = null; }
  return { fileBytes: fs.statSync(path).size, pageSize, pages, freePages, livePageBytes: (pages - freePages) * pageSize,
    tables: c.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r => r.name), objects };
}
function syntheticRows(count, turnsPerSession) {
  return Array.from({ length: count }, (_, i) => {
    const sid = Math.floor(i / turnsPerSession), provider = sid % 2 ? 'codex' : 'claude';
    const input = i % 41 ? 1000 + i % 1900 : 0, output = input ? 100 + i % 190 : 0;
    const start = i % 101 ? Date.UTC(2026, 7, 1 + i % 90, 0, i % 60) : null;
    const status = i % 17 === 0 ? 'failed' : i % 11 === 0 ? 'in_progress' : 'completed';
    const model = provider === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6';
    const models = input && i % 5 === 0 ? [
      { model, input_tokens: input - 200, output_tokens: output - 50, cache_write_input_tokens: 0, cache_read_input_tokens: 0 },
      { model: provider === 'codex' ? 'gpt-5.4' : 'claude-haiku-4-5', input_tokens: 200, output_tokens: 50, cache_write_input_tokens: 0, cache_read_input_tokens: 0 },
    ] : [{ model: i % 53 ? model : '', input_tokens: input, output_tokens: output, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }];
    return { provider, project_key: `/fixture/project-${sid % 20}`, project_name: `Project ${sid % 20}`,
      session_id: `session-${sid}`, session_name: `Session ${sid}`, root_turn_id: `request-${i}`, request_title: `Fixture ${i}`,
      started_at_ms: start, completed_at_ms: start !== null && status === 'completed' ? start + 1000 : null,
      duration_ms: status === 'completed' ? 1000 + i : null, duration_quality: status === 'completed' ? 'exact' : 'missing',
      input_tokens: input, output_tokens: output, cache_write_input_tokens: 0, cache_read_input_tokens: 0, total_tokens: input + output,
      status, updated_at: '2026-11-03T00:00:00.000Z', billing: ['api', 'subscription', 'unknown'][i % 3],
      model_usage: !input && i % 2 === 0 ? undefined : models,
      capability_usage: i % 7 === 0 ? [{ category: 'skill', name: 'fixture-skill', usage_count: 1 }] : [] };
  });
}
function inputFrom(db) {
  const c = db.connection;
  const models = c.prepare('SELECT model,input_tokens,output_tokens,cache_write_input_tokens,cache_read_input_tokens FROM turn_model_usage WHERE turn_id=? ORDER BY model');
  const caps = c.prepare('SELECT category,name,usage_count FROM turn_capability_usage WHERE turn_id=? ORDER BY category,name');
  const rows = c.prepare(`SELECT t.*,p.project_name,s.session_name,coalesce(b.billing_mode,c.billing_mode,'unknown') AS billing
    FROM turn_summary t JOIN projects p ON p.project_key=t.project_key
    JOIN sessions s ON s.provider=t.provider AND s.session_id=t.session_id
    LEFT JOIN session_billing b ON b.provider=t.provider AND b.session_id=t.session_id
    LEFT JOIN ${costSource(c)} c ON c.turn_id=t.id ORDER BY t.id`).all().map(({ id, ...row }) => {
    const model_usage = models.all(id);
    return { ...row, model_usage: model_usage.length ? model_usage : undefined, capability_usage: caps.all(id) };
  });
  const sessions = [...new Map(rows.map(row => [JSON.stringify([row.provider, row.session_id]),
    { provider: row.provider, session_id: row.session_id }])).values()];
  return { rows, sessions, manifests: c.prepare('SELECT * FROM manifest ORDER BY id').all() };
}
function selectedInput(input) {
  const grouped = new Map();
  for (const row of input.rows) {
    const key = JSON.stringify([row.provider, row.session_id]);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const rows = [...grouped.values()].sort((a, b) => b.length - a.length)[0];
  assert.ok(rows?.length);
  return { rows, sessions: [{ provider: rows[0].provider, session_id: rows[0].session_id }], manifests: [] };
}
function readSpecs(db) {
  const c = db.connection, end = c.prepare('SELECT max(started_at_ms) n FROM turn_summary').get().n + DAY;
  const project = c.prepare('SELECT provider,project_key FROM turn_summary GROUP BY provider,project_key ORDER BY count(*) DESC,provider,project_key LIMIT 1').get();
  const specs = [];
  for (const costs of [false, true]) for (const by of ['provider', 'model']) {
    const base = { providers: ['claude', 'codex'], includeCosts: costs, excludeEmptyUsage: true };
    for (const group of ['total', 'day', 'month', 'project', 'session']) {
      specs.push({ name: `${costs ? 'costs-on' : 'costs-off'}/${group}/${by}`, filter: base, group, by });
    }
    specs.push({ name: `${costs ? 'costs-on' : 'costs-off'}/project-month-30d/${by}`, group: 'month', by,
      filter: { ...base, ...{ provider: project.provider, projectKey: project.project_key }, fromMs: end - 30 * DAY, toMs: end, unknownTime: 'exclude' } });
    specs.push({ name: `${costs ? 'costs-on' : 'costs-off'}/average-7d/${by}`, group: 'total', by,
      filter: { ...base, fromMs: end - 7 * DAY, toMs: end, unknownTime: 'exclude' } });
    specs.push({ name: `${costs ? 'costs-on' : 'costs-off'}/turns/${by}`, group: 'turn', by, filter: base });
  }
  return specs;
}
function page(db, spec) {
  return db.queryUsagePage(spec.filter, spec.group, timezone, { limit: 100, offset: 0, tableSort: { key: 'period', direction: 'desc' } }, spec.by);
}
function pageDigest(result) {
  return { count: result.total, rows: result.rows.length, sha256: digestRows(result.rows) };
}
function plans(db, api, spec) {
  if (spec.group === 'turn') {
    const where = api.raw.buildQueryFilter(spec.filter), rows = api.raw.buildTurnsQuery(where, spec.filter.includeCosts, spec.by, true, { key: 'period', direction: 'desc' });
    const count = api.raw.buildTurnsCountQuery(spec.filter, spec.by);
    return { mode: 'raw-detail', rows: explain(db, rows, [0, 100, 0]), count: explain(db, count) };
  }
  const queries = api.rollup.buildRollupUsageQueries(spec.filter, spec.group, timezone, spec.by, undefined, { key: 'period', direction: 'desc' });
  const raw = { rows: api.raw.buildUsageQuery(spec.filter, spec.group, timezone, spec.by, undefined, { key: 'period', direction: 'desc' }),
    count: api.raw.buildUsageCountQuery(spec.filter, spec.group, timezone, spec.by) };
  return { mode: queries?.mode ?? 'raw', rows: explain(db, (queries ?? raw).rows, [100, 0]), count: explain(db, (queries ?? raw).count) };
}
function explain(db, query, extra = []) {
  return { sql: query.sql, plan: db.connection.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.values, ...extra).map(row => row.detail) };
}
function measureReads(dbs, apis, options) {
  const result = [];
  for (const spec of readSpecs(dbs.A)) {
    for (let warm = 0; warm < 2; warm++) for (const v of order(warm)) page(dbs[v], spec);
    const expected = pageDigest(page(dbs.A, spec));
    assert.deepEqual(pageDigest(page(dbs.B, spec)), expected, spec.name);
    const samples = { A: [], B: [] };
    for (let pair = 0; pair < options.readPairs; pair++) for (const v of order(pair)) {
      global.gc?.();
      const start = performance.now(); let value;
      for (let i = 0; i < options.iterations; i++) value = page(dbs[v], spec);
      const ms = (performance.now() - start) / options.iterations;
      assert.deepEqual(pageDigest(value), expected, spec.name);
      samples[v].push({ ms });
    }
    result.push({ name: spec.name, result: expected, ...comparison(samples, 'ms'),
      plans: Object.fromEntries(variants.map(v => [v, plans(dbs[v], apis[v], spec)])) });
  }
  return result;
}
function verifyWrite(db, api, session) {
  for (const by of ['provider', 'model']) for (const includeCosts of [false, true]) {
    const filter = { provider: session.provider, sessionId: session.session_id, includeCosts };
    const query = api.raw.buildUsageQuery(filter, 'total', timezone, by);
    const expected = db.connection.prepare(query.sql).all(...query.values, 1000, 0);
    assert.equal(digestRows(db.queryUsage(filter, 'total', timezone, { limit: 1000 }, by)), digestRows(expected));
  }
  integrity(db);
}
function verifyFullScope(db, api) {
  let checks = 0;
  for (const by of ['provider', 'model']) for (const includeCosts of [false, true]) {
    for (const group of ['total', 'day', 'month', 'project', 'session']) {
      const filter = { includeCosts }, raw = api.raw.buildUsageQuery(filter, group, timezone, by);
      const expected = db.connection.prepare(raw.sql).all(...raw.values, 10000000, 0), actual = [];
      for (let offset = 0; ; offset += 1000) {
        const result = db.queryUsagePage(filter, group, timezone, { limit: 1000, offset }, by);
        assert.equal(result.total, expected.length); actual.push(...result.rows);
        if (result.rows.length < 1000) break;
      }
      assert.equal(digestRows(actual), digestRows(expected), `${group}/${by}/${includeCosts}`); checks++;
    }
  }
  return checks;
}
function operations(input) {
  const chosen = selectedInput(input), session = chosen.sessions[0];
  const replace = (db, data) => db.replaceSessions({ sessions: data.sessions, files: [], summaries: data.rows });
  const change = edit => {
    const rows = structuredClone(chosen.rows); edit(rows);
    return db => replace(db, { ...chosen, rows });
  };
  const appended = structuredClone(chosen.rows[0]);
  Object.assign(appended, { root_turn_id: 'benchmark-new-inline-cost-request', request_title: 'Benchmark append',
    input_tokens: 100, output_tokens: 30, total_tokens: 130, cache_write_input_tokens: 0, cache_read_input_tokens: 0,
    diagnostic_file_id: null, diagnostic_offset: null, last_error: null, started_at_ms: Date.UTC(2026, 10, 3),
    completed_at_ms: Date.UTC(2026, 10, 3) + 1000, duration_ms: 1000, duration_quality: 'exact', status: 'completed', billing: 'api',
    model_usage: [{ model: session.provider === 'codex' ? 'gpt-6.1-sol' : 'claude-sonnet-4-6', input_tokens: 100,
      output_tokens: 30, cache_write_input_tokens: 0, cache_read_input_tokens: 0 }], capability_usage: [] });
  return [
    { name: 'initial-store', initial: true, run: db => replace(db, input) },
    { name: 'reapply-all', run: db => replace(db, input) },
    { name: 'append-one', run: db => replace(db, { ...chosen, rows: [...structuredClone(chosen.rows), appended] }) },
    { name: 'edit-one', run: change(rows => { rows[0].request_title = 'Benchmark edited request'; }) },
    { name: 'delete-one', run: change(rows => { rows.shift(); }) },
    { name: 'all-session-titles-changed', run: change(rows => { rows.forEach(row => { row.request_title = 'Benchmark dense title change'; }); }) },
    { name: 'billing-api', run: db => db.setSessionBilling(session.provider, session.session_id, 'api') },
    { name: 'billing-subscription', run: db => db.setSessionBilling(session.provider, session.session_id, 'subscription') },
  ];
}
function prepareManifests(db, rows) {
  if (!rows.length) return;
  const columns = Object.keys(rows[0]);
  db.transaction(() => {
    const insert = db.connection.prepare(`INSERT INTO manifest(${columns}) VALUES(${columns.map(() => '?')})`);
    for (const row of rows) insert.run(...columns.map(column => row[column]));
  });
}
async function measureWrites(directory, dbs, apis, input, options) {
  const results = [], selected = selectedInput(input), session = selected.sessions[0];
  for (const operation of operations(input)) {
    const samples = { A: [], B: [] };
    let freshSpace;
    for (let pair = -1; pair < options.pairs; pair++) {
      const hashes = {};
      for (const v of order(pair + 1)) {
        const path = join(directory, `${operation.name}-${pair}-${v}.sqlite`);
        if (!operation.initial) await backup(dbs[v].connection, path);
        const db = new apis[v].Database(path);
        try {
          if (operation.initial) prepareManifests(db, input.manifests);
          else db.queryUsagePage({}, 'total', timezone);
          global.gc?.();
          const start = performance.now(); operation.run(db); const storeMs = performance.now() - start;
          const readStart = performance.now(); db.queryUsagePage({}, 'day', timezone, { limit: 100 }, 'model');
          const firstAggregateMs = performance.now() - readStart;
          verifyWrite(db, apis[v], session); hashes[v] = factsHash(db);
          if (pair >= 0) samples[v].push({ storeMs, firstAggregateMs, throughAggregateMs: storeMs + firstAggregateMs, resultSha256: hashes[v] });
          if (operation.initial && pair === options.pairs - 1) {
            freshSpace ??= {}; freshSpace[v] = space(db, path);
          }
        } finally {
          db.close();
          assert.equal(dirname(resolve(path)), resolve(directory));
          for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true });
        }
      }
      assert.equal(hashes.A, hashes.B, `A/B facts differ for ${operation.name}`);
    }
    const item = { name: operation.name, selectedSessionRequests: selected.rows.length, store: comparison(samples, 'storeMs'),
      firstAggregate: comparison(samples, 'firstAggregateMs'), throughAggregate: comparison(samples, 'throughAggregateMs'), samples,
      ...(freshSpace ? { freshSpace } : {}) };
    results.push(item);
    console.log(`${operation.name}: ${item.store.A.medianMs.toFixed(3)} -> ${item.store.B.medianMs.toFixed(3)} ms (${item.store.changePercent.toFixed(1)}%)`);
  }
  return results;
}
async function measureOpen(directory, baseline, apis, options) {
  const samples = { A: [], B: [] };
  for (let pair = -1; pair < options.pairs; pair++) for (const v of order(pair + 1)) {
    const path = join(directory, `open-${pair}-${v}.sqlite`);
    await backup(baseline.connection, path); global.gc?.();
    const start = performance.now(), db = new apis[v].Database(path), ms = performance.now() - start;
    try { assert.equal(factsHash(db), factsHash(baseline)); integrity(db); }
    finally { db.close(); for (const suffix of ['', '-wal', '-shm']) await rm(path + suffix, { force: true }); }
    if (pair >= 0) samples[v].push({ ms });
  }
  return comparison(samples, 'ms');
}
async function main() {
  const options = optionsFor(process.argv.slice(2)), apis = { A: load(options.before), B: load(options.after) };
  assert.equal(apis.A.schema, 16); assert.equal(apis.B.schema, 17);
  const hashes = { A: sourceHashes(options.before), B: sourceHashes(options.after) };
  assert.equal(hashes.A['package-lock.json'], hashes.B['package-lock.json']);
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-inline-cost-ab-'));
  const report = { startedAtSeoul: time(), environment: { node: process.version, cpu: cpus()[0]?.model,
    platform: process.platform, sqlite: null, cacheKiB: 4096, tempStore: 'FILE', mmapBytes: 0 },
    builds: Object.fromEntries(variants.map(v => [v, { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: v === 'A' ? options.before : options.after, encoding: 'utf8' }).trim(),
      schema: apis[v].schema, sourceSha256: hashes[v] }])),
    runnerSha256: sha(fs.readFileSync(__filename)), helperSha256: sha(fs.readFileSync(join(__dirname, 'cost-storage.cjs'))),
    method: { pairs: options.pairs, readPairs: options.readPairs, readIterations: options.iterations, writeWarmupPairs: 1,
      reads: 'Warm public queryUsagePage: 100 rows plus grouped COUNT in one snapshot; 2 warmups then alternating A/B batches; explicit GC outside timing.',
      writes: 'Public replaceSessions/setSessionBilling including BEGIN/COMMIT; restore identical pre-state per trial; manifest preparation, input extraction, open/backup, correctness and checkpoint excluded.',
      open: 'A opens schema v16; B opens the same v16 backup and migrates to v17. Both include constructor optimize; one-time cost, not recurring refresh.',
      space: 'After TRUNCATE checkpoint; no VACUUM. Migrated and freshly replayed DBs reported separately; freelist retained.',
      accuracy: 'A/B logical facts and API result hashes (physical IDs and update timestamps excluded, floats 12 significant digits for comparisons only), raw/provider/model oracle, FK and integrity.',
      scope: 'DB-only, no transcript parsing, network, worker IPC or UI timing; real DB read-only backup; private identifiers/titles/paths omitted from report.' }, datasets: [] };
  try {
    const datasets = options.smoke ? [{ name: 'smoke-200', count: 200, turns: 10 }, { name: 'smoke-long-2000', count: 2000, turns: 1000 }]
      : [{ name: 'installed-snapshot', real: true }, { name: 'synthetic-10000-short', count: 10000, turns: 100 }, { name: 'synthetic-10000-long', count: 10000, turns: 1000 }];
    for (const dataset of datasets) {
      console.log(`Dataset ${dataset.name}`);
      const work = join(directory, dataset.name); await mkdir(work);
      const aPath = join(work, 'baseline-A.sqlite'), bPath = join(work, 'baseline-B.sqlite');
      if (dataset.real) {
        const original = new DatabaseSync(options.realDb, { readOnly: true });
        try { original.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=5000'); await backup(original, aPath); }
        finally { original.close(); }
      }
      const a = new apis.A.Database(aPath);
      let b;
      try {
        if (!dataset.real) {
          const rows = syntheticRows(dataset.count, dataset.turns), sessions = [...new Map(rows.map(row => [row.session_id,
            { provider: row.provider, session_id: row.session_id }])).values()];
          a.replaceSessions({ sessions, files: [], summaries: rows });
        }
        a.queryUsagePage({}, 'day', timezone, { limit: 100 }, 'model');
        integrity(a);
        report.environment.sqlite = a.connection.prepare('SELECT sqlite_version() v').get().v;
        const input = inputFrom(a), inventoryBefore = inventory(a), originalHash = factsHash(a);
        const opening = await measureOpen(work, a, apis, options);
        await backup(a.connection, bPath); b = new apis.B.Database(bPath);
        assert.equal(factsHash(b), originalHash, 'Migration changed logical facts'); integrity(b);
        b.queryUsagePage({}, 'day', timezone, { limit: 100 }, 'model');
        const dbs = { A: a, B: b }, spaceBefore = space(a, aPath), spaceAfter = space(b, bPath);
        const fullScopeChecks = verifyFullScope(a, apis.A) + verifyFullScope(b, apis.B);
        const reads = measureReads(dbs, apis, options);
        console.log(`${dataset.name}: ${reads.length} query cases passed`);
        const writes = await measureWrites(work, dbs, apis, input, options);
        assert.equal(factsHash(a), originalHash); assert.equal(factsHash(b), originalHash);
        report.datasets.push({ name: dataset.name, input: inventoryBefore, inputSha256: originalHash, opening,
          migratedSpace: { A: spaceBefore, B: spaceAfter }, fullScopeChecks,
          postWriteOracleChecks: 4 * 2 * (options.pairs + 1) * writes.length, reads, writes });
        await mkdir(dirname(options.output), { recursive: true });
        await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
      } finally { b?.close(); a.close(); }
    }
    assert.deepEqual(sourceHashes(options.before), hashes.A); assert.deepEqual(sourceHashes(options.after), hashes.B);
    report.completedAtSeoul = time();
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n');
    console.log(`Saved ${relative(root, options.output)}`);
  } finally {
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('agent-tracker-inline-cost-ab-') && !fs.lstatSync(directory).isSymbolicLink());
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
if (require.main === module) main().catch(error => { console.error(error.stack); process.exitCode = 1; });
module.exports = { optionsFor, syntheticRows, normalize, factsHash, comparison };
