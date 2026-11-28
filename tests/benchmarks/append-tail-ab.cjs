// Compares a known append on frozen JSONL against the normal refresh, including reopened databases.
'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { cpus, release } = require('node:os');
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path');
const { codexAppendRows, inspectCodexTarget } = require('./incremental-refresh.cjs');
const { fileHash, treeHash } = require('./thread-token-buffer-ab.cjs');

const timezone = 'Asia/Seoul';
const sourceWorkers = 4;
const fixtureRoot = 'append-tail-benchmark-turn';
const sha = value => createHash('sha256').update(value).digest('hex');

async function loadJson(path) {
  return JSON.parse(await fs.readFile(path, 'utf8'));
}

async function selectTarget(database, snapshot, product) {
  const sizes = new Map(snapshot.files.map(file => [file.path, file.bytes]));
  const rows = database.connection.prepare(`SELECT path,session_id,thread_id FROM source_file
    WHERE provider='codex' AND processing_status='done' AND source_missing=0`).all();
  const counts = new Map(), totalBytes = new Map();
  for (const row of rows) {
    counts.set(row.session_id, (counts.get(row.session_id) ?? 0) + 1);
    totalBytes.set(row.session_id, (totalBytes.get(row.session_id) ?? 0) + (sizes.get(row.path) ?? 0));
  }
  const candidates = rows.filter(row => row.thread_id === row.session_id && sizes.get(row.path) && row.path.endsWith('.jsonl'))
    .map(row => ({ ...row, originalBytes: sizes.get(row.path), relatedFiles: counts.get(row.session_id) - 1,
      relatedBytes: totalBytes.get(row.session_id) - sizes.get(row.path) }))
    .sort((left, right) => Number(right.relatedFiles > 0) - Number(left.relatedFiles > 0)
      || right.originalBytes - left.originalBytes);
  for (const candidate of candidates) {
    const handle = await fs.open(candidate.path, 'r');
    try {
      const finalByte = Buffer.alloc(1);
      await handle.read(finalByte, 0, 1, candidate.originalBytes - 1);
      if (finalByte[0] !== 10) continue;
    } finally { await handle.close(); }
    await inspectCodexTarget(candidate, product);
    if (candidate.format === 'current') return candidate;
  }
  throw new Error('The frozen input has no complete plain current-format Codex main source');
}

