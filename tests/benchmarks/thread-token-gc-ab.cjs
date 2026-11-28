// Measures natural V8 GC pauses on the frozen input and builds from the token buffer A/B.
'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { constants } = require('node:fs');
const fs = require('node:fs/promises');
const { dirname, join, relative, resolve, sep } = require('node:path');
const { createInterface } = require('node:readline');
const { setFlagsFromString } = require('node:v8');
const { compare, fileHash, selectAppend, storedResults, treeHash } = require('./thread-token-buffer-ab.cjs');

const timezone = 'Asia/Seoul';
const sourceWorkers = 4;
const tracePattern = /\[\d+:([\da-fx]+)(?::\d+)?\]\s+(\d+) ms: pause=([\d.]+) mutator=[\d.]+ gc=(\w+)/ig;

async function collect(product, manifest, dbPath) {
  const { roots } = JSON.parse(await fs.readFile(manifest, 'utf8'));
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const database = new SummaryDatabase({ databasePath: dbPath, timezone });
  let workers = 0;
  process.on('worker', () => workers++);
  try {
    // The only forced collection precedes the measured window and identifies the collector isolate.
    let run, durationMs;
    setFlagsFromString('--trace-gc-nvp');
    try {
      global.gc();
      const started = performance.now();
      run = await refreshSummary(database, { roots, dbPath, sourceWorkers, timezone });
      durationMs = performance.now() - started;
    } finally {
      setFlagsFromString('--no-trace-gc-nvp');
    }
    assert.equal(run.interrupted, false, run.error);
    assert.equal(run.failed, 0);
    return { durationMs, workers, parsed: run.parsed, bytes: run.bodyBytes, ...storedResults(database) };
  } finally {
    database.close();
  }
}

function readTrace(child) {
  const events = [];
  let collector, firstKind, workerCount = 0, unparsed = 0;
  const workerIds = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    const matches = [...line.matchAll(tracePattern)];
    unparsed += (line.match(/(?:^|\s)pause=/g)?.length ?? 0) - matches.length;
    for (const [, isolate, timestampMs, pause, kind] of matches) {
      if (!collector) {
        collector = isolate;
        firstKind = kind;
        continue;
      }
      let thread = 'collector';
      if (isolate !== collector) {
        if (!workerIds.has(isolate)) workerIds.set(isolate, `source-${++workerCount}`);
        thread = workerIds.get(isolate);
      }
      events.push([thread, Number(timestampMs), kind, Math.round(Number(pause) * 10)]);
    }
  });
  return new Promise((done, reject) => {
    lines.on('error', reject);
    lines.once('close', () => {
      try {
        assert.ok(collector);
        assert.equal(firstKind, 'mc', 'Expected the forced collection as the first trace record');
        assert.equal(unparsed, 0, 'Unparsed V8 GC pause records');
        done({ events, workerCount });
      } catch (error) { reject(error); }
    });
  });
}

async function sample(product, manifest, database) {
  const child = fork(__filename, ['--child', product, manifest, database], {
    execArgv: ['--no-warnings', '--expose-gc'],
    stdio: ['ignore', 'pipe', 'inherit', 'ipc'], windowsHide: true,
  });
  const result = new Promise((done, reject) => {
    let value;
    child.on('message', message => { value = message; });
    child.on('error', reject);
    child.on('exit', code => code === 0 && value ? done(value) : reject(new Error(`Collector exited with code ${code}`)));
  });
  const [run, trace] = await Promise.all([result, readTrace(child)]);
  assert.ok(trace.workerCount <= run.workers, 'Unexpected V8 isolates');
  return { ...run, ...trace };
}

async function verifySnapshot(snapshot, folder) {
  for (const file of snapshot.files) {
    assert.ok(resolve(file.path).startsWith(folder + sep), 'Keep the input inside the frozen workspace');
    assert.equal(await fileHash(file.path), file.sha256, 'Frozen input changed');
  }
}

