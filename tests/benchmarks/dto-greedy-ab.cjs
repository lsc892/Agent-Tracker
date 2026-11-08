// 실제 파일 사본에서 파괴적 greedy의 정합성과 원본 보존·Map 없는 대조군의 비용을 비교한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join, resolve, dirname, relative, basename } = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { cpus } = require('node:os');
const { performance } = require('node:perf_hooks');
const helpers = require('./incremental-refresh.cjs');
const { allUsage, independentCheck, stats } = require('./temp-batch-ab.cjs');
const { loadCandidates, selectBeforeValidation, discardValidatedLosers, digest, totals, sha } = require('./dto-greedy-candidate.cjs');
const root = resolve(__dirname, '../..'), groups = ['day', 'month', 'session', 'project'];
const seoul = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Seoul', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());

function restoreMain(db, seed) {
  const c = db.connection, before = c.prepare('PRAGMA main.data_version').get().data_version;
  c.prepare('ATTACH DATABASE ? AS greedy_baseline').run(seed);
  const tables = c.prepare("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  c.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try {
    for (const { name } of tables) c.exec(`DELETE FROM main."${name.replaceAll('"', '""')}"`);
    for (const { name } of tables) {
      const table = `"${name.replaceAll('"', '""')}"`;
      c.exec(`INSERT INTO main.${table} SELECT * FROM greedy_baseline.${table}`);
    }
    c.exec('COMMIT');
  } catch (error) { c.exec('ROLLBACK'); throw error; }
  finally { c.exec('PRAGMA foreign_keys=ON; DETACH DATABASE greedy_baseline'); }
  assert.equal(c.prepare('PRAGMA main.data_version').get().data_version, before);
}

function spawnHeap(config, variant) {
  return new Promise((done, fail) => {
    const child = fork(__filename, ['--heap', config, variant], {
      execArgv: ['--expose-gc', '--no-warnings'], stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
    });
    let result, error = '';
    child.stderr.on('data', data => { error += data; });
    child.on('message', message => { result = message; });
    child.on('error', fail);
    child.on('exit', code => code === 0 && result ? done(result) : fail(new Error(error.slice(-2000) || `heap worker ${code}`)));
  });
}

async function heapWorker(configPath, variant) {
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const inputs = JSON.parse(fs.readFileSync(config.inputs, 'utf8'));
  const modules = loadCandidates(root, join(config.directory, `heap-${variant}`));
  const module = variant === 'A' ? modules.profileA : modules.B, samples = [];
  for (let pair = -3; pair < 10; pair++) {
    global.gc();
    const before = process.memoryUsage().heapUsed;
    let selectedHeap = 0, winnerCount = 0;
    module.observe = winners => { selectedHeap = process.memoryUsage().heapUsed; winnerCount = winners.size ?? winners.length; };
    let result = module.aggregateMemory(inputs);
    const after = process.memoryUsage().heapUsed;
    assert.equal(digest(result), config.expectedDigest);
    const resultTotals = totals(result);
    global.gc();
    const retained = process.memoryUsage().heapUsed - before;
    if (pair >= 0) samples.push({ before, atSelection: selectedHeap, after,
      sampledExtraHeapBytes: Math.max(selectedHeap, after) - before, retainedResultBytes: retained, winnerCount, totals: resultTotals });
    result = null;
    delete module.observe;
  }
  process.send({ variant, samples, note: 'Separate process; inputs loaded before GC; sample at end of selection and return, not continuous peak or GC pause measurement.' });
}

function checked(db, filter) {
  const { buildUsageQuery } = require(join(root, 'dist/src/summary/db/queries'));
  const result = helpers.verify(db, buildUsageQuery), independent = {};
  for (const group of groups) independent[group] = independentCheck(db, filter, group, allUsage(db, group, filter));
  return { ...result, independent };
}

