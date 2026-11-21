// 고정 JSONL 사본에서 전수 prefix 검사와 수정 시각 갱신의 시간·힙·집계 결과를 비교한다.
'use strict';
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const { cpus } = require('node:os');
const { join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { makeSnapshot, inspectCodexTarget, codexAppendRows, normalized } = require('./incremental-refresh.cjs');
const { allUsage, independentCheck } = require('./temp-batch-ab.cjs');

const root = resolve(__dirname, '../..');
const datasets = [['current', 0, 100], ['synthetic-10000', 10000, 100], ['synthetic-100', 100, 10]];
const filter = { fromMs: Date.UTC(2020, 0, 1), toMs: Date.UTC(2035, 0, 1), unknownTime: 'include', excludeEmptyUsage: false };
const groups = ['day', 'month', 'session', 'project'];
const warmups = 3, repetitions = 10, intervalMs = 5, sourceWorkers = 4;
const sha = value => createHash('sha256').update(value).digest('hex');

async function fingerprint(directory) {
  const entries = await fs.readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name));
  const hashes = [];
  for (const file of files.sort()) hashes.push([file.slice(directory.length + 1).replaceAll('\\', '/'), sha(await fs.readFile(file))]);
  return sha(JSON.stringify(hashes));
}

function facts(db) {
  const hash = createHash('sha256');
  for (const table of ['turn_summary', 'turn_model_usage', 'turn_capability_usage', 'turn_costs']) {
    const related = table === 'turn_summary' ? '' : ' JOIN turn_summary t ON t.id=r.turn_id';
    const alias = related ? 't' : 'r';
    const columns = table === 'turn_model_usage' ? ', r.model'
      : table === 'turn_capability_usage' ? ', r.category, r.name' : '';
    for (const row of db.connection.prepare(`SELECT ${alias}.provider,${alias}.session_id,${alias}.root_turn_id,r.*
      FROM ${table} r${related} ORDER BY 1,2,3${columns}`).iterate()) hash.update(JSON.stringify(normalized(row)));
  }
  return hash.digest('hex');
}

function memory() {
  const { heapUsed, rss } = process.memoryUsage();
  return { heapUsed, rss };
}

async function worker(configPath, variant) {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const product = config[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const dbPath = join(config.directory, `mtime-${variant}.sqlite`);
  const db = new SummaryDatabase(dbPath);
  const options = { dbPath, roots: config.snapshot.roots, sourceWorkers };
  async function refresh() {
    global.gc();
    const before = memory(), peak = { ...before };
    const sample = () => {
      const current = memory();
      for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], current[key]);
    };
    const timer = setInterval(sample, intervalMs), start = performance.now();
    let result;
    try { result = await refreshSummary(db, options, undefined, sample); }
    finally { clearInterval(timer); }
    const ms = performance.now() - start;
    sample();
    global.gc();
    const retained = memory();
    assert.equal(result.interrupted, false);
    assert.equal(result.failed, 0);
    return { ms, scan: result.timings.scan, storage: result.timings.storage, parsed: result.parsed,
      reused: result.reused, bodyBytes: result.bodyBytes, before, peak, retained, checkpointEntries: db.sourceCheckpoints?.size ?? 0 };
  }
  const total = () => db.connection.prepare('SELECT count(*) AS requests,coalesce(sum(total_tokens),0) AS tokens FROM turn_summary').get();
  const initial = await refresh();
  const base = total();
  if (config.snapshot.expected) {
    assert.equal(base.requests, config.snapshot.expected.requests);
    assert.equal(base.tokens, config.snapshot.expected.tokens);
  }
  const target = db.connection.prepare(`SELECT path FROM source_file WHERE provider='codex' AND processing_status='done'
    AND path NOT LIKE '%.zst' AND json_extract(source_identity,'$[1]')=1
    AND json_extract(source_identity,'$[0]')=session_id AND EXISTS(SELECT 1 FROM turn_summary t
      WHERE t.provider=source_file.provider AND t.session_id=source_file.session_id) ORDER BY size_bytes DESC,path LIMIT 1`).get();
  assert.ok(target, 'A plain Codex main source is required');
  const stat = await fs.stat(target.path);
  target.originalBytes = stat.size;
  await inspectCodexTarget(target, product);
  const extra = codexAppendRows(target, 'mtime-bench-request', 'mtime-bench-response').map(row => JSON.stringify(row)).join('\n') + '\n';
  for (const group of groups) allUsage(db, group, filter);
  process.send({ initial, base, targetBytes: stat.size, addedBytes: Buffer.byteLength(extra), facts: facts(db) });

  for await (const [scenario] of require('node:events').on(process, 'message')) {
    if (scenario === 'close') {
      db.close();
      process.disconnect();
      break;
    }
    try {
      if (scenario === 'append') await fs.appendFile(target.path, extra);
      const sample = await refresh();
      if (scenario === 'unchanged' && variant === 'B') assert.equal(sample.bodyBytes, 0);
      if (scenario === 'append' && variant === 'B') assert.ok(sample.bodyBytes >= stat.size + Buffer.byteLength(extra));
      const totals = total();
      assert.equal(totals.requests, base.requests + Number(scenario === 'append'));
      assert.equal(totals.tokens, base.tokens + (scenario === 'append' ? 130 : 0));
      const queries = {};
      for (const group of groups) {
        const queryStart = performance.now();
        const rows = allUsage(db, group, filter);
        const ms = performance.now() - queryStart;
        queries[group] = { ms, ...independentCheck(db, filter, group, rows) };
      }
      assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
      const value = { ...sample, totals, facts: facts(db), queries };
      if (scenario === 'append') {
        await fs.truncate(target.path, stat.size);
        const restored = await refreshSummary(db, options);
        assert.equal(restored.failed, 0);
        assert.equal(restored.interrupted, false);
        assert.deepEqual(total(), base);
      }
      if (scenario === 'append') await fs.utimes(target.path, stat.atime, stat.mtime);
      process.send(value);
    } catch (error) {
      if (scenario === 'append') {
        await fs.truncate(target.path, stat.size);
        await fs.utimes(target.path, stat.atime, stat.mtime);
      }
      throw error;
    }
  }
}

