// Compares release, preview-era and current summary builds on one frozen input.
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const { dirname, join, resolve, relative } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { makeSnapshot, inspectCodexTarget, codexAppendRows } = require('./incremental-refresh.cjs');
const { allUsage, canonical, digest, independentCheck } = require('./temp-batch-ab.cjs');
const { auditThreadUsage } = require('./thread-usage-oracle.cjs');

const revisions = ['9627303', 'fd83620', 'current'];
const datasets = [['current-data', 0, 100], ['synthetic-10000', 10000, 100], ['synthetic-100', 100, 10]];
const groups = ['day', 'month', 'session', 'project'];
const timezone = 'Asia/Seoul', sourceWorkers = 4, sampleIntervalMs = 5;
const filter = { fromMs: Date.parse('2020-01-01T00:00:00+09:00'), toMs: Date.parse('2035-01-01T00:00:00+09:00'),
  unknownTime: 'include', excludeEmptyUsage: false };
const recent = { fromMs: Date.parse('2026-10-26T00:00:00+09:00'), toMs: Date.parse('2026-11-25T00:00:00+09:00') };
const sha = buffer => createHash('sha256').update(buffer).digest('hex');

async function fingerprint(directory) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort();
  const hash = createHash('sha256');
  for (const file of files) hash.update(relative(directory, file).replaceAll('\\', '/')).update(await fs.readFile(file));
  return hash.digest('hex');
}

function databaseSize(db) {
  const pragma = name => db.connection.prepare('PRAGMA ' + name).get()[name];
  const pageSize = pragma('page_size'), pages = pragma('page_count'), freePages = pragma('freelist_count');
  return { schema: pragma('user_version'), bytes: pages * pageSize, usedBytes: (pages - freePages) * pageSize, pageSize, pages, freePages };
}

function tableExists(db, name) {
  return Boolean(db.connection.prepare('SELECT 1 FROM sqlite_schema WHERE type = ? AND name = ?').get('table', name));
}

function tableCounts(db) {
  const tables = db.connection.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  return Object.fromEntries(tables.map(({ name }) => [name, db.connection.prepare(`SELECT COUNT(*) n FROM "${name}"`).get().n]));
}

function totals(db) {
  const rows = tableExists(db, 'turn_summary')
    ? db.connection.prepare('SELECT provider,COUNT(*) samples,SUM(input_tokens) input,SUM(output_tokens) output,SUM(total_tokens) tokens FROM turn_summary GROUP BY provider').all()
    : db.connection.prepare('SELECT provider,SUM(turn_count) samples,SUM(input_tokens) input,SUM(output_tokens) output,SUM(total_tokens) tokens FROM usage_request_daily GROUP BY provider').all();
  return Object.fromEntries(rows.map(({ provider, ...row }) => [provider, row]));
}

function compareDaily(db, group, actual) {
  const expected = new Map();
  const key = row => JSON.stringify([row.provider, row.project_key, row.session_id, row.period]);
  for (const row of db.connection.prepare('SELECT * FROM usage_request_daily').iterate()) {
    if (row.local_day && (row.local_day < '2020-01-01' || row.local_day >= '2035-01-01')) continue;
    const id = key({ provider: row.provider,
      project_key: ['project', 'session'].includes(group) ? row.project_key : null,
      session_id: group === 'session' ? row.session_id : null,
      period: ['day', 'month'].includes(group) ? row.local_day.slice(0, group === 'day' ? 10 : 7) || null : null });
    const sum = expected.get(id) ?? { turn_count: 0, input_tokens: 0, output_tokens: 0, total_tokens: 0,
      completed_turns: 0, recorded_turns: 0, recorded_completed_turns: 0, c_total_tokens: 0 };
    for (const name of Object.keys(sum)) sum[name] += row[name];
    expected.set(id, sum);
  }
  assert.equal(actual.length, expected.size, group);
  for (const row of actual) {
    const sum = expected.get(key(row));
    assert.ok(sum, group);
    assert.equal(canonical(row.avg_tokens_per_turn), canonical(sum.completed_turns ? sum.c_total_tokens / sum.completed_turns : null), group);
    for (const name of Object.keys(sum)) if (name !== 'c_total_tokens') assert.equal(row[name], sum[name], group + '/' + name);
    expected.delete(key(row));
  }
  assert.equal(expected.size, 0, group);
}

function measureQueries(db) {
  const result = {};
  for (const group of groups) {
    const started = performance.now();
    const rows = allUsage(db, group, filter);
    const ms = performance.now() - started;
    if (tableExists(db, 'turn_summary')) independentCheck(db, filter, group, rows);
    else compareDaily(db, group, rows);
    const values = rows.map(row => [row.provider, row.project_key, row.session_id, row.period,
      row.turn_count, row.total_tokens, row.completed_turns, row.avg_tokens_per_turn]);
    result[group] = { ms, groups: rows.length, sha256: digest(values.map(canonical).sort()) };
  }
  return result;
}

