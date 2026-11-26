// Compares two builds in isolated runs of the real refresh and query APIs.
'use strict';

const assert = require('node:assert/strict');
const { execFileSync, fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { createReadStream } = require('node:fs');
const fs = require('node:fs/promises');
const { cpus, release } = require('node:os');
const { join, relative, resolve, sep } = require('node:path');
const { zstdCompressSync } = require('node:zlib');
const { codexAppendRows, makeSnapshot } = require('./incremental-refresh.cjs');
const { auditThreadUsage } = require('./thread-usage-oracle.cjs');

const repo = resolve(__dirname, '../..');
const timezone = 'Asia/Seoul';
const sourceWorkers = 4;
const sampleIntervalMs = 5;
const memoryFields = ['heapUsed', 'heapTotal', 'external', 'arrayBuffers', 'rss'];
const dimensions = ['day', 'month', 'session', 'project'];
const sha = value => createHash('sha256').update(value).digest('hex');
const stableRows = rows => sha(JSON.stringify(rows.map(row => JSON.stringify(row)).sort()));
const memory = () => {
  const usage = process.memoryUsage();
  return Object.fromEntries(memoryFields.map(field => [field, usage[field]]));
};

async function fileHash(path) {
  const digest = createHash('sha256');
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest('hex');
}

async function treeHash(path) {
  const entries = await fs.readdir(path, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile())
    .map(entry => relative(path, join(entry.parentPath, entry.name))).sort();
  const digest = createHash('sha256');
  for (const name of files) digest.update(JSON.stringify([name.replaceAll(sep, '/'), await fileHash(join(path, name))]));
  return digest.digest('hex');
}

async function builds(workspace, revision, baseSource) {
  const paths = ['src', 'localization', 'tsconfig.json'];
  const products = { A: join(workspace, 'A'), B: join(workspace, 'B') };
  await fs.mkdir(products.A);
  if (baseSource) {
    for (const path of paths) await fs.cp(join(baseSource, path), join(products.A, path), { recursive: true });
  } else {
    const tar = join(workspace, 'baseline.tar');
    execFileSync('git', ['archive', '-o', tar, revision, ...paths], { cwd: repo });
    execFileSync('tar', ['-xf', tar, '-C', products.A]);
  }
  for (const path of paths) await fs.cp(join(repo, path), join(products.B, path), { recursive: true });
  const hashes = {};
  for (const [variant, product] of Object.entries(products)) {
    await fs.symlink(join(repo, 'node_modules'), join(product, 'node_modules'), 'junction');
    execFileSync(process.execPath, [join(repo, 'node_modules/typescript/bin/tsc'), '-p', join(product, 'tsconfig.json')],
      { stdio: 'inherit' });
    await fs.copyFile(join(repo, 'node_modules/i18next/dist/cjs/i18next.js'), join(product, 'dist/src/localization/i18next.cjs'));
    hashes[variant] = { source: await treeHash(join(product, 'src')), build: await treeHash(join(product, 'dist/src')) };
  }
  return { products, hashes };
}

async function selectAppend(snapshot, product) {
  const { readJsonl } = require(join(product, 'dist/src/summary/jsonl'));
  const { threadFields } = require(join(product, 'dist/src/summary/parsers/threadUsage'));
  const codexRoots = snapshot.roots.filter(root => root.provider === 'codex');
  const files = snapshot.files.filter(file => codexRoots.some(root => file.path.startsWith(root.path + sep)))
    .sort((a, b) => b.bytes - a.bytes);
  for (const file of files) {
    let modern = 0;
    const scan = await readJsonl(file.path, file.bytes, row => {
      if (row.type === 'token_usage_record') modern++;
    }, { fixedShape: threadFields.codex });
    if (!modern || scan.partialLine) continue;
    const rows = codexAppendRows({ format: 'current' }, 'thread-token-buffer-ab-turn', 'thread-token-buffer-ab-response');
    for (const [index, row] of rows.entries()) row.timestamp = new Date(Date.UTC(2026, 10, 26, 12, 0, index)).toISOString();
    const body = Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');
    const compressed = file.path.endsWith('.zst');
    return { file, modern, compressed, append: compressed ? zstdCompressSync(body) : body };
  }
  throw new Error('No complete modern Codex file in the frozen input');
}

function groupKey(row, dimension, daily) {
  if (dimension === 'session') return JSON.stringify([row.provider, row.project_key, row.session_id]);
  if (dimension === 'project') return JSON.stringify([row.provider, row.project_key]);
  const day = daily ? row.local_day || null : row.period;
  return JSON.stringify([row.provider, daily && dimension === 'month' ? day?.slice(0, 7) ?? null : day]);
}

function queryChecks(database, dailyRows) {
  const query = {};
  for (const dimension of dimensions) {
    const rows = [];
    const started = performance.now();
    let offset = 0, total;
    do {
      const page = database.queryUsagePage({ unknownTime: 'include' }, dimension, timezone, { offset, limit: 1000 }, 'provider');
      total = page.total;
      assert.ok(page.rows.length || offset === total);
      rows.push(...page.rows);
      offset += page.rows.length;
    } while (offset < total);
    const ms = performance.now() - started;
    assert.equal(offset, total);
    const expected = new Map();
    for (const row of dailyRows) {
      const key = groupKey(row, dimension, true);
      const group = expected.get(key) ?? { tokens: 0, threads: 0, completed: 0, completedTokens: 0 };
      group.tokens += row.total_tokens;
      group.threads += row.turn_count;
      group.completed += row.completed_turns;
      group.completedTokens += row.c_total_tokens;
      expected.set(key, group);
    }
    assert.equal(total, expected.size);
    for (const row of rows) {
      const key = groupKey(row, dimension, false);
      const group = expected.get(key);
      assert.ok(group, `Unexpected ${dimension} result group`);
      assert.equal(row.turn_count, group.threads);
      assert.equal(row.total_tokens, group.tokens);
      assert.equal(row.completed_turns, group.completed);
      assert.equal(row.avg_tokens_per_turn, group.completed ? group.completedTokens / group.completed : null);
      expected.delete(key);
    }
    query[dimension] = { ms, groups: total, sha256: stableRows(rows) };
  }
  return query;
}

function storedResults(database) {
  const db = database.connection;
  const daily = db.prepare('SELECT * FROM usage_request_daily').all();
  const totals = db.prepare('SELECT provider, sum(turn_count) AS threads, sum(input_tokens) AS input, sum(output_tokens) AS output,'
    + ' sum(total_tokens) AS tokens FROM usage_request_daily GROUP BY provider ORDER BY provider').all();
  const names = ['usage_request_daily', 'usage_model_daily', 'usage_capability_daily', 'usage_rollup_meta', 'projects', 'sessions', 'session_billing'];
  const tables = Object.fromEntries(names.map(name => [name, stableRows(db.prepare(`SELECT * FROM ${name}`).all())]));
  tables.source_file = stableRows(db.prepare('SELECT provider, source_root, path, session_id, mtime_ms, parser_version, thread_id,'
    + ' thread_usage, source_missing, processing_status, processing_position, last_error FROM source_file').all());
  assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  return { totals, tables, query: queryChecks(database, daily) };
}

async function collect(product, manifest, dbPath) {
  const { roots } = JSON.parse(await fs.readFile(manifest, 'utf8'));
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const { ThreadAggregation } = require(join(product, 'dist/src/summary/scanner/refresh/aggregation'));
  const database = new SummaryDatabase({ databasePath: dbPath, timezone });
  global.gc();
  const start = memory(), peak = { ...start }, boundaries = {};
  const sample = (boundary) => {
    const current = memory();
    for (const field of memoryFields) peak[field] = Math.max(peak[field], current[field]);
    if (boundary) boundaries[boundary] = current;
  };
  const summarize = ThreadAggregation.prototype.summarize;
  ThreadAggregation.prototype.summarize = function (...args) {
    sample('beforeAggregate');
    const rows = Reflect.apply(summarize, this, args);
    sample('afterAggregate');
    return rows;
  };
  const timer = setInterval(sample, sampleIntervalMs);
  let run;
  const started = performance.now();
  try {
    run = await refreshSummary(database, { roots, dbPath, sourceWorkers, timezone }, undefined, progress => sample(progress.phase));
  } finally {
    clearInterval(timer);
    ThreadAggregation.prototype.summarize = summarize;
  }
  const ms = performance.now() - started;
  sample('afterRefresh');
  const lifetimeMaxRss = process.resourceUsage().maxRSS * 1024;
  global.gc();
  const afterGc = memory();
  try {
    assert.equal(run.interrupted, false, run.error);
    assert.equal(run.failed, 0, 'Source failed');
    return {
      ms, discovered: run.discovered, parsed: run.parsed, reused: run.reused, bytes: run.bodyBytes,
      start, peak, boundaries, afterGc, lifetimeMaxRss,
      stages: run.timings.scan, commit: run.timings.storage.commit,
      ...storedResults(database),
    };
  } finally {
    database.close();
  }
}

function childRun(product, manifest, database) {
  return new Promise((done, reject) => {
    const child = fork(__filename, ['--child', product, manifest, database], {
      execArgv: ['--no-warnings', '--expose-gc'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
    });
    let value;
    child.on('message', message => { value = message; });
    child.on('error', reject);
    child.on('exit', code => code === 0 && value ? done(value) : reject(new Error(`Collector exited with code ${code}`)));
  });
}

function checkOracle(sample, expected) {
  for (const { provider, threads, ...tokens } of sample.totals) {
    assert.ok(threads > 0);
    assert.deepEqual(tokens, expected.totals[provider], `Independent JSONL totals for ${provider}`);
  }
  assert.equal(sample.totals.length, Object.values(expected.totals).filter(row => row.tokens > 0).length);
}

function compare(A, B) {
  for (const field of ['parsed', 'bytes']) assert.equal(A[field], B[field], field);
  compareResults(A, B);
}

function compareResults(A, B) {
  for (const field of ['totals', 'tables']) assert.deepEqual(A[field], B[field], field);
  for (const dimension of dimensions)
    assert.equal(A.query[dimension].sha256, B.query[dimension].sha256, `Query equality for ${dimension}`);
}

async function fixedRowsFingerprint(product, snapshot) {
  const { readJsonl } = require(join(product, 'dist/src/summary/jsonl'));
  const { threadFields } = require(join(product, 'dist/src/summary/parsers/threadUsage'));
  const hash = createHash('sha256');
  let rows = 0, partialFiles = 0;
  for (const file of snapshot.files) {
    const root = snapshot.roots.find(value => file.path.startsWith(value.path + sep));
    assert.ok(root, 'Source must be inside a frozen root');
    const result = await readJsonl(file.path, file.bytes, (row, offset) => {
      hash.update(JSON.stringify([offset, row])).update('\n');
    }, { fixedShape: threadFields[root.provider] });
    rows += result.rows;
    partialFiles += Number(result.partialLine);
    hash.update(JSON.stringify(result)).update('\n');
  }
  return { rows, partialFiles, sha256: hash.digest('hex') };
}

async function copySnapshot(inputWorkspace, name, folder) {
  const source = resolve(inputWorkspace, name);
  const from = join(source, 'snapshot'), to = join(folder, 'snapshot');
  const snapshot = JSON.parse(await fs.readFile(join(source, 'snapshot.json'), 'utf8'));
  const relocate = path => {
    assert.ok(resolve(path).startsWith(from + sep), 'Frozen path must stay inside the input snapshot');
    return join(to, relative(from, path));
  };
  await fs.cp(from, to, { recursive: true, preserveTimestamps: true });
  return {
    ...snapshot,
    files: snapshot.files.map(file => ({ ...file, path: relocate(file.path) })),
    roots: snapshot.roots.map(root => ({ ...root, path: relocate(root.path),
      ...(root.dataHome ? { dataHome: relocate(root.dataHome) } : {}) })),
  };
}

async function measureInput(folder, snapshot, products, pairs, warmups, name, verifyFixedRows, measureUnchanged) {
  const manifest = join(folder, 'snapshot.json');
  await fs.writeFile(manifest, JSON.stringify(snapshot));
  let fixedRows;
  if (verifyFixedRows) {
    fixedRows = await fixedRowsFingerprint(products.A, snapshot);
    assert.deepEqual(await fixedRowsFingerprint(products.B, snapshot), fixedRows, 'Projected rows and offsets must match');
    console.log(`${name} fixed rows verified: ${fixedRows.rows}`);
  }
  const append = await selectAppend(snapshot, products.A);
  const baseline = await auditThreadUsage(snapshot, products.A);
  if (snapshot.expected) {
    assert.equal(baseline.evidence.responses + baseline.evidence.claudeResponses, snapshot.expected.requests);
    assert.equal(baseline.totals.claude.tokens + baseline.totals.codex.tokens, snapshot.expected.tokens);
  }
  const seed = join(folder, 'seed.sqlite');
  const old = await childRun(products.A, manifest, seed);
  checkOracle(old, baseline);
  const cold = [], appended = [];
  const runPhase = async (phase, results) => {
    for (let index = -warmups; index < pairs; index++) {
      const order = index % 2 === 0 ? 'AB' : 'BA';
      const sample = { order };
      for (const variant of order) {
        const db = join(folder, `sample-${variant}.sqlite`);
        if (phase !== 'cold') await fs.copyFile(seed, db);
        try { sample[variant] = await childRun(products[variant], manifest, db); }
        finally {
          for (const suffix of ['', '-shm', '-wal']) await fs.rm(db + suffix, { force: true });
        }
      }
      compare(sample.A, sample.B);
      assert.equal(sample.A.discovered, sample.B.discovered);
      assert.equal(sample.A.reused, sample.B.reused);
      const reference = results[0]?.A;
      if (reference) compare(reference, sample.A);
      if (phase === 'cold') compare(old, sample.A);
      if (phase === 'unchanged') {
        for (const variant of order) {
          const row = sample[variant];
          assert.equal(row.bytes, 0);
          assert.equal(row.parsed, 0);
          compareResults(old, row);
        }
      }
      if (index >= 0) results.push(sample);
      if (index === -1 || index >= 0 && (index + 1) % 5 === 0)
        console.log(`${name} ${phase} ${index < 0 ? 'warmups complete' : `${index + 1}/${pairs}`}`);
    }
  };
  await runPhase('cold', cold);
  const unchanged = [];
  if (measureUnchanged) await runPhase('unchanged', unchanged);
  const stat = await fs.stat(append.file.path);
  assert.equal(stat.size, append.file.bytes);
  let after, appendSha256;
  try {
    await fs.appendFile(append.file.path, append.append);
    await fs.utimes(append.file.path, stat.atime, new Date(stat.mtimeMs + 10_000));
    appendSha256 = await fileHash(append.file.path);
    const updated = { ...snapshot, files: snapshot.files.map(file => file === append.file ? { ...file, bytes: file.bytes + append.append.length } : file) };
    after = await auditThreadUsage(updated, products.A);
    assert.equal(after.totals.codex.input - baseline.totals.codex.input, 123);
    assert.equal(after.totals.codex.output - baseline.totals.codex.output, 7);
    assert.deepEqual(after.totals.claude, baseline.totals.claude);
    await runPhase('append', appended);
    checkOracle(appended[0].A, after);
  } finally {
    await fs.truncate(append.file.path, stat.size);
    await fs.utimes(append.file.path, stat.atime, stat.mtime);
  }
  for (const file of snapshot.files) assert.equal(await fileHash(file.path), file.sha256, 'Frozen source hash changed');
  return {
    inventory: snapshot.inventory, sha256: snapshot.sha256, fixture: snapshot.expected, fixedRows,
    independentTotals: { cold: baseline, append: after },
    appendTarget: { beforeBytes: append.file.bytes, appendedBytes: append.append.length,
      existingModernRows: append.modern, compressed: append.compressed, sha256: appendSha256 },
    samples: { cold, ...(measureUnchanged ? { unchanged } : {}), append: appended },
  };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
  const output = resolve(args.output);
  const pairs = Number(args.pairs ?? 20), warmups = Number(args.warmups ?? 3);
  assert.ok(Number.isSafeInteger(pairs) && pairs >= 2 && pairs % 2 === 0 && Number.isSafeInteger(warmups) && warmups >= 1);
  assert.ok(!args.base || !args['base-source'], 'Choose --base or --base-source');
  const baseSource = args['base-source'] && resolve(args['base-source']);
  const revision = baseSource ? null : execFileSync('git', ['rev-parse', args.base ?? 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  const startedAt = new Date().toISOString();
  const cache = join(repo, 'tests', '.cache');
  await fs.mkdir(cache, { recursive: true });
  const workspace = await fs.mkdtemp(join(cache, 'thread-token-buffer-ab-'));
  console.log(`Workspace: ${relative(repo, workspace)}`);
  const { products, hashes } = await builds(workspace, revision, baseSource);
  const inputs = {};
  const datasets = args.dataset ? [args.dataset] : ['real', '10000', '100'];
  for (const name of datasets) {
    assert.ok(['real', '10000', '100'].includes(name));
    const folder = join(workspace, name);
    await fs.mkdir(folder);
    const snapshot = args['input-workspace'] ? await copySnapshot(args['input-workspace'], name, folder)
      : await makeSnapshot(folder, { after: products.A, real: name === 'real',
        requests: name === 'real' ? 0 : Number(name), 'turns-per-session': name === '100' ? 5 : 50 });
    inputs[name] = await measureInput(folder, snapshot, products, pairs, warmups, name,
      args['verify-fixed-rows'] === 'true', args.unchanged === 'true');
  }
  const environment = { platform: process.platform, release: release(), arch: process.arch, node: process.version,
    v8: process.versions.v8, sqlite: process.versions.sqlite, cpu: cpus()[0].model, logicalCpus: cpus().length };
  await fs.mkdir(resolve(output, '..'), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ startedAt, completedAt: new Date().toISOString(), revision, builds: hashes, environment,
    protocol: { pairs, warmups, order: 'alternating AB/BA', sourceWorkers, sampleIntervalMs, timezone }, inputs }, null, 2) + '\n', { flag: 'wx' });
}

if (require.main === module) {
  const run = process.argv[2] === '--child'
    ? collect(...process.argv.slice(3)).then(value => new Promise((done, reject) => process.send(value, error => error ? reject(error) : done())))
    : main();
  run.catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => { if (process.connected) process.disconnect(); });
}

module.exports = { compare, fileHash, selectAppend, storedResults, treeHash };
