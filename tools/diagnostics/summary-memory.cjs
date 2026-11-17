// 같은 입력의 반복 집계·GC 전후 메모리와 집계 객체·Worker 수명을 진단한다.
'use strict';

const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { mkdir, mkdtemp, readFile, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { cpus } = require('node:os');
const { setImmediate: nextTurn } = require('node:timers/promises');
const v8 = require('node:v8');

const project = resolve(__dirname, '../..');
const sha = value => createHash('sha256').update(value).digest('hex');
const must = (condition, message) => { if (!condition) throw new Error(message); };
const send = value => new Promise((done, fail) => process.send(value, error => error ? fail(error) : done()));
const memory = () => ({ ...process.memoryUsage(), lifetimeMaxRss: process.resourceUsage().maxRSS * 1024 });

async function collectGarbage() {
  await nextTurn();
  global.gc({ type: 'major', execution: 'sync' });
  await nextTurn();
  global.gc({ type: 'major', execution: 'sync' });
  await nextTurn();
}

function facts(database) {
  const digest = createHash('sha256');
  const query = `SELECT provider,session_id,root_turn_id,status,started_at_ms,completed_at_ms,
    duration_ms,input_tokens,output_tokens,total_tokens,cache_write_input_tokens,cache_read_input_tokens
    FROM turn_summary ORDER BY provider,session_id,root_turn_id`;
  for (const row of database.connection.prepare(query).iterate()) digest.update(JSON.stringify(row));
  const totals = database.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
  return { ...totals, sha256: digest.digest('hex') };
}

function transientCounts() {
  const constructors = {
    ScanState: require('../../dist/src/summary/scanner/refresh/state').ScanState,
    SourceReaderPool: require('../../dist/src/summary/scanner/sourcePool').SourceReaderPool,
    SourceWinners: require('../../dist/src/summary/aggregation/sourceWinners').SourceWinners,
    SourceEvidence: require('../../dist/src/summary/aggregation/sourceEvidence').SourceEvidence,
    StreamingAggregation: require('../../dist/src/summary/aggregation/memoryAggregate').StreamingAggregation,
    Winners: require('../../dist/src/summary/aggregation/winners').Winners,
    MemoryStore: require('../../dist/src/summary/db/memoryStore').MemoryStore,
    Worker: require('node:worker_threads').Worker,
  };
  return Object.fromEntries(Object.entries(constructors).map(([name, constructor]) =>
    [name, v8.queryObjects(constructor, { format: 'count' })]));
}

async function inspectDataset(config, mode, directory) {
  must(typeof global.gc === 'function', 'Start the diagnostic with --expose-gc');
  const { SummaryDatabase } = require('../../dist/src/summary/db');
  const { refreshSummary } = require('../../dist/src/summary/scanner');
  const { StreamingAggregation } = require('../../dist/src/summary/aggregation/memoryAggregate');
  const activeWorkers = new Set();
  let createdWorkers = 0, maximumWorkers = 0, observedPeak;
  const onWorker = worker => {
    const id = worker.threadId;
    activeWorkers.add(id);
    createdWorkers++;
    maximumWorkers = Math.max(maximumWorkers, activeWorkers.size);
    worker.once('exit', () => activeWorkers.delete(id));
  };
  process.on('worker', onWorker);
  const sample = () => {
    const current = memory();
    if (observedPeak) for (const key of Object.keys(current)) observedPeak[key] = Math.max(observedPeak[key], current[key]);
  };
  // Observe synchronous stage boundaries in addition to the 10 ms timer.
  const finish = StreamingAggregation.prototype.finish;
  StreamingAggregation.prototype.finish = function(...args) {
    sample();
    const result = Reflect.apply(finish, this, args);
    sample();
    return result;
  };
  const dbPath = join(directory, 'summary.sqlite');
  let database = new SummaryDatabase(dbPath);
  const replace = database.replaceMemoryBatch;
  database.replaceMemoryBatch = function(...args) {
    sample();
    const result = Reflect.apply(replace, this, args);
    sample();
    return result;
  };
  const options = { dbPath, roots: config.roots, timezone: 'Asia/Seoul' };
  const refresh = async (force, cancel = false) => {
    if (force) database.connection.exec('UPDATE manifest SET parser_version=0');
    const controller = new AbortController();
    let cancellationScheduled = false;
    const result = await refreshSummary(database, options, controller.signal, progress => {
      sample();
      if (cancel && progress.phase === 'parsing' && !cancellationScheduled) {
        cancellationScheduled = true;
        // Yield once so initial prefetch/read setup can start before cancellation.
        void nextTurn().then(() => controller.abort());
      }
    });
    return { parsed: result.parsed, failed: result.failed, interrupted: result.interrupted,
      error: result.error, bodyBytes: result.bodyBytes, elapsedMs: result.timings.totalMs,
      sourcePoolCloseMs: result.timings.scan.sourcePoolClose?.totalMs ?? 0 };
  };
  let expected;
  const check = () => {
    const current = facts(database);
    if (expected) must(JSON.stringify(current) === JSON.stringify(expected), 'Repeated aggregation changed the request facts');
    else expected = current;
    if (config.expected) must(current.requests === config.expected.requests && current.tokens === config.expected.tokens,
      'Synthetic request/token totals differ from the fixture formula');
  };
  try {
    for (let index = 0; index < 3; index++) {
      const result = await refresh(true);
      must(!result.interrupted, `Warmup interrupted: ${result.error}`);
      check();
    }
    await collectGarbage();
    const baseline = { memory: memory(), counts: transientCounts(), activeWorkers: activeWorkers.size,
      cachedStatements: database.sqlite.statements.size, totals: expected };
    await send({ type: 'baseline', dataset: config.name, mode, value: baseline });
    if (mode === 'snapshots') {
      v8.writeHeapSnapshot(join(directory, 'before.heapsnapshot'));
      for (let index = 1; index <= 20; index++) {
        const result = await refresh(true);
        must(!result.interrupted, `Snapshot refresh interrupted: ${result.error}`);
        check();
        if (index % 5 === 0) await send({ type: 'progress', dataset: config.name, mode, iteration: index });
      }
      await collectGarbage();
      const endpoint = { memory: memory(), counts: transientCounts(), activeWorkers: activeWorkers.size,
        cachedStatements: database.sqlite.statements.size };
      v8.writeHeapSnapshot(join(directory, 'after.heapsnapshot'));
      await send({ type: 'snapshotEndpoint', dataset: config.name, mode, value: endpoint });
    } else {
      for (const scenario of ['reparse', 'unchanged', 'cancel']) {
        const repetitions = scenario === 'cancel' ? 5 : 20;
        for (let index = 1; index <= repetitions; index++) {
          await collectGarbage();
          const before = memory(), workersBefore = createdWorkers;
          observedPeak = { ...before };
          const timer = setInterval(sample, 10);
          let result;
          try { result = await refresh(scenario !== 'unchanged', scenario === 'cancel'); }
          finally { clearInterval(timer); }
          const beforeGc = memory(), peak = observedPeak;
          observedPeak = undefined;
          if (scenario === 'cancel') must(result.interrupted && result.error === 'interrupted', 'Cancellation did not interrupt the parsing phase');
          else must(!result.interrupted, `Refresh interrupted: ${result.error}`);
          // Facts verification is outside the reported GC endpoint, avoiding verifier allocations in beforeGc.
          check();
          await collectGarbage();
          const afterGc = memory();
          must(activeWorkers.size === 0, 'A file worker remained alive after refresh settled');
          await send({ type: 'sample', dataset: config.name, mode, scenario, iteration: index,
            result, before, beforeGc, afterGc, observedPeak: peak, activeWorkers: activeWorkers.size,
            createdWorkers: createdWorkers - workersBefore, cachedStatements: database.sqlite.statements.size });
        }
        await collectGarbage();
        await send({ type: 'counts', dataset: config.name, mode, scenario, value: transientCounts() });
      }
      const recovery = await refresh(true);
      must(!recovery.interrupted, 'Recovery refresh was interrupted');
      check();
    }
    database.close();
    database = undefined;
    await collectGarbage();
    await send({ type: 'closed', dataset: config.name, mode, value: { memory: memory(), counts: transientCounts(),
      createdWorkers, maximumWorkers, activeWorkers: activeWorkers.size } });
  } finally {
    database?.close();
    StreamingAggregation.prototype.finish = finish;
    process.removeListener('worker', onWorker);
  }
}

async function inspectClient(directory, config) {
  const { SummaryClient } = require('../../dist/src/summary/client');
  const { WorkerTransport } = require('../../dist/src/summary/client/transport');
  const { RefreshController } = require('../../dist/src/summary/client/refresh');
  const { Worker } = require('node:worker_threads');
  const constructors = { SummaryClient, WorkerTransport, RefreshController, Worker };
  for (let iteration = 1; iteration <= 20; iteration++) {
    await (async () => {
      const client = new SummaryClient({ dbPath: join(directory, 'client.sqlite'), roots: config.roots });
      const unsubscribe = client.subscribe(() => {});
      try {
        await client.initialize();
        const refreshed = await client.refresh();
        must(!refreshed.interrupted && !refreshed.failed, 'Client refresh failed');
        const result = await client.query({ groupBy: 'all', limit: 100 });
        must(result.total > 0, 'Client returned no usage');
      } finally { unsubscribe(); await client.dispose(); }
    })();
    await collectGarbage();
    const counts = Object.fromEntries(Object.entries(constructors).map(([name, ctor]) => [name, v8.queryObjects(ctor, { format: 'count' })]));
    await send({ type: 'clientSample', iteration, memory: memory(), counts });
  }
}

function runChild(configPath, mode, directory, report) {
  mkdirSync(directory, { recursive: true });
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--child', configPath, mode, directory], {
      cwd: project, execArgv: ['--expose-gc'], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let errorText = '';
    child.stderr.on('data', chunk => { errorText = (errorText + chunk).slice(-3000); });
    child.on('message', value => {
      report.events.push(value);
      if (value.type !== 'sample' || value.iteration % 5 === 0) {
        const log = value.type === 'sample' ? { dataset: value.dataset, scenario: value.scenario, iteration: value.iteration,
          heapMB: +(value.afterGc.heapUsed / 1e6).toFixed(2), rssMB: +(value.afterGc.rss / 1e6).toFixed(2) }
          : { type: value.type, dataset: value.dataset, mode: value.mode, iteration: value.iteration };
        console.log(JSON.stringify(log));
      }
      writeFileSync(join(report.workspace, 'events.private.json'), JSON.stringify(report, null, 2) + '\n');
    });
    child.on('error', fail);
    child.on('exit', code => code === 0 ? done() : fail(new Error(`Diagnostic child exited ${code}: ${errorText}`)));
  });
}