async function dataset(directory, spec, report) {
  await fsp.mkdir(directory, { recursive: true });
  const snapshot = await helpers.makeSnapshot(directory, { ...spec, after: root });
  await fsp.writeFile(join(directory, 'snapshot.json'), JSON.stringify(snapshot));
  const modules = loadCandidates(root, join(directory, 'modules'));
  const aggregate = require(join(root, 'dist/src/summary/aggregation/memoryAggregate'));
  const { SummaryDatabase } = require(join(root, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(root, 'dist/src/summary/scanner'));
  const entry = { name: spec.name, inventory: snapshot.inventory, inputSha256: snapshot.sha256, expected: snapshot.expected,
    hashes: modules.hashes, initial: {}, samples: [], heap: {} };
  const connections = {}, filter = { fromMs: -8640000000000000, toMs: 8640000000000000, unknownTime: 'include', excludeEmptyUsage: true };
  let inputs;
  try {
    for (const variant of ['A', 'B']) {
      const path = join(directory, `${variant}.sqlite`), db = new SummaryDatabase(path), seed = join(directory, `${variant}-seed.sqlite`);
      connections[variant] = { db, path, seed };
      aggregate.aggregateMemory = (...args) => { if (variant === 'A') inputs = args[0]; return modules[variant].aggregateMemory(...args); };
      const start = performance.now(), refreshed = await refreshSummary(db, { dbPath: path, roots: snapshot.roots });
      const ms = performance.now() - start;
      assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
      const total = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
      if (snapshot.expected) assert.deepEqual([total.requests, total.tokens], [snapshot.expected.requests, snapshot.expected.tokens]);
      entry.initial[variant] = { ms, ...total, failed: refreshed.failed, parsed: refreshed.parsed, bodyBytes: refreshed.bodyBytes,
        checked: checked(db, filter) };
      db.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      await fsp.copyFile(path, seed);
    }
    assert.deepEqual(entry.initial.A.checked, entry.initial.B.checked);
    assert.deepEqual([entry.initial.A.requests, entry.initial.A.tokens, entry.initial.A.failed],
      [entry.initial.B.requests, entry.initial.B.tokens, entry.initial.B.failed]);
    entry.requests = entry.initial.A.requests; entry.tokens = entry.initial.A.tokens;
    entry.dtoCount = inputs.reduce((n, file) => n + file.events.length, 0);
    entry.usageCount = inputs.reduce((n, file) => n + file.events.filter(event => event.kind === 'usage').length, 0);
    const inputBefore = sha(JSON.stringify(inputs)), expected = modules.A.aggregateMemory(inputs);
    assert.deepEqual(modules.B.aggregateMemory(inputs), expected);
    assert.equal(sha(JSON.stringify(inputs)), inputBefore, 'Array slots must not mutate source cache');
    const early = modules.A.aggregateMemory(selectBeforeValidation(inputs));
    const compact = discardValidatedLosers(inputs, modules.B);
    const reused = modules.B.aggregateMemory(compact.files);
    entry.correctness = { fullPreparedArray: true, sourceUnchanged: true, baseline: { ...totals(expected), digest: digest(expected) },
      earlyDiscard: { ...totals(early), digest: digest(early), equal: digest(early) === digest(expected) },
      winnerOnlyCacheUnchangedRefresh: { ...totals(reused), digest: digest(reused), equal: digest(reused) === digest(expected) } };
    const inputPath = join(directory, 'inputs.json'), configPath = join(directory, 'heap-config.json');
    await fsp.writeFile(inputPath, JSON.stringify(inputs));
    await fsp.writeFile(configPath, JSON.stringify({ inputs: inputPath, expectedDigest: digest(expected), directory }));
    for (let pair = -3; pair < 10; pair++) {
      const paired = {};
      for (const variant of (pair + 3) % 2 ? ['B', 'A'] : ['A', 'B']) {
        const { db, path, seed } = connections[variant];
        let kernelStart = performance.now();
        const kernel = modules[variant].aggregateMemory(inputs);
        const kernelMs = performance.now() - kernelStart;
        assert.equal(digest(kernel), digest(expected));
        restoreMain(db, seed);
        const target = helpers.chooseTarget(db, 'codex', directory);
        await helpers.inspectCodexTarget(target, root);
        await helpers.appendRows(target, helpers.codexAppendRows(target, 'benchmark-greedy-request', 'benchmark-greedy-response'), directory, 1);
        aggregate.aggregateMemory = modules[variant].aggregateMemory;
        const start = performance.now();
        let refreshed;
        try { refreshed = await refreshSummary(db, { dbPath: path, roots: snapshot.roots }); }
        catch (error) { throw error; }
        const appendMs = performance.now() - start;
        assert.equal(refreshed.interrupted, false); assert.equal(refreshed.error, undefined);
        assert.equal(refreshed.failed, entry.initial[variant].failed);
        const total = db.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get();
        assert.deepEqual([total.requests, total.tokens], [entry.requests + 1, entry.tokens + 130]);
        const reads = {}, queryDigests = {};
        for (const group of groups) {
          const began = performance.now(), rows = allUsage(db, group, filter);
          reads[group] = performance.now() - began;
          queryDigests[group] = independentCheck(db, filter, group, rows);
        }
        const checks = checked(db, filter);
        paired[variant] = { pair, variant, kernelMs, appendMs, reads, ...total, parsed: refreshed.parsed,
          bodyBytes: refreshed.bodyBytes, factsSha256: checks.factsSha256, aggregatesSha256: checks.aggregatesSha256,
          queryDigests, rawChecks: checks.rawChecks };
        await fsp.truncate(target.path, target.originalBytes);
        await fsp.utimes(target.path, target.originalAtime, target.originalMtime);
        const restored = await refreshSummary(db, { dbPath: path, roots: snapshot.roots });
        assert.equal(restored.interrupted, false); assert.equal(restored.failed, entry.initial[variant].failed);
        if (pair >= 0) entry.samples.push(paired[variant]);
      }
      for (const key of ['requests', 'tokens', 'factsSha256', 'aggregatesSha256', 'queryDigests']) {
        assert.deepEqual(paired.A[key], paired.B[key], `${spec.name}/${pair}/${key}`);
      }
      console.log(`${spec.name} ${pair < 0 ? 'warmup' : 'pair'} ${pair}: append ${paired.A.appendMs.toFixed(2)} -> ${paired.B.appendMs.toFixed(2)} ms; kernel ${paired.A.kernelMs.toFixed(2)} -> ${paired.B.kernelMs.toFixed(2)} ms`);
    }
    for (const variant of ['A', 'B']) entry.heap[variant] = await spawnHeap(configPath, variant);
    for (const file of snapshot.files) assert.equal(sha(fs.readFileSync(file.path)), file.sha256, 'Snapshot content restored');
    entry.inputRestored = true;
    entry.metrics = {};
    for (const metric of ['appendMs', 'kernelMs', ...groups]) {
      const variants = {};
      for (const variant of ['A', 'B']) variants[variant] = stats(entry.samples.filter(s => s.variant === variant)
        .map(sample => sample[metric] ?? sample.reads[metric]));
      entry.metrics[metric] = variants;
    }
    report.datasets.push(entry);
  } finally {
    aggregate.aggregateMemory = modules.A.aggregateMemory;
    for (const { db } of Object.values(connections)) db.close();
  }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).filter(arg => arg.includes('=')).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
  assert.ok(args.output, '--output=<new JSON> is required');
  const output = resolve(args.output); assert.equal(fs.existsSync(output), false, 'Do not overwrite previous measurements');
  const directory = await fsp.mkdtemp(join(root, 'tests/.cache/dto-greedy-ab-'));
  const report = { startedAtSeoul: seoul(), sourceRevision: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).trim(),
    runnerSha256: sha(fs.readFileSync(__filename)), candidateSha256: sha(fs.readFileSync(join(__dirname, 'dto-greedy-candidate.cjs'))),
    sources: Object.fromEntries(['src/summary/scanner/memoryScanner.ts', 'src/summary/aggregation/memoryAggregate.ts',
      'dist/src/summary/scanner/memoryScanner.js', 'dist/src/summary/aggregation/memoryAggregate.js'].map(path => [path, sha(fs.readFileSync(join(root, path)))])),
    environment: { node: process.version, cpu: cpus()[0].model, platform: process.platform, timezone: 'Asia/Seoul' },
    workspace: relative(root, directory).replaceAll('\\', '/'), warmupPairs: 3, measuredPairs: 10,
    scope: 'A=current product; B=prepared validity and source cache preserved, no winner Map, linear array lookup and in-place slot metadata updates. Early discard and DTO overwrite are separate correctness-only failed candidates.',
    conditions: 'Single process AB/BA, same frozen inputs, fixed full period and timezone, warm OS cache, no forced GC during timings. DB/source/cache restored before each append. Append includes refresh and COMMIT; file append itself and preparation excluded. Heap samples in isolated --expose-gc workers, not continuous peak or GC pause metrics.',
    datasets: [] };
  const specs = process.argv.includes('--smoke') ? [{ name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }]
    : [{ name: 'current', real: true }, { name: 'synthetic-10000', requests: 10000, 'turns-per-session': 100 },
      { name: 'synthetic-100', requests: 100, 'turns-per-session': 10 }];
  await fsp.mkdir(dirname(output), { recursive: true });
  for (const spec of specs) {
    console.log(`Preparing ${spec.name}`);
    await dataset(join(directory, spec.name), spec, report);
    await fsp.writeFile(output, JSON.stringify(report, null, 2));
  }
  report.completedAtSeoul = seoul();
  report.counterexamples = [
    { case: 'prefix: copied 102 hides later valid 12, parent 102 remains', A: 114, earlyDiscard: 102 },
    { case: 'later current 12 invalidates same-key legacy 102', A: 12, earlyDiscard: 102 },
    { case: 'discard explicit request one then introduce request two', A: 206, winnerOnlyCache: 102 },
    { case: 'delete winning source 102, defeated source 12 unchanged', A: 12, winnerOnlyCache: 0, overwrite: 102 },
    { case: 'winning source moves session, defeated source remains', A: 114, winnerOnlyCache: 102 },
  ];
  await fsp.writeFile(output, JSON.stringify(report, null, 2));
  console.log(`Saved ${basename(output)}`);
}

if (process.argv[2] === '--heap') heapWorker(process.argv[3], process.argv[4]).catch(error => { console.error(error); process.exitCode = 1; });
else if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
