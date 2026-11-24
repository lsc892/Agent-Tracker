// Compares one cold product collection per build with independent raw-log totals.
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const { existsSync } = require('node:fs');
const { mkdtemp, readFile, readdir, writeFile } = require('node:fs/promises');
const { dirname, join, resolve } = require('node:path');
const assert = require('node:assert/strict');
const { auditThreadUsage } = require('./thread-usage-oracle.cjs');

const timezone = 'Asia/Seoul';
const sourceWorkers = 4;
const sampleIntervalMs = 5;
const dimensions = ['day', 'month', 'session', 'project'];
const digest = data => createHash('sha256').update(data).digest('hex');

async function fingerprint(directory) {
  const files = (await readdir(directory, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile());
  const paths = files.map(entry => join(entry.parentPath, entry.name).slice(directory.length + 1)).sort();
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path.replaceAll('\\', '/')).update(await readFile(join(directory, path)));
  return hash.digest('hex');
}

function queryTotals(database, groupBy, provider) {
  const started = performance.now();
  let offset = 0, input = 0, output = 0, tokens = 0;
  for (;;) {
    const { rows, total } = database.queryUsagePage({ provider, unknownTime: 'include' }, groupBy, timezone,
      { offset, limit: 1000 }, 'provider');
    for (const row of rows) {
      input += row.input_tokens;
      output += row.output_tokens;
      tokens += row.total_tokens;
    }
    offset += rows.length;
    if (!rows.length || offset >= total) return { input, output, tokens, groups: total, ms: performance.now() - started };
  }
}

function fingerprintRows(rows) {
  return { rows: rows.length, sha256: digest(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())) };
}

function compareData(database) {
  const queries = {
    threads: 'SELECT * FROM turn_summary',
    models: `SELECT t.provider,t.session_id,t.root_turn_id,m.* FROM turn_model_usage m JOIN turn_summary t ON t.id=m.turn_id`,
    costs: `SELECT t.provider,t.session_id,t.root_turn_id,c.* FROM turn_costs c JOIN turn_summary t ON t.id=c.turn_id`,
    sources: 'SELECT provider,session_id,size_bytes,mtime_ms,parser_version,source_missing,processing_status,processing_position,last_error,relation_meta FROM source_file',
  };
  const rows = Object.fromEntries(Object.entries(queries).map(([name, sql]) => [name, fingerprintRows(
    database.connection.prepare(sql).all().map(({ id: _id, turn_id: _turn, updated_at: _updated, ...row }) => row),
  )]));
  const groups = {};
  for (const by of ['provider', 'model']) for (const dimension of ['total', ...dimensions]) {
    const data = [];
    let offset = 0;
    for (;;) {
      const page = database.queryUsagePage({ unknownTime: 'include' }, dimension, timezone, { offset, limit: 1000 }, by);
      data.push(...page.rows);
      offset += page.rows.length;
      if (offset >= page.total || !page.rows.length) {
        assert.equal(offset, page.total);
        break;
      }
    }
    groups[`${by}/${dimension}`] = fingerprintRows(data);
  }
  return { rows, groups };
}

async function collect(product, snapshotPath, dbPath, sameStats) {
  assert.ok(!existsSync(dbPath), 'Use a new database for each collection');
  const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8'));
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const database = new SummaryDatabase(dbPath);
  try {
    global.gc();
    const memory = () => {
      const { rss, heapUsed } = process.memoryUsage();
      return { rss, heapUsed };
    };
    const peak = memory();
    const sample = () => {
      const current = memory();
      peak.rss = Math.max(peak.rss, current.rss);
      peak.heapUsed = Math.max(peak.heapUsed, current.heapUsed);
    };
    const timer = setInterval(sample, sampleIntervalMs), started = performance.now();
    let run;
    try { run = await refreshSummary(database, { roots: snapshot.roots, dbPath, sourceWorkers, timezone }, undefined, sample); }
    finally { clearInterval(timer); }
    const ms = performance.now() - started;
    sample();
    global.gc();
    const afterGc = memory();
    assert.equal(run.failed, 0);
    assert.equal(run.interrupted, false);
    assert.equal(run.parsed, snapshot.files.length);
    const entries = database.connection.prepare(`SELECT provider,count(*) AS threads, sum(input_tokens) AS input,
      sum(output_tokens) AS output, sum(total_tokens) AS tokens FROM turn_summary GROUP BY provider`).all();
    const totals = Object.fromEntries(entries.map(row => [row.provider, { threads: row.threads, input: row.input, output: row.output, tokens: row.tokens }]));
    const query = Object.fromEntries(dimensions.map(group => [group, Object.fromEntries(Object.entries(totals).map(([provider, total]) => {
      const sample = queryTotals(database, group, provider);
      for (const field of ['input', 'output', 'tokens']) assert.equal(sample[field], total[field], `${group}/${provider}/${field}`);
      return [provider, sample];
    }))]));
    assert.equal(database.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.deepEqual(database.connection.prepare('PRAGMA foreign_key_check').all(), []);
    const mismatchedModels = database.connection.prepare(`SELECT count(*) AS n FROM (
      SELECT t.id FROM turn_summary t LEFT JOIN turn_model_usage m ON m.turn_id=t.id GROUP BY t.id
      HAVING t.input_tokens<>coalesce(sum(m.input_tokens),0) OR t.output_tokens<>coalesce(sum(m.output_tokens),0)
      OR t.cache_read_input_tokens<>coalesce(sum(m.cache_read_input_tokens),0)
      OR t.cache_write_input_tokens<>coalesce(sum(m.cache_write_input_tokens),0))`).get().n;
    assert.equal(mismatchedModels, 0);
    return { ms, peak, afterGc, files: run.parsed, bytes: run.bodyBytes, stages: run.timings.scan, totals, query,
      ...(sameStats ? { fingerprints: compareData(database) } : {}),
      checks: { integrity: true, foreignKeys: true, rollupSums: true, modelSums: true } };
  } finally { database.close(); }
}

function launch(product, snapshot, dbPath, sameStats) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--child', product, snapshot, dbPath, ...(sameStats ? ['--same-stats'] : [])], {
      execArgv: ['--no-warnings', '--expose-gc'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
    });
    let result;
    child.on('message', value => { result = value; });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(`Collector exited with code ${code}`)));
  });
}