function recentPage(db) {
  const rows = allUsage(db, 'day', { ...recent, unknownTime: 'exclude', chartMetric: 'tokens' });
  return { groups: rows.length, samples: rows.reduce((sum, row) => sum + row.turn_count, 0),
    tokens: rows.reduce((sum, row) => sum + row.total_tokens, 0) };
}

async function measureRefresh(refresh, db, options, withPreview) {
  let first, final;
  global.gc();
  const readMemory = () => {
    const { heapUsed, rss } = process.memoryUsage();
    return { heapUsed, rss };
  };
  const before = readMemory(), peak = { ...before };
  const sample = () => {
    const { heapUsed, rss } = readMemory();
    peak.heapUsed = Math.max(peak.heapUsed, heapUsed);
    peak.rss = Math.max(peak.rss, rss);
  };
  const timer = setInterval(sample, sampleIntervalMs), started = performance.now();
  let result;
  try {
    result = await refresh(db, options, undefined, sample, withPreview ? { ...recent, onReady(memoryDb) {
      const page = recentPage(memoryDb);
      first = { ...page, ms: performance.now() - started, source: 'preview' };
    } } : undefined);
  } finally { clearInterval(timer); }
  const ms = performance.now() - started;
  sample();
  assert.equal(result.interrupted, false, result.error);
  assert.equal(result.failed, 0);
  if (withPreview) {
    const page = recentPage(db);
    final = { ...page, ms: performance.now() - started, source: 'persisted' };
    first ??= final;
  }
  global.gc();
  return { ms, before, peak, afterGc: readMemory(), parsed: result.parsed, reused: result.reused, bytes: result.bodyBytes,
    scan: result.timings.scan, storage: result.timings.storage, ...(withPreview ? { first, final } : {}) };
}

async function appendTarget(db, product) {
  const file = db.connection.prepare(`SELECT f.id, f.path, f.size_bytes FROM source_file f
    JOIN usage_request_daily d ON d.provider=f.provider AND d.session_id=f.session_id
    WHERE f.provider='codex' AND f.processing_status='done' AND f.path NOT LIKE '%.zst'
    GROUP BY f.path ORDER BY f.size_bytes DESC, f.path`).all().find(({ id }) => {
    const identity = db.sourceRelations(id)?.identity;
    return identity && identity.threadId === identity.sessionId;
  });
  assert.ok(file, 'No plain Codex main source with usage');
  const target = { path: file.path, originalBytes: file.size_bytes };
  await inspectCodexTarget(target, product);
  const rows = codexAppendRows(target, 'history-ab-request', 'history-ab-response');
  return { path: file.path, extra: rows.map(row => JSON.stringify(row)).join('\n') + '\n' };
}

async function collect(workspace, name, revision, action, scratch) {
  const product = join(workspace, revision);
  const config = JSON.parse(await fs.readFile(join(workspace, name, 'snapshot.private.json'), 'utf8'));
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const dbPath = join(scratch, action + '.sqlite');
  const seed = join(workspace, name, revision + '-seed.sqlite');
  const options = { dbPath, roots: config.roots, sourceWorkers, timezone, collectCapabilities: false };
  if (['unchanged', 'append', 'recent-append'].includes(action)) await fs.copyFile(seed, dbPath);
  const db = new SummaryDatabase({ databasePath: dbPath, timezone });
  let target, stat, added = false;
  try {
    if (['append', 'recent-append'].includes(action)) {
      target = JSON.parse(await fs.readFile(join(workspace, name, 'append.private.json'), 'utf8'));
      assert.ok(config.files.some(file => file.path === target.path), 'Append only to a frozen input file');
      stat = await fs.stat(target.path);
      await fs.appendFile(target.path, target.extra);
      added = true;
      await fs.utimes(target.path, stat.atime, new Date(Math.max(Date.now() + 1000, stat.mtimeMs + 2)));
    }
    const refresh = await measureRefresh(refreshSummary, db, options, action.startsWith('recent-'));
    const beforeQuery = databaseSize(db);
    const results = totals(db);
    const queries = measureQueries(db);
    const size = databaseSize(db);
    assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
    if (action === 'seed') {
      const target = revision === 'current' ? await appendTarget(db, product) : undefined;
      if (target) await fs.writeFile(join(workspace, name, 'append.private.json'), JSON.stringify(target));
      const tables = tableCounts(db);
      db.close();
      await fs.copyFile(dbPath, seed);
      assert.equal((await fs.stat(seed)).size, size.bytes, 'Checkpointed database bytes');
      return { refresh, results, queries, beforeQuery, size, tables,
        ...(target ? { append: { bytes: Buffer.byteLength(target.extra), sourceBytes: (await fs.stat(target.path)).size,
          sha256: sha(target.extra) } } : {}) };
    }
    return { refresh, results, queries, beforeQuery, size };
  } finally {
    if (added) {
      await fs.truncate(target.path, stat.size);
      await fs.utimes(target.path, stat.atime, stat.mtime);
    }
    db.close();
  }
}

