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
const defaultWarmups = 3, repetitions = 10, intervalMs = 5, sourceWorkers = 4;
const sha = value => createHash('sha256').update(value).digest('hex');
const scenarioNames = ['unchanged', 'append', 'rebuild', 'update-existing', 'same-content-touch'];

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

async function existingResponseUpdate(db, product, sources) {
  const { prepareSource } = require(join(product, 'dist/src/summary/scanner/sourcePreparation'));
  const completed = db.connection.prepare(`SELECT root_turn_id FROM turn_summary
    WHERE provider='codex' AND session_id=? AND status='completed'`);
  for (const source of sources) {
    const roots = new Set(completed.all(source.session_id).map(row => row.root_turn_id));
    const prepared = await prepareSource(source, { collectCapabilities: true, cancelled: () => false });
    assert.ok(prepared.ok);
    const newest = [...prepared.winners.winners.values()].reduce((latest, candidate) => {
      const { event, index } = candidate;
      return event.schema === 'current' && event.model && roots.has(event.rootId) && (!latest || index > latest.index) ? candidate : latest;
    }, undefined);
    if (!newest) continue;
    const { event } = newest;
    const { rootId, threadId, turnId, responseId, model, billingMode, tokens } = event;
    const payload = { root_turn_id: rootId, thread_id: threadId, turn_id: turnId, response_id: responseId,
      model, billing_mode: billingMode, usage: { input_tokens: tokens.input + 123, output_tokens: tokens.output + 7,
        cached_input_tokens: tokens.cacheRead, cache_write_input_tokens: tokens.cacheWrite,
        reasoning_output_tokens: tokens.reasoning } };
    const check = prepared.winners.roots.get(rootId)?.checks.get(JSON.stringify([threadId, turnId]));
    if (check) payload.turn_token_usage = { input_tokens: check.input + 123, output_tokens: check.output + 7 };
    return { source, change: JSON.stringify({ type: 'token_usage_record', payload }) + '\n' };
  }
  throw new Error('Existing-update benchmark requires a completed current-format Codex response');
}