async function measure(folder, runs, products, reference, name, pairs, warmups) {
  const manifest = join(folder, 'snapshot.json');
  const snapshot = JSON.parse(await fs.readFile(manifest, 'utf8'));
  assert.equal(snapshot.sha256, reference.sha256);
  await verifySnapshot(snapshot, folder);
  const results = {};
  const runPhase = async phase => {
    const seed = join(folder, 'seed.sqlite');
    const expected = reference.samples[phase][0].A;
    const rows = results[phase] = [];
    for (let index = -warmups; index < pairs; index++) {
      const order = index % 2 === 0 ? 'AB' : 'BA';
      const row = { order };
      for (const variant of order) {
        const db = join(runs, `${name}-${phase}-${variant}.sqlite`);
        if (phase === 'append') await fs.copyFile(seed, db, constants.COPYFILE_EXCL);
        try {
          const { durationMs, workers, parsed, bytes, events, workerCount, ...persisted } = await sample(products[variant], manifest, db);
          compare({ parsed, bytes, ...persisted }, expected);
          row[variant] = { durationMs, workers, parsed, bytes, traceWorkerIsolates: workerCount, events };
        } finally {
          for (const suffix of ['', '-shm', '-wal']) await fs.rm(db + suffix, { force: true });
        }
      }
      if (index >= 0) rows.push(row);
      if (index === -1 || index >= 0 && (index + 1) % 5 === 0)
        console.log(`${name} ${phase} ${index < 0 ? 'warmups complete' : `${index + 1}/${pairs}`}`);
    }
  };
  await runPhase('cold');
  const append = await selectAppend(snapshot, products.A);
  const stat = await fs.stat(append.file.path);
  assert.equal(stat.size, reference.appendTarget.beforeBytes);
  assert.equal(append.append.length, reference.appendTarget.appendedBytes);
  try {
    await fs.appendFile(append.file.path, append.append);
    await fs.utimes(append.file.path, stat.atime, new Date(stat.mtimeMs + 10_000));
    assert.equal(await fileHash(append.file.path), reference.appendTarget.sha256);
    await runPhase('append');
  } finally {
    await fs.truncate(append.file.path, stat.size);
    await fs.utimes(append.file.path, stat.atime, stat.mtime);
  }
  await verifySnapshot(snapshot, folder);
  return { sha256: snapshot.sha256, samples: results };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
  const { workspace, output, reference } = args;
  assert.ok(workspace && output && reference, 'Pass --workspace, --reference and --output');
  const pairs = Number(args.pairs ?? 20), warmups = Number(args.warmups ?? 3);
  assert.ok(Number.isSafeInteger(pairs) && pairs >= 2 && pairs % 2 === 0 && Number.isSafeInteger(warmups) && warmups >= 1);
  const startedAt = new Date().toISOString();
  const previous = JSON.parse(await fs.readFile(reference, 'utf8'));
  assert.equal(process.version, previous.environment.node, 'Use the Node version from the memory run');
  const products = { A: resolve(workspace, 'A'), B: resolve(workspace, 'B') };
  for (const [variant, product] of Object.entries(products)) {
    assert.equal(await treeHash(join(product, 'src')), previous.builds[variant].source);
    assert.equal(await treeHash(join(product, 'dist/src')), previous.builds[variant].build);
  }
  const runs = await fs.mkdtemp(join(resolve(workspace), 'gc-runs-'));
  const inputs = {};
  for (const name of args.dataset ? [args.dataset] : ['real', '10000', '100']) {
    const dataset = previous.inputs[name];
    assert.ok(dataset, 'Unknown dataset');
    inputs[name] = await measure(resolve(workspace, name), runs, products, dataset, name, pairs, warmups);
  }
  const target = resolve(output);
  await fs.mkdir(dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify({
    startedAt, completedAt: new Date().toISOString(), environment: previous.environment, builds: previous.builds,
    referenceSha256: await fileHash(reference), protocol: { pairs, warmups, sourceWorkers, timezone, flag: '--trace-gc-nvp' },
    eventColumns: ['isolate', 'traceTimestampMs', 'gcKind', 'pauseTenthsMs'], inputs,
  }, null, 2) + '\n', { flag: 'wx' });
  console.log(`Saved GC measurements: ${relative(process.cwd(), target)}`);
}

const run = process.argv[2] === '--child'
  ? collect(...process.argv.slice(3)).then(value => new Promise((done, reject) => process.send(value, error => error ? reject(error) : done())))
  : main();
run.catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => { if (process.connected) process.disconnect(); });