async function summarizeSnapshot(path) {
  const snapshot = JSON.parse(await readFile(path, 'utf8'));
  const fields = snapshot.snapshot.meta.node_fields, width = fields.length;
  const typeAt = fields.indexOf('type'), nameAt = fields.indexOf('name'), sizeAt = fields.indexOf('self_size');
  const types = snapshot.snapshot.meta.node_types[typeAt];
  const selected = new Set(['Map', 'Set', 'Array', 'Promise', 'ScanState', 'SourceReaderPool', 'SourceWinners',
    'SourceEvidence', 'StreamingAggregation', 'Winners', 'MemoryStore', 'Worker', 'StatementSync', 'DatabaseSync',
    'SqliteSession', 'FileHandle', 'AbortController', 'AbortSignal']);
  const byType = {}, objects = {};
  for (let index = 0; index < snapshot.nodes.length; index += width) {
    const type = types[snapshot.nodes[index + typeAt]], size = snapshot.nodes[index + sizeAt];
    byType[type] ??= { count: 0, shallowBytes: 0 };
    byType[type].count++; byType[type].shallowBytes += size;
    const name = snapshot.strings[snapshot.nodes[index + nameAt]];
    if (type === 'object' && selected.has(name)) {
      objects[name] ??= { count: 0, shallowBytes: 0 };
      objects[name].count++; objects[name].shallowBytes += size;
    }
  }
  return { nodeCount: snapshot.snapshot.node_count, edgeCount: snapshot.snapshot.edge_count, byType, objects };
}