async function worker(configPath, variant) {
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  const product = config[variant];
  const { SummaryDatabase } = require(join(product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(product, 'dist/src/summary/scanner'));
  const dbPath = join(config.directory, `mtime-${variant}.sqlite`);
  const db = new SummaryDatabase(dbPath);
  const options = { dbPath, roots: config.snapshot.roots, sourceWorkers };
  async function refresh(database = db, refreshOptions = options) {
    global.gc();
    const before = memory(), peak = { ...before };
    const sample = () => {
      const current = memory();
      for (const key of Object.keys(peak)) peak[key] = Math.max(peak[key], current[key]);
    };
    const timer = setInterval(sample, intervalMs), start = performance.now();
    let result;
    try { result = await refreshSummary(database, refreshOptions, undefined, sample); }
    finally { clearInterval(timer); }
    const ms = performance.now() - start;
    sample();
    global.gc();
    const retained = memory();
    assert.equal(result.interrupted, false);
    assert.equal(result.failed, 0);
    return { ms, scan: result.timings.scan, storage: result.timings.storage, parsed: result.parsed,
      reused: result.reused, bodyBytes: result.bodyBytes, before, peak, retained, checkpointEntries: database.sourceCheckpoints?.size ?? 0 };
  }
  const total = (database = db) => database.connection.prepare('SELECT count(*) AS requests,coalesce(sum(total_tokens),0) AS tokens FROM turn_summary').get();
  const initial = await refresh();
  const base = total();
  if (config.snapshot.expected) {
    assert.equal(base.requests, config.snapshot.expected.requests);
    assert.equal(base.tokens, config.snapshot.expected.tokens);
  }
  const plainSources = `SELECT * FROM source_file WHERE provider='codex' AND processing_status='done'
    AND path NOT LIKE '%.zst' AND EXISTS(SELECT 1 FROM turn_summary t
      WHERE t.provider=source_file.provider AND t.session_id=source_file.session_id)`;
  const sourceOrder = 'ORDER BY size_bytes DESC,path';
  const hasSourceIdentity = db.connection.prepare("SELECT 1 FROM pragma_table_info('source_file') WHERE name='source_identity'").get();
  const targets = hasSourceIdentity
    ? db.connection.prepare(`${plainSources} AND json_extract(source_identity,'$[1]')=1
      AND json_extract(source_identity,'$[0]')=session_id ${sourceOrder}`).all()
    : db.connection.prepare(`${plainSources} ${sourceOrder}`).all().filter(file => {
      const identity = db.sourceRelations(file.id)?.identity;
      return identity?.isMain && identity.threadId === file.session_id;
    });
  const existing = config.scenarios?.includes('update-existing') ? await existingResponseUpdate(db, product, targets) : undefined;
  const target = existing?.source ?? targets[0];
  assert.ok(target, 'A plain Codex main source is required');
  const stat = await fs.stat(target.path);
  target.originalBytes = stat.size;
  await inspectCodexTarget(target, product);
  const extra = codexAppendRows(target, 'mtime-bench-request', 'mtime-bench-response').map(row => JSON.stringify(row)).join('\n') + '\n';
  const committedMtime = db.connection.prepare('SELECT mtime_ms FROM source_file WHERE id = ?');
  async function stampMtime(force = false) {
    if (!force && !config.stampAppendMtime) return;
    const previous = committedMtime.get(target.id).mtime_ms;
    await fs.utimes(target.path, stat.atime, new Date(Math.max(Date.now(), Math.ceil(previous) + 2)));
  }
  for (const group of groups) allUsage(db, group, filter);
  const baseFacts = facts(db);
  process.send({ initial, base, targetBytes: stat.size, addedBytes: Buffer.byteLength(extra), targetSha256: sha(target.path),
    ...(existing ? { changedBytes: Buffer.byteLength(existing.change), changeSha256: sha(existing.change) } : {}), facts: baseFacts });

  for await (const [scenario] of require('node:events').on(process, 'message')) {
    if (scenario === 'close') {
      db.close();
      process.disconnect();
      break;
    }
    const updateExisting = scenario === 'update-existing', touch = scenario === 'same-content-touch';
    const append = scenario === 'append', modifiesBody = append || updateExisting;
    try {
      if (scenario === 'rebuild') {
        const freshPath = join(config.directory, `rebuild-${variant}.sqlite`);
        const fresh = new SummaryDatabase(freshPath);
        let value;
        try {
          const sample = await refresh(fresh, { ...options, dbPath: freshPath });
          value = { ...sample, totals: total(fresh), facts: facts(fresh) };
        } finally {
          fresh.close();
          await fs.unlink(freshPath);
        }
        assert.deepEqual(value.totals, base);
        process.send(value);
        continue;
      }
      if (modifiesBody) await fs.appendFile(target.path, updateExisting ? existing.change : extra);
      if (modifiesBody || touch) await stampMtime(updateExisting || touch);
      const sample = await refresh();
      if (scenario === 'unchanged' && variant === 'B') assert.equal(sample.bodyBytes, 0);
      if (modifiesBody && variant === 'B') assert.ok(sample.bodyBytes >= stat.size + Buffer.byteLength(updateExisting ? existing.change : extra));
      if (touch) assert.ok(sample.bodyBytes >= stat.size);
      const totals = total();
      assert.equal(totals.requests, base.requests + Number(append));
      assert.equal(totals.tokens, base.tokens + (modifiesBody ? 130 : 0));
      const queries = {};
      for (const group of groups) {
        const queryStart = performance.now();
        const rows = allUsage(db, group, filter);
        const ms = performance.now() - queryStart;
        queries[group] = { ms, ...independentCheck(db, filter, group, rows) };
      }
      assert.deepEqual(db.connection.prepare('PRAGMA foreign_key_check').all(), []);
      const value = { ...sample, totals, facts: facts(db), queries };
      if (touch) assert.equal(value.facts, baseFacts);
      if (modifiesBody) {
        await fs.truncate(target.path, stat.size);
        await stampMtime(updateExisting);
        const restored = await refreshSummary(db, options);
        assert.equal(restored.failed, 0);
        assert.equal(restored.interrupted, false);
        assert.deepEqual(total(), base);
      }
      if (modifiesBody || touch) await fs.utimes(target.path, stat.atime, stat.mtime);
      process.send(value);
    } catch (error) {
      if (modifiesBody) await fs.truncate(target.path, stat.size);
      if (modifiesBody || touch) await fs.utimes(target.path, stat.atime, stat.mtime);
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
  const measuredPairs = Number(args.repetitions ?? repetitions);
  const warmups = Number(args.warmups ?? defaultWarmups);
  assert.ok(Number.isSafeInteger(measuredPairs) && measuredPairs > 0);
  assert.ok(Number.isSafeInteger(warmups) && warmups >= 0);
  const selectedDatasets = args.datasets?.split(',');
  const stampAppendMtime = args['stamp-append-mtime'] === 'true';
  const scenarios = args.scenarios?.split(',') ?? (args.rebuild === 'true' ? ['unchanged', 'append', 'rebuild'] : ['unchanged', 'append']);
  assert.ok(scenarios.every(scenario => scenarioNames.includes(scenario)));
  if (!args.workspace) await fs.mkdir(join(root, 'tests/.cache'), { recursive: true });
  const workspace = args.workspace ? resolve(args.workspace) : await fs.mkdtemp(join(root, 'tests/.cache/mtime-refresh-'));
  const setup = args.workspace ? JSON.parse(await fs.readFile(join(workspace, 'setup.json'), 'utf8')) : { configs: [] };
  if (!args.workspace) {
    for (const [name, requests, turns] of datasets) {
      if (selectedDatasets && !selectedDatasets.includes(name)) continue;
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
    protocol: { warmups, repetitions: measuredPairs, scenarios, sourceWorkers, intervalMs, order: 'AB/BA', timezone: 'Asia/Seoul',
      filter, ...(stampAppendMtime ? { stampAppendMtime } : {}) },
  builds: {}, datasets: [] };
  for (const [key, product] of Object.entries({ A, B }))
    report.builds[key] = { source: await fingerprint(join(product, 'src')), build: await fingerprint(join(product, 'dist/src')) };
  for (const path of setup.configs) {
    const config = JSON.parse(await fs.readFile(path, 'utf8'));
    if (selectedDatasets && !selectedDatasets.includes(config.name)) continue;
    const runPath = join(await fs.mkdtemp(join(workspace, `${config.name}-run-`)), 'config.private.json');
    config.directory = resolve(runPath, '..');
    await fs.writeFile(runPath, JSON.stringify({ ...config, A, B, stampAppendMtime, scenarios }));
    const dataset = { name: config.name, inputSha256: config.snapshot.sha256, expected: config.snapshot.expected,
      inventory: config.snapshot.inventory, initial: {}, samples: [] };
    const workers = {};
    try {
      for (const variant of ['A', 'B']) {
        workers[variant] = launch(runPath, variant);
        dataset.initial[variant] = await workers[variant].ready;
      }
      for (const key of ['base', 'targetBytes', 'addedBytes', 'targetSha256', 'changedBytes', 'changeSha256', 'facts'])
        assert.deepEqual(dataset.initial.A[key], dataset.initial.B[key]);
      console.log(JSON.stringify({ dataset: config.name, initial: dataset.initial.A.base, targetBytes: dataset.initial.A.targetBytes }));
      for (const scenario of scenarios) {
        for (let iteration = -warmups; iteration < measuredPairs; iteration++) {
          const pair = { scenario, iteration };
          for (const variant of iteration % 2 === 0 ? ['A', 'B'] : ['B', 'A'])
            pair[variant] = await workers[variant].measure(scenario);
          assert.deepEqual(pair.A.totals, pair.B.totals);
          assert.equal(pair.A.facts, pair.B.facts);
          if (scenario === 'rebuild') assert.equal(pair.A.facts, dataset.initial.A.facts);
          else for (const group of groups) assert.equal(pair.A.queries[group].sha256, pair.B.queries[group].sha256);
          dataset.samples.push(pair);
        }
        console.log(JSON.stringify({ dataset: config.name, scenario, pairs: warmups + measuredPairs }));
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