function child(workspace, name, revision, action, scratch) {
  return new Promise((resolve, reject) => {
    const runner = fork(__filename, ['--child', workspace, name, revision, action, scratch], {
      execArgv: ['--no-warnings', '--expose-gc'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
    });
    let message;
    runner.on('message', value => { message = value; });
    runner.on('error', reject);
    runner.on('exit', code => code === 0 && message ? resolve(message) : reject(new Error(`${name}/${revision}/${action} exited ${code}`)));
  });
}

async function runChild(workspace, name, revision, action) {
  const scratch = await fs.mkdtemp(join(workspace, 'sample-'));
  try { return await child(workspace, name, revision, action, scratch); }
  finally {
    const directory = await fs.realpath(scratch);
    assert.equal(dirname(directory), workspace, 'Remove only a benchmark scratch directory');
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function migrate(workspace, name, revision, before) {
  const path = join(workspace, name, revision + '-migrated.sqlite');
  await fs.copyFile(join(workspace, name, revision + '-seed.sqlite'), path);
  const { SummaryDatabase } = require(join(workspace, 'current', 'dist/src/summary/db'));
  const started = performance.now();
  const db = new SummaryDatabase({ databasePath: path, timezone });
  const ms = performance.now() - started;
  try {
    assert.deepEqual(totals(db), before);
    measureQueries(db);
    assert.equal(db.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    const size = databaseSize(db);
    db.close();
    const fileBytes = (await fs.stat(path)).size;
    const compacted = new DatabaseSync(path);
    try { compacted.exec('VACUUM'); }
    finally { compacted.close(); }
    return { ms, size, fileBytes, compactedBytes: (await fs.stat(path)).size };
  } finally { db.close(); }
}

async function main(workspaceArg, outputArg, pairsArg = '10', warmupsArg = '3', only) {
  assert.ok(workspaceArg && outputArg, 'Pass BUILD_WORKSPACE OUTPUT [PAIRS] [WARMUPS] [DATASET]');
  const workspace = await fs.realpath(resolve(workspaceArg)), output = resolve(outputArg);
  const pairs = Number(pairsArg), warmups = Number(warmupsArg);
  assert.ok(Number.isSafeInteger(pairs) && pairs > 0 && Number.isSafeInteger(warmups) && warmups >= 0);
  const report = { environment: { node: process.version, sqlite: process.versions.sqlite, v8: process.versions.v8,
    cpu: os.cpus()[0].model, platform: process.platform, arch: process.arch },
    protocol: { pairs, warmups, sourceWorkers, sampleIntervalMs, timezone, filter, recent, collectCapabilities: false },
    builds: {}, datasets: [] };
  for (const revision of revisions) report.builds[revision] = {
    sourceSha256: await fingerprint(join(workspace, revision, 'src')),
    buildSha256: await fingerprint(join(workspace, revision, 'dist')),
  };
  await fs.mkdir(dirname(output), { recursive: true });
  for (const [name, requests, turns] of datasets.filter(([name]) => !only || name === only)) {
    const dir = join(workspace, name), manifest = join(dir, 'snapshot.private.json');
    await fs.mkdir(dir, { recursive: true });
    const snapshot = await fs.readFile(manifest, 'utf8').then(JSON.parse).catch(async error => {
      if (error.code !== 'ENOENT') throw error;
      const data = await makeSnapshot(dir, { after: join(workspace, 'current'), real: !requests, requests, 'turns-per-session': turns });
      await fs.writeFile(manifest, JSON.stringify(data));
      return data;
    });
    const dataset = { name, inputSha256: snapshot.sha256, inventory: snapshot.inventory, expected: snapshot.expected, seeds: {}, migration: {}, samples: [] };
    report.datasets.push(dataset);
    for (const revision of revisions) dataset.seeds[revision] = await runChild(workspace, name, revision, 'seed');
    dataset.oracle = await auditThreadUsage(snapshot, join(workspace, '9627303'));
    for (const revision of revisions.slice(0, 2)) {
      try { dataset.migration[revision] = await migrate(workspace, name, revision, dataset.seeds[revision].results); }
      catch (error) { dataset.migration[revision] = { error: error.code ?? error.name }; }
    }
    console.log(JSON.stringify({ name, seeds: Object.fromEntries(revisions.map(id => [id, dataset.seeds[id].results])) }));
    for (const action of ['cold', 'unchanged', 'append', ...(!requests ? ['recent-cold', 'recent-append'] : [])]) {
      for (let iteration = -warmups; iteration < pairs; iteration++) {
        const order = iteration % 2 === 0 ? revisions : [...revisions].reverse();
        const record = { action, iteration, order, builds: {} };
        for (const revision of order) record.builds[revision] = await runChild(workspace, name, revision, action);
        dataset.samples.push(record);
      }
      await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
      console.log(JSON.stringify({ name, action, recorded: pairs }));
    }
    for (const file of snapshot.files) assert.equal(sha(await fs.readFile(file.path)), file.sha256, 'Frozen input changed');
    dataset.inputRestored = true;
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
}

const [mode, ...args] = process.argv.slice(2);
const task = mode === '--child'
  ? collect(...args).then(result => new Promise((done, fail) => process.send(result, error => error ? fail(error) : done())))
  : main(mode, ...args);
task.catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => { if (process.connected) process.disconnect(); });