async function collect(configPath, variant, dbPath, scenario) {
  const { capture } = require('./append-tail-checks.cjs');
  const { products, snapshot, appendPath, targetPath } = await loadJson(configPath);
  const product = products[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const database = new SummaryDatabase({ databasePath: dbPath, timezone });
  let result;
  try {
    const append = scenario === 'append' || scenario === 'repeat-response' ? appendPath : null;
    const { interrupted, failed, error, completedAt: _time, ...refresh } = await refreshSummary(database, {
      dbPath, roots: snapshot.roots, timezone, sourceWorkers, ...(append ? { benchmarkTailAppendPath: append } : {}),
    });
    assert.equal(interrupted, false, `Refresh interrupted: ${error}`);
    assert.equal(failed, 0, 'A source failed to refresh');
    const checkpoints = database.connection.prepare(`SELECT count(*) AS count FROM sqlite_schema
      WHERE name='benchmark_tail_checkpoint'`).get().count;
    const sql = checkpoints ? database.connection.prepare('SELECT count(*) AS rows FROM benchmark_tail_checkpoint').get() : null;
    result = { refresh, stored: capture(database), sql };
    if (scenario === 'select') result.target = await selectTarget(database, snapshot, product);
    if (targetPath) {
      const source = database.findSourceFile('codex', targetPath);
      assert.ok(source, 'Target source must still be indexed');
    }
  } finally { database.close(); }
  return { ...result, databaseBytes: (await fs.stat(dbPath)).size };
}

function child(config, variant, database, scenario) {
  return new Promise((done, reject) => {
    const processChild = fork(__filename, ['--child', config, variant, database, scenario], {
      execArgv: ['--no-warnings'], env: { ...process.env, AGENT_TRACKER_BENCHMARK_TAIL: '1' },
      stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
    });
    let value;
    processChild.on('message', message => { value = message; });
    processChild.on('error', reject);
    processChild.on('exit', status => status === 0 && value ? done(value)
      : reject(new Error(`A/B collector ${variant}/${scenario} exited with status ${status}`)));
  });
}

function fixture(target) {
  const source = codexAppendRows(target, fixtureRoot, `${fixtureRoot}-response`);
  for (const [index, row] of source.entries()) row.timestamp = new Date(Date.UTC(2026, 10, 28, 5, 0, index)).toISOString();
  return Buffer.from(source.map(row => JSON.stringify(row)).join('\n') + '\n');
}

async function checkFiles(snapshot) {
  for (const file of snapshot.files) assert.equal(await fileHash(file.path), file.sha256, 'Frozen source content changed');
}

async function overwrite(position, path, bytes) {
  const handle = await fs.open(path, 'r+');
  try { assert.equal((await handle.write(bytes, 0, bytes.length, position)).bytesWritten, bytes.length); }
  finally { await handle.close(); }
}

async function measure({ directory, workspace, name, products, pairs, warmups, edgeCoverage }) {
  const { compare, assertDelta, appendExpectation } = require('./append-tail-checks.cjs');
  const snapshot = await loadJson(join(workspace, name, 'snapshot.json'));
  await checkFiles(snapshot);
  const config = join(directory, 'run.private.json');
  const db = (which, variant) => join(directory, `${which}-${variant}.sqlite`);
  await fs.writeFile(config, JSON.stringify({ snapshot, products }));
  const { target, ...initialA } = await child(config, 'A', db('seed', 'A'), 'select');
  const initialB = await child(config, 'B', db('seed', 'B'), 'initial');
  compare(initialA.stored, initialB.stored, 'initial');
  assert.ok(initialB.sql?.rows > 0, 'B must actually populate its SQLite checkpoints');
  const initial = { A: initialA, B: initialB };
  const inWorkspace = relative(await fs.realpath(workspace), await fs.realpath(target.path));
  assert.ok(inWorkspace && !isAbsolute(inWorkspace) && inWorkspace !== '..' && !inWorkspace.startsWith('..' + sep),
    'The benchmark may modify only a frozen copy inside its workspace');
  const original = await fs.stat(target.path), extra = fixture(target);
  assert.equal(original.size, target.originalBytes);
  const changedTime = new Date(Math.ceil(original.mtimeMs) + 10_000);
  const expectedAppend = appendExpectation(extra);
  if (snapshot.expected) {
    const totals = Object.values(initialA.stored.totals);
    for (const metric of ['requests', 'tokens'])
      assert.equal(totals.reduce((sum, row) => sum + row[metric], 0), snapshot.expected[metric]);
  }
  const samples = [], edges = {};
  const runPair = async (label, scenario, source, order = ['A', 'B']) => {
    const values = {};
    for (const variant of order) {
      const database = db(label, variant);
      await fs.copyFile(db(source, variant), database);
      values[variant] = await child(config, variant, database, scenario);
      if (label !== 'append-0') await fs.unlink(database);
    }
    compare(values.A.stored, values.B.stored, label);
    return values;
  };

  try {
    await fs.appendFile(target.path, extra);
    await fs.utimes(target.path, original.atime, changedTime);
    await fs.writeFile(config, JSON.stringify({ snapshot, products, appendPath: target.path, targetPath: target.path }));
    for (let pair = -warmups; pair < pairs; pair++) {
      const order = pair % 2 === 0 ? ['A', 'B'] : ['B', 'A'];
      const values = await runPair(`append-${pair}`, 'append', 'seed', order);
      assertDelta(initial.A.stored, values.A.stored, expectedAppend);
      assert.equal(values.B.refresh.bodyBytes, extra.length, `${name}: B must read exactly the appended bytes`);
      samples.push({ pair, order, ...values });
      console.log(`${name} pair ${pair}: ${values.A.refresh.timings.totalMs.toFixed(2)} / ${values.B.refresh.timings.totalMs.toFixed(2)} ms, ${values.A.refresh.bodyBytes} / ${values.B.refresh.bodyBytes} bytes`);
    }
    edges.unchanged = await runPair('unchanged', 'unchanged', 'append-0');
    compare(samples[warmups].A.stored, edges.unchanged.A.stored, 'unchanged append result');
    assert.equal(edges.unchanged.A.refresh.bodyBytes, 0);
    assert.equal(edges.unchanged.B.refresh.bodyBytes, 0);

    if (edgeCoverage) {
      const response = JSON.parse(extra.toString().split('\n')[2]);
      response.payload.usage.input_tokens = 223;
      const repeated = Buffer.from(JSON.stringify(response) + '\n');
      await fs.appendFile(target.path, repeated);
      await fs.utimes(target.path, original.atime, new Date(changedTime.getTime() + 10_000));
      edges.repeatResponse = await runPair('repeat-response', 'repeat-response', 'append-0');
      assertDelta(samples[warmups].A.stored, edges.repeatResponse.A.stored, { requests: 0, input: 100, output: 0, tokens: 100 });
      assert.equal(edges.repeatResponse.B.refresh.bodyBytes, repeated.length);

      const revisedPrefix = Buffer.from(extra.toString().replace('"input_tokens":123', '"input_tokens":323'));
      assert.equal(revisedPrefix.length, extra.length);
      await overwrite(original.size, target.path, revisedPrefix);
      await fs.utimes(target.path, original.atime, new Date(changedTime.getTime() + 20_000));
      edges.rewriteAndGrow = await runPair('rewrite-and-grow', 'rewrite-and-grow', 'append-0');
      assertDelta(samples[warmups].A.stored, edges.rewriteAndGrow.A.stored, { requests: 0, input: 200, output: 0, tokens: 200 });
      assert.ok(edges.rewriteAndGrow.B.refresh.bodyBytes >= original.size + extra.length + repeated.length);
      await fs.truncate(target.path, original.size + extra.length);
    }

    const rewritten = Buffer.from(extra.toString().replace('"input_tokens":123', '"input_tokens":223'));
    assert.equal(rewritten.length, extra.length);
    assert.notDeepEqual(rewritten, extra);
    await overwrite(original.size, target.path, rewritten);
    await fs.utimes(target.path, original.atime, new Date(changedTime.getTime() + 10_000));
    edges.rewrite = await runPair('rewrite', 'rewrite', 'append-0');
    assertDelta(initial.A.stored, edges.rewrite.A.stored, appendExpectation(rewritten));
    assert.ok(edges.rewrite.B.refresh.bodyBytes >= original.size + extra.length, 'Same-size rewrite must fully reparse the changed file');

    await fs.truncate(target.path, original.size);
    await fs.utimes(target.path, original.atime, original.mtimeMs / 1000);
    edges.truncate = await runPair('truncate', 'truncate', 'append-0');
    compare(initial.A.stored, edges.truncate.A.stored, 'restored initial state');
    assert.ok(edges.truncate.B.refresh.bodyBytes >= original.size, 'Truncate must fully reparse the changed file');
  } finally {
    await fs.truncate(target.path, original.size);
    await fs.utimes(target.path, original.atime, original.mtimeMs / 1000);
  }
  await checkFiles(snapshot);
  return { name, inputSha256: snapshot.sha256, inventory: snapshot.inventory, expected: snapshot.expected ?? null,
    target: { originalBytes: target.originalBytes, relatedFiles: target.relatedFiles, relatedBytes: target.relatedBytes,
      appendedBytes: extra.length, appendSha256: sha(extra) }, expectedAppend, initial, samples, edges };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.slice(2).split(/=(.*)/s).slice(0, 2)));
  const workspace = resolve(args.workspace), output = resolve(args.output);
  const products = { A: resolve(args.before), B: resolve(args.after) };
  const pairs = Number(args.pairs ?? 20), warmups = Number(args.warmups ?? 3);
  const edgeCoverage = args['edge-coverage'] === 'true';
  assert.ok(Number.isSafeInteger(pairs) && pairs > 0 && Number.isSafeInteger(warmups) && warmups >= 0);
  const names = (args.datasets ?? 'current,synthetic-10000,synthetic-100').split(',');
  const folder = await fs.mkdtemp(join(workspace, 'append-trials-'));
  const builds = {};
  for (const [variant, product] of Object.entries(products)) {
    builds[variant] = { source: await treeHash(join(product, 'src')), dist: await treeHash(join(product, 'dist/src')) };
  }
  const report = { environment: { node: process.version, sqlite: process.versions.sqlite, platform: process.platform,
    release: release(), cpu: cpus()[0].model }, builds, protocol: { pairs, warmups, timezone, sourceWorkers,
    timing: 'Refresh from entry through COMMIT and cleanup; database copy/open, process startup, fixture changes and validation excluded.',
    order: 'alternating AB/BA, fresh process and copied pre-append database per sample', edgeCoverage,
    tailContract: 'Changed path provided only for controlled append. No path hint for rewrite or truncate.' }, datasets: [] };
  for (const name of names) {
    const directory = join(folder, name);
    await fs.mkdir(directory);
    report.datasets.push(await measure({ directory, workspace, name, products, pairs, warmups, edgeCoverage }));
    await fs.writeFile(join(folder, 'partial.json'), JSON.stringify(report, null, 2) + '\n');
  }
  await fs.mkdir(dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  console.log(`Wrote ${output}`);
}

const run = process.argv[2] === '--child'
  ? collect(...process.argv.slice(3)).then(value => new Promise((done, reject) => process.send(value, error => error ? reject(error) : done())))
  : main();
run.catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { if (process.connected) process.disconnect(); });