async function main(before, after, snapshotPath, outputPath, reportOrOption) {
  assert.ok(before && after && snapshotPath && outputPath, 'Pass BEFORE AFTER FROZEN_SNAPSHOT OUTPUT [PREVIOUS_REPORT | --same-stats]');
  const sameStats = reportOrOption === '--same-stats';
  const previousReportPath = sameStats ? undefined : reportOrOption;
  const [a, b, input, output] = [before, after, snapshotPath, outputPath].map(path => resolve(path));
  const workspace = await mkdtemp(join(dirname(input), 'thread-ab-'));
  const snapshot = JSON.parse(await readFile(input, 'utf8'));
  const [sourceA, sourceB, buildA, buildB] = await Promise.all([a, b, join(a, 'dist'), join(b, 'dist')]
    .map(path => fingerprint(join(path, 'src'))));
  const builds = { A: { source: sourceA, compiled: buildA }, B: { source: sourceB, compiled: buildB } };
  const environment = { node: process.version, sqlite: process.versions.sqlite, platform: process.platform, arch: process.arch };
  const protocol = { runsPerBuild: 1, order: 'A/B', warmups: 0, sourceWorkers, sampleIntervalMs, timezone, emptyDatabases: true };
  let A;
  if (previousReportPath) {
    const previous = JSON.parse(await readFile(previousReportPath, 'utf8'));
    const { reusedBaseline: _reusedBaseline, ...previousProtocol } = previous.protocol;
    assert.deepEqual(previousProtocol, protocol);
    assert.deepEqual(previous.environment, environment);
    assert.deepEqual(previous.builds.A, builds.A);
    assert.equal(previous.input.sha256, snapshot.sha256);
    A = previous.samples.A;
  } else {
    A = await launch(a, input, join(workspace, 'thread-before.sqlite'), sameStats);
  }
  const B = await launch(b, input, join(workspace, 'thread-after.sqlite'), sameStats);
  const oracle = await auditThreadUsage(snapshot, a);
  for (const file of snapshot.files) assert.equal(digest(await readFile(file.path)), file.sha256, 'Frozen input changed');
  const differences = {};
  for (const [provider, expected] of Object.entries(oracle.totals)) {
    differences[provider] = Object.fromEntries(['input', 'output', 'tokens'].map(field => [field,
      { A: A.totals[provider][field] - expected[field], B: B.totals[provider][field] - expected[field] }]));
  }
  const matchesOracle = Object.values(differences).every(fields => Object.values(fields).every(delta => delta.B === 0));
  const mismatched = sameStats ? ['rows', 'groups'].flatMap(section => Object.keys(A.fingerprints[section])
    .filter(key => A.fingerprints[section][key].sha256 !== B.fingerprints[section][key].sha256)) : undefined;
  const report = {
    dateSeoul: '2026-11-24', baselineCommit: '21ff22b',
    environment, protocol: { ...protocol, reusedBaseline: !!previousReportPath },
    input: { sha256: snapshot.sha256, inventory: snapshot.inventory }, builds, samples: { A, B }, oracle, differences, matchesOracle,
    ...(sameStats ? { mismatched, matchesBaseline: !mismatched.length } : {}),
  };
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ A: { ms: A.ms, peak: A.peak, totals: A.totals }, B: { ms: B.ms, peak: B.peak, totals: B.totals },
    expected: oracle.totals, differences, matchesOracle, mismatched }));
  if (!matchesOracle || mismatched?.length) process.exitCode = 1;
}

const args = process.argv.slice(2);
const run = args[0] === '--child'
  ? collect(...args.slice(1)).then(sample => new Promise((done, fail) => process.send(sample, error => error ? fail(error) : done())))
  : main(...args);
run.catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => { if (process.connected) process.disconnect(); });