async function main() {
  const workspace = await mkdtemp(join(project, 'tests/.cache/memory-lifetime-'));
  const helpers = require('../../tests/benchmarks/incremental-refresh.cjs');
  const report = { dateSeoul: '2026-11-16', workspace, startedAt: new Date().toISOString(),
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: project, encoding: 'utf8', windowsHide: true }).trim(),
    environment: { node: process.version, v8: process.versions.v8, sqlite: process.versions.sqlite,
      platform: process.platform, cpu: cpus()[0].model, logicalCpus: cpus().length },
    runnerSha256: sha(readFileSync(__filename)), datasets: [], events: [], snapshots: {} };
  console.log(JSON.stringify({ workspace }));
  const configs = [];
  for (const spec of [{ name: 'real', real: true }, { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 },
    { name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }]) {
    const directory = join(workspace, spec.name);
    await mkdir(directory, { recursive: true });
    const frozen = await helpers.makeSnapshot(directory, { ...spec, after: project });
    const config = { name: spec.name, roots: frozen.roots, expected: frozen.expected };
    const configPath = join(directory, 'config.private.json');
    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');
    configs.push({ ...spec, directory, configPath });
    report.datasets.push({ name: spec.name, inventory: frozen.inventory, sha256: frozen.sha256, expected: frozen.expected });
    console.log(JSON.stringify({ dataset: spec.name, inventory: frozen.inventory }));
  }
  for (const config of configs) await runChild(config.configPath, 'endpoints', join(config.directory, 'endpoints'), report);
  for (const config of configs.slice(0, 2)) {
    const directory = join(config.directory, 'snapshots');
    await runChild(config.configPath, 'snapshots', directory, report);
    report.snapshots[config.name] = { before: await summarizeSnapshot(join(directory, 'before.heapsnapshot')),
      after: await summarizeSnapshot(join(directory, 'after.heapsnapshot')) };
  }
  await runChild(configs[2].configPath, 'client', join(workspace, 'client'), report);
  report.completedAt = new Date().toISOString();
  // Public report contains only aggregates, hashes and environment data, never log paths or heap strings.
  const { workspace: privateWorkspace, ...publicReport } = report;
  const output = join(project, 'docs/research/2026-11-16/SummaryMemory-2026-11-16.json');
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, JSON.stringify(publicReport, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output, privateWorkspace }));
}

if (process.argv[2] === '--child') {
  const [, , , configPath, mode, directory] = process.argv;
  readFile(configPath, 'utf8').then(text => mode === 'client'
    ? inspectClient(directory, JSON.parse(text)) : inspectDataset(JSON.parse(text), mode, directory))
    .then(() => process.disconnect(), error => { console.error(error.stack); process.exitCode = 1; process.disconnect(); });
} else main().catch(error => { console.error(error.stack); process.exitCode = 1; });