function launch(path, variant) {
  const child = fork(__filename, ['--child', path, variant], {
    execArgv: ['--expose-gc', '--no-warnings'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true,
  });
  let exitError;
  const reply = () => new Promise((done, reject) => {
    if (exitError) { reject(exitError); return; }
    child.once('message', message => { child.off('error', reject); done(message); });
    child.once('error', reject);
  });
  child.on('exit', code => {
    if (code !== 0) {
      exitError = new Error(`${variant} exited ${code}`);
      if (child.listenerCount('error')) child.emit('error', exitError);
    }
  });
  return { ready: reply(), measure(scenario) { const result = reply(); child.send(scenario); return result; },
    close() { if (child.connected) child.send('close'); } };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.slice(2).split(/=(.*)/).slice(0, 2)));
  const A = resolve(args.before), B = resolve(args.after ?? root), output = resolve(args.output);
  if (!args.workspace) await fs.mkdir(join(root, 'tests/.cache'), { recursive: true });
  const workspace = args.workspace ? resolve(args.workspace) : await fs.mkdtemp(join(root, 'tests/.cache/mtime-refresh-'));
  const setup = args.workspace ? JSON.parse(await fs.readFile(join(workspace, 'setup.json'), 'utf8')) : { configs: [] };
  if (!args.workspace) {
    for (const [name, requests, turns] of datasets) {
      const directory = join(workspace, name);
      await fs.mkdir(directory);
      const snapshot = await makeSnapshot(directory, { after: B, real: !requests, requests, 'turns-per-session': turns });
      const path = join(directory, 'config.private.json');
      await fs.writeFile(path, JSON.stringify({ name, directory, snapshot }));
      setup.configs.push(path);
    }
    await fs.writeFile(join(workspace, 'setup.json'), JSON.stringify(setup));
  }
  console.log(JSON.stringify({ workspace }));
  const report = { environment: { node: process.version, v8: process.versions.v8, sqlite: process.versions.sqlite,
    cpu: cpus()[0].model, platform: process.platform, arch: process.arch },
  protocol: { warmups, repetitions, sourceWorkers, intervalMs, order: 'AB/BA', timezone: 'Asia/Seoul', filter },
  builds: {}, datasets: [] };
  for (const [key, product] of Object.entries({ A, B }))
    report.builds[key] = { source: await fingerprint(join(product, 'src')), build: await fingerprint(join(product, 'dist/src')) };
  for (const path of setup.configs) {
    const config = JSON.parse(await fs.readFile(path, 'utf8'));
    if (args.datasets && !args.datasets.split(',').includes(config.name)) continue;
    const runPath = join(await fs.mkdtemp(join(workspace, `${config.name}-run-`)), 'config.private.json');
    config.directory = resolve(runPath, '..');
    await fs.writeFile(runPath, JSON.stringify({ ...config, A, B }));
    const dataset = { name: config.name, inputSha256: config.snapshot.sha256, expected: config.snapshot.expected,
      inventory: config.snapshot.inventory, initial: {}, samples: [] };
    const workers = {};
    try {
      for (const variant of ['A', 'B']) {
        workers[variant] = launch(runPath, variant);
        dataset.initial[variant] = await workers[variant].ready;
      }
      for (const key of ['base', 'targetBytes', 'addedBytes', 'facts']) assert.deepEqual(dataset.initial.A[key], dataset.initial.B[key]);
      console.log(JSON.stringify({ dataset: config.name, initial: dataset.initial.A.base, targetBytes: dataset.initial.A.targetBytes }));
      for (const scenario of ['unchanged', 'append']) {
        for (let iteration = -warmups; iteration < repetitions; iteration++) {
          const pair = { scenario, iteration };
          for (const variant of iteration % 2 === 0 ? ['A', 'B'] : ['B', 'A'])
            pair[variant] = await workers[variant].measure(scenario);
          assert.deepEqual(pair.A.totals, pair.B.totals);
          assert.equal(pair.A.facts, pair.B.facts);
          for (const group of groups) assert.equal(pair.A.queries[group].sha256, pair.B.queries[group].sha256);
          dataset.samples.push(pair);
        }
        console.log(JSON.stringify({ dataset: config.name, scenario, pairs: warmups + repetitions }));
      }
    } finally {
      for (const worker of Object.values(workers)) worker.close();
    }
    for (const file of config.snapshot.files) assert.equal(sha(await fs.readFile(file.path)), file.sha256);
    report.datasets.push(dataset);
    await fs.mkdir(resolve(output, '..'), { recursive: true });
    await fs.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify({ complete: true, output }));
}

const task = process.argv[2] === '--child' ? worker(process.argv[3], process.argv[4]) : main();
task.catch(error => {
  console.error(error);
  process.exitCode = 1;
  if (process.connected) process.disconnect();
});
