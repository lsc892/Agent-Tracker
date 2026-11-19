// 같은 고정 입력과 제품 저장 경로에서 해시·블록 검증·파서 체크포인트 후보를 교대 계측한다.
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { join, resolve, dirname } = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { cpus, totalmem } = require('node:os');
const { performance } = require('node:perf_hooks');
const { zstdCompressSync } = require('node:zlib');
const { DatabaseSync } = require('node:sqlite');
const helpers = require('../incremental-refresh.cjs');
const { allUsage, independentCheck } = require('../temp-batch-ab.cjs');
const { loadHashers, validateHashers } = require('./hashers.cjs');
const { createEngine, variants: candidates } = require('./preparation.cjs');

const root = resolve(__dirname, '../../..');
const timezone = 'Asia/Seoul';
const dateSeoul = '2026-11-16';
const variants = ['full-sha256', ...candidates];
const groups = ['day', 'month', 'session', 'project'];
const filter = { fromMs: Date.UTC(2020, 0, 1), toMs: Date.UTC(2035, 0, 1),
  unknownTime: 'include', excludeEmptyUsage: false };
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (_key, item) =>
  typeof item === 'number' && !Number.isInteger(item) ? Number(item.toPrecision(10)) : item);
const digest = value => sha(canonical(value));
const jsonl = rows => Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n');

function stats(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return { median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted.at(-1) };
}

function treeFingerprint(directory) {
  const files = fs.readdirSync(directory, { recursive: true }).filter(name => fs.statSync(join(directory, name)).isFile()).sort();
  return { files: files.length, sha256: digest(files.map(name => [name.replaceAll('\\', '/'), sha(fs.readFileSync(join(directory, name)))])) };
}

async function prepareWorkspace() {
  await fsp.mkdir(join(root, 'tests/.cache'), { recursive: true });
  const workspace = await fsp.mkdtemp(join(root, 'tests/.cache/jsonl-algorithms-'));
  const product = join(workspace, 'product');
  await fsp.mkdir(product);
  for (const folder of ['src', 'localization']) await fsp.cp(join(root, folder), join(product, folder), { recursive: true });
  await fsp.symlink(join(root, 'node_modules'), join(product, 'node_modules'), 'junction');
  const tsconfig = JSON.parse(fs.readFileSync(join(root, 'tsconfig.json'), 'utf8'));
  tsconfig.include = ['src/**/*.ts'];
  await fsp.writeFile(join(product, 'tsconfig.json'), JSON.stringify(tsconfig, null, 2));
  execFileSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(product, 'tsconfig.json')],
    { cwd: root, windowsHide: true, stdio: 'pipe' });
  const localizationVendor = dirname(require.resolve('i18next/package.json'));
  await fsp.copyFile(join(localizationVendor, 'dist/cjs/i18next.js'), join(product, 'dist/src/localization/i18next.cjs'));
  const datasets = [];
  for (const [name, requests, turns] of [['current', 0, 100], ['synthetic-10000', 10000, 100], ['synthetic-100', 100, 10]]) {
    const directory = join(workspace, name);
    await fsp.mkdir(directory);
    const snapshot = await helpers.makeSnapshot(directory, { after: product, real: requests === 0,
      requests, 'turns-per-session': turns });
    const config = { name, directory, product, workspace, snapshot, filter, timezone };
    const configPath = join(directory, 'config.private.json');
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2));
    datasets.push({ name, configPath });
    console.log(JSON.stringify({ stage: 'snapshot', dataset: name, inventory: snapshot.inventory }));
  }
  const setup = { workspace, product, datasets, source: treeFingerprint(join(product, 'src')),
    build: treeFingerprint(join(product, 'dist/src')), node: process.version };
  await fsp.writeFile(join(workspace, 'setup.private.json'), JSON.stringify(setup, null, 2));
  return setup;
}

function facts(database) {
  const hash = createHash('sha256');
  const queries = [
    'SELECT * FROM turn_summary ORDER BY provider,session_id,root_turn_id',
    'SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_model_usage u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,u.model',
    'SELECT t.provider,t.session_id,t.root_turn_id,u.* FROM turn_summary t JOIN turn_capability_usage u ON u.turn_id=t.id ORDER BY t.provider,t.session_id,t.root_turn_id,u.category,u.name',
  ];
  for (const sql of queries) for (const row of database.connection.prepare(sql).iterate()) hash.update(canonical(helpers.normalized(row)));
  return { ...database.connection.prepare('SELECT count(*) requests,coalesce(sum(total_tokens),0) tokens FROM turn_summary').get(),
    sha256: hash.digest('hex') };
}

async function seedDataset(config) {
  const { SummaryDatabase } = require(join(config.product, 'dist/src/summary/db'));
  const { refreshSummary } = require(join(config.product, 'dist/src/summary/scanner'));
  const path = join(config.directory, 'seed.sqlite');
  for (const suffix of ['', '-wal', '-shm']) await fsp.rm(path + suffix, { force: true });
  const database = new SummaryDatabase(path);
  try {
    const refreshed = await refreshSummary(database, { dbPath: path, roots: config.snapshot.roots,
      timezone, sourceWorkers: 1 });
    assert.equal(refreshed.failed, 0);
    assert.equal(refreshed.interrupted, false);
    for (const group of groups) allUsage(database, group, filter);
    const baseline = facts(database);
    if (config.snapshot.expected) {
      assert.equal(baseline.requests, config.snapshot.expected.requests);
      assert.equal(baseline.tokens, config.snapshot.expected.tokens);
    }
    const targets = {};
    for (const [label, provider, compressed] of [['codex', 'codex', false], ['claude', 'claude', false], ['zstd', 'codex', true]]) {
      const target = database.connection.prepare(`SELECT m.path,m.session_id,m.size_bytes,
        (SELECT count(*) FROM turn_summary t WHERE t.provider=m.provider AND t.session_id=m.session_id) requests
        FROM manifest m WHERE m.provider=? AND m.processing_status='done' AND m.source_missing=0
        AND json_extract(m.source_identity,'$[1]')=1
        AND json_extract(m.source_identity,'$[0]')=m.session_id
        AND m.path ${compressed ? '' : 'NOT'} LIKE '%.zst'
        AND EXISTS(SELECT 1 FROM turn_summary t WHERE t.provider=m.provider AND t.session_id=m.session_id)
        ORDER BY m.size_bytes DESC,m.path LIMIT 1`).get(provider);
      if (!target) continue;
      const stat = await fsp.stat(target.path);
      Object.assign(target, { provider, originalBytes: stat.size, originalAtime: stat.atimeMs, originalMtime: stat.mtimeMs });
      if (provider === 'codex') await helpers.inspectCodexTarget(target, config.product);
      else target.project = database.connection.prepare('SELECT project_key FROM turn_summary WHERE provider=? AND session_id=? LIMIT 1')
        .get(provider, target.session_id).project_key;
      targets[label] = target;
    }
    database.connection.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { seed: path, baseline, targets };
  } finally { database.close(); }
}

async function collectGarbage() {
  await new Promise(setImmediate);
  global.gc({ type: 'major', execution: 'sync' });
  await new Promise(setImmediate);
}

async function childMain(configPath, variant) {
  const config = JSON.parse(await fsp.readFile(configPath, 'utf8'));
  const hashers = await loadHashers();
  const preparation = require(join(config.product, 'dist/src/summary/scanner/sourcePreparation'));
  const original = preparation.prepareSource;
  const { SummaryDatabase } = require(join(config.product, 'dist/src/summary/db'));
  let peak;
  const observe = () => {
    if (!peak) return;
    const usage = process.memoryUsage();
    for (const field of ['rss', 'heapUsed', 'external', 'arrayBuffers']) peak[field] = Math.max(peak[field], usage[field]);
  };
  const engine = variant === 'full-sha256' ? undefined : await createEngine({ product: config.product, variant, hashers, observe });
  let originalMetrics;
  preparation.prepareSource = engine ? engine.prepare : async (file, options) => {
    const result = await original(file, { ...options, onBytes: count => {
      options.onBytes?.(count);
      observe();
    } });
    originalMetrics.fileReads++;
    originalMetrics.bytesRead += result.bytes;
    originalMetrics.parsedRows += result.ok ? result.read.rows : 0;
    originalMetrics.fullSources++;
    observe();
    return result;
  };
  const { refreshSummary } = require(join(config.product, 'dist/src/summary/scanner'));
  const directory = join(config.directory, variant);
  await fsp.mkdir(directory, { recursive: true });
  const dbPath = join(directory, 'working.sqlite');
  for (const suffix of ['', '-wal', '-shm']) await fsp.rm(dbPath + suffix, { force: true });
  engine?.setPriming(true);
  originalMetrics = { fileReads: 0, bytesRead: 0, parsedRows: 0, fullSources: 0 };
  const initialDatabase = new SummaryDatabase(dbPath);
  const initStart = performance.now();
  const initial = await refreshSummary(initialDatabase, { dbPath, roots: config.snapshot.roots, timezone, sourceWorkers: 1 });
  const initializationMs = performance.now() - initStart;
  assert.equal(initial.failed, 0);
  assert.equal(initial.interrupted, false);
  initialDatabase.close();
  engine?.setPriming(false);
  const cache = engine?.cacheStats() ?? { files: 0, serializedBytes: 0, indexSerializedBytes: 0 };
  await collectGarbage();
  process.send({ kind: 'ready', variant, initializationMs, cache, retainedMemory: process.memoryUsage() });

  async function measure(command) {
    for (const suffix of ['-wal', '-shm']) await fsp.rm(dbPath + suffix, { force: true });
    await fsp.copyFile(config.seed, dbPath);
    const database = new SummaryDatabase(dbPath);
    try {
      if (command.scenario === 'unchanged-reparse') database.connection.exec('UPDATE manifest SET parser_version=0');
      engine?.resetMetrics();
      originalMetrics = { fileReads: 0, bytesRead: 0, parsedRows: 0, fullSources: 0 };
      await collectGarbage();
      const before = process.memoryUsage();
      peak = { rss: before.rss, heapUsed: before.heapUsed, external: before.external, arrayBuffers: before.arrayBuffers };
      const timer = setInterval(observe, 10);
      const started = performance.now();
      let refreshed;
      try {
        refreshed = await refreshSummary(database, { dbPath, roots: config.snapshot.roots, timezone, sourceWorkers: 1 },
          undefined, observe);
      } finally { clearInterval(timer); }
      const elapsedMs = performance.now() - started;
      observe();
      const observedPeak = peak;
      peak = undefined;
      assert.equal(refreshed.failed, 0, `${variant} refresh failed`);
      assert.equal(refreshed.interrupted, false);
      if (command.scenario === 'unchanged') assert.equal(refreshed.bodyBytes, 0, 'Unchanged input read source bodies');
      const metrics = engine?.metrics() ?? originalMetrics;
      const queries = {};
      for (const group of groups) {
        const start = performance.now();
        const rows = allUsage(database, group, filter);
        const elapsed = performance.now() - start;
        const checked = independentCheck(database, filter, group, rows);
        queries[group] = { elapsedMs: elapsed, groups: rows.length, sha256: checked.sha256 };
      }
      const currentFacts = facts(database);
      await collectGarbage();
      return { scenario: command.scenario, iteration: command.iteration, measured: command.measured, variant,
        elapsedMs, bodyBytes: refreshed.bodyBytes, parsedFiles: refreshed.parsed, metrics,
        scan: refreshed.timings.scan, storage: refreshed.timings.storage, facts: currentFacts, queries,
        memoryBefore: before, observedPeak, afterGc: process.memoryUsage() };
    } finally { database.close(); }
  }

  process.on('message', command => {
    if (command.kind === 'exit') process.exit(0);
    void measure(command).then(result => process.send({ kind: 'sample', id: command.id, result }))
      .catch(error => process.send({ kind: 'error', id: command.id, error: error.stack }));
  });
}

function launchChild(configPath, variant) {
  const child = fork(__filename, ['--child', configPath, variant], { cwd: root, execArgv: ['--expose-gc', '--no-warnings'],
    windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  const pending = new Map();
  let serial = 0;
  let errorText = '';
  let readyResolve;
  let readyReject;
  const ready = new Promise((done, fail) => { readyResolve = done; readyReject = fail; });
  child.stderr.on('data', bytes => { errorText = (errorText + bytes).slice(-5000); });
  child.on('message', message => {
    if (message.kind === 'ready') readyResolve(message);
    else if (pending.has(message.id)) {
      const request = pending.get(message.id);
      pending.delete(message.id);
      if (message.kind === 'error') request.fail(new Error(message.error));
      else request.done(message.result);
    }
  });
  child.on('error', error => { readyReject(error); for (const request of pending.values()) request.fail(error); });
  child.on('exit', code => {
    if (code) {
      const error = new Error(`${variant} child exited ${code}: ${errorText}`);
      readyReject(error);
      for (const request of pending.values()) request.fail(error);
    }
  });
  return { ready, async measure(command) {
    const id = ++serial;
    return new Promise((done, fail) => { pending.set(id, { done, fail }); child.send({ ...command, id }); });
  }, close() { if (child.connected) child.send({ kind: 'exit' }); } };
}

function makeAddition(target) {
  if (target.provider === 'codex') return jsonl(helpers.codexAppendRows(structuredClone(target),
    'algorithm-added-request', 'algorithm-added-response'));
  const rows = helpers.claudeRows(target.session_id);
  rows[0].cwd = target.project;
  return jsonl(rows);
}

async function existingResponseUpdate(config, target) {
  assert.equal(target.format, 'current', 'Existing-response update requires current-format usage records');
  const database = new DatabaseSync(config.seed, { readOnly: true });
  try {
    const metadata = database.prepare('SELECT * FROM manifest WHERE provider=? AND path=?')
      .get(target.provider, target.path);
    const acceptedRoots = new Set(database.prepare('SELECT root_turn_id FROM turn_summary WHERE provider=? AND session_id=?')
      .all(target.provider, target.session_id).map(row => row.root_turn_id));
    const { prepareSource } = require(join(config.product, 'dist/src/summary/scanner/sourcePreparation'));
    const prepared = await prepareSource(metadata, { collectCapabilities: true, cancelled: () => false });
    assert.equal(prepared.ok, true, 'The existing source could not be prepared');
    const candidates = [...prepared.winners.winners.values()].filter(candidate =>
      candidate.event.schema === 'current' && acceptedRoots.has(candidate.event.rootId));
    const selected = candidates.sort((left, right) => right.index - left.index)[0];
    assert.ok(selected, 'No accepted existing response was available');
    const event = selected.event;
    const tokens = event.tokens;
    const rawTokens = value => ({ input_tokens: value.input, output_tokens: value.output,
      cached_input_tokens: value.cacheRead, cache_write_input_tokens: value.cacheWrite,
      reasoning_output_tokens: value.reasoning });
    const payload = { session_id: target.session_id, thread_id: event.threadId,
      root_turn_id: event.rootId, turn_id: event.turnId, response_id: event.responseId,
      model: event.model, billing_mode: event.billingMode,
      usage: rawTokens({ ...tokens, input: tokens.input + 123, output: tokens.output + 7 }) };
    const check = [...prepared.winners.roots.values()].flatMap(state => [...state.checks.values()])
      .find(value => value.event.threadId === event.threadId && value.event.turnId === event.turnId)?.event;
    if (check) payload.turn_token_usage = rawTokens({ ...check.tokens,
      input: check.tokens.input + 123, output: check.tokens.output + 7 });
    return { suffix: jsonl([{ type: 'token_usage_record', timestamp: '2026-10-28T12:00:03Z', payload }]),
      responseBefore: { input: tokens.input, output: tokens.output },
      responseAfter: { input: tokens.input + 123, output: tokens.output + 7 },
      refreshedTurnCheck: Boolean(check) };
  } finally { database.close(); }
}

async function scenarioInputs(config) {
  const scenarios = [{ name: 'unchanged', bytes: 0 }];
  for (const label of ['codex', 'claude', 'zstd']) {
    const target = config.targets[label];
    if (!target) continue;
    const base = await fsp.readFile(target.path);
    const addition = makeAddition(target);
    const suffix = label === 'zstd' ? zstdCompressSync(addition) : addition;
    scenarios.push({ name: `${label}-append`, target, base, changed: Buffer.concat([base, suffix]), bytes: suffix.length,
      requestsDelta: 1, tokensDelta: 130 });
    if (label === 'codex') {
      const update = await existingResponseUpdate(config, target);
      scenarios.push({ name: 'codex-update-existing', target, base,
        changed: Buffer.concat([base, update.suffix]), bytes: update.suffix.length,
        requestsDelta: 0, tokensDelta: 130,
        responseBefore: update.responseBefore, responseAfter: update.responseAfter,
        refreshedTurnCheck: update.refreshedTurnCheck });
      const text = base.toString('utf8');
      let changedValue;
      const rewritten = text.replace(/"input_tokens"\s*:\s*(\d+)/, (match, number) => {
        const next = number.at(-1) === '9' ? number.slice(0, -1) + '8' : String(Number(number) + 1);
        changedValue = { before: Number(number), after: Number(next) };
        return match.replace(number, next);
      });
      assert.ok(changedValue);
      scenarios.push({ name: 'middle-rewrite-and-append', target, base,
        changed: Buffer.concat([Buffer.from(rewritten), suffix]), bytes: suffix.length, changedValue });
      const insertionOffset = base.indexOf(10, Math.floor(base.length / 2)) + 1;
      assert.ok(insertionOffset > 0 && insertionOffset < base.length);
      scenarios.push({ name: 'middle-insert-and-append', target, base,
        changed: Buffer.concat([base.subarray(0, insertionOffset), Buffer.from('\n'), base.subarray(insertionOffset), suffix]),
        bytes: suffix.length + 1, insertionOffset });
    }
  }
  return scenarios;
}

function comparable(sample) {
  return { facts: sample.facts, queries: Object.fromEntries(groups.map(group => [group,
    { groups: sample.queries[group].groups, sha256: sample.queries[group].sha256 }])) };
}

function summarize(samples) {
  const result = {};
  for (const variant of [...new Set(samples.map(row => row.variant))]) {
    result[variant] = {};
    for (const scenario of [...new Set(samples.map(row => row.scenario))]) {
      const rows = samples.filter(row => row.variant === variant && row.scenario === scenario && row.measured);
      if (!rows.length) continue;
      result[variant][scenario] = { elapsedMs: stats(rows.map(row => row.elapsedMs)),
        bodyBytes: stats(rows.map(row => row.bodyBytes)), parsedRows: stats(rows.map(row => row.metrics.parsedRows)),
        peakRssBytes: stats(rows.map(row => row.observedPeak.rss)),
        peakHeapBytes: stats(rows.map(row => row.observedPeak.heapUsed)),
        validationMs: stats(rows.map(row => row.metrics.validationMs ?? 0)),
        parseMs: stats(rows.map(row => row.metrics.parseMs ?? 0)),
        cloneMs: stats(rows.map(row => row.metrics.cloneMs ?? 0)),
        queries: Object.fromEntries(groups.map(group => [group, stats(rows.map(row => row.queries[group].elapsedMs))])) };
    }
  }
  return result;
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => {
    const [name, ...value] = arg.replace(/^--/, '').split('='); return [name, value.join('=') || true];
  }));
  const setup = args.workspace ? JSON.parse(await fsp.readFile(join(resolve(args.workspace), 'setup.private.json'), 'utf8'))
    : await prepareWorkspace();
  console.log(JSON.stringify({ workspace: setup.workspace }));
  if (args['prepare-only']) return;
  const hashers = await loadHashers();
  const hashValidation = await validateHashers();
  const scenarioSelection = args.scenarios ? String(args.scenarios).split(',') : ['codex-append', 'codex-update-existing'];
  const report = { schemaVersion: 2, dateSeoul, startedAt: new Date().toISOString(), environment: { node: process.version, openssl: process.versions.openssl,
    platform: process.platform, architecture: process.arch, cpu: cpus()[0].model, logicalCpu: cpus().length, totalRam: totalmem() },
    protocol: { warmups: args.smoke ? 0 : 3, repetitions: args.smoke ? 1 : 10, sourceWorkers: 1,
      scenarios: scenarioSelection,
      order: 'forward/reverse variants on alternating rounds, one active child at a time',
      cache: 'warm OS cache, immutable in-memory checkpoint, seed DB restored before each sample',
      timing: 'refreshSummary through COMMIT, excluding input mutation, DB restoration, GC, checks and queries',
      memory: '10 ms and read/stage-boundary samples, per-variant isolated child; no guaranteed instantaneous peak',
      fingerprintTail: 'conditional append-only candidate; middle rewrites are expected limitations',
      blockPolicy: 'matched prefix reuses EOF checkpoint; changed prefix falls back to full parsing',
      compressed: 'completed independent Zstd frame append can resume; partial frame/line falls back to full' },
    product: { source: setup.source, build: setup.build }, hashValidation, datasets: [] };
  const output = resolve(args.output || join(setup.workspace, 'results.private.json'));
  const writeReport = () => fsp.writeFile(output, JSON.stringify(report, null, 2) + '\n');
  if (!args.smoke) {
    const correctness = await require('./correctness.cjs').runCorrectness({ product: setup.product, hashers, workspace: setup.workspace });
    report.correctness = correctness;
    await writeReport();
    assert.equal(correctness.requiredFailed, 0, 'A candidate failed the required correctness cases');
    console.log(JSON.stringify({ stage: 'correctness', passed: correctness.requiredPassed,
      limitations: correctness.observedLimitationCases }));
  }
  const selected = args.variants ? String(args.variants).split(',') : variants;
  for (const dataset of setup.datasets.filter(item => !args.smoke || item.name === 'synthetic-100')) {
    const config = JSON.parse(await fsp.readFile(dataset.configPath, 'utf8'));
    const seed = await seedDataset(config);
    Object.assign(config, seed);
    await fsp.writeFile(dataset.configPath, JSON.stringify(config, null, 2));
    const result = { name: config.name, inventory: config.snapshot.inventory, inputSha256: config.snapshot.sha256,
      expectedSynthetic: config.snapshot.expected, baseline: seed.baseline, initialization: [], samples: [], checks: [] };
    report.datasets.push(result);
    const inputs = (await scenarioInputs(config)).filter(input => scenarioSelection.includes(input.name));
    assert.equal(inputs.length, scenarioSelection.length, 'A selected scenario was unavailable');
    result.scenarios = inputs.map(input => ({ name: input.name, addedBytes: input.bytes,
      requestsDelta: input.requestsDelta, tokensDelta: input.tokensDelta,
      responseBefore: input.responseBefore, responseAfter: input.responseAfter,
      refreshedTurnCheck: input.refreshedTurnCheck }));
    const children = new Map();
    try {
      for (const variant of selected) {
        const child = launchChild(dataset.configPath, variant);
        children.set(variant, child);
        const ready = await child.ready;
        result.initialization.push(ready);
        console.log(JSON.stringify({ stage: 'ready', dataset: config.name, variant,
          ms: ready.initializationMs, cacheBytes: ready.cache.serializedBytes + ready.cache.indexSerializedBytes }));
      }
      const warmups = report.protocol.warmups;
      const repetitions = report.protocol.repetitions;
      const expected = new Map();
      for (let round = -warmups; round < repetitions; round++) {
        for (const input of inputs) {
          if (input.target) {
            await fsp.writeFile(input.target.path, input.changed);
            const changedTime = new Date(Date.UTC(2026, 10, 16, 1, 0, 0));
            await fsp.utimes(input.target.path, changedTime, changedTime);
          }
          const order = Math.abs(round) % 2 ? [...selected].reverse() : selected;
          try {
            for (const variant of order) {
              const sample = await children.get(variant).measure({ scenario: input.name, iteration: round + 1, measured: round >= 0 });
              result.samples.push(sample);
              const limited = variant === 'fingerprint-tail' && input.name.startsWith('middle-');
              if (variant === 'full-sha256' && !expected.has(input.name)) expected.set(input.name, comparable(sample));
              if (expected.has(input.name) && !limited) assert.deepEqual(comparable(sample), expected.get(input.name), `${config.name}/${variant}/${input.name}`);
              if (input.requestsDelta !== undefined) {
                assert.equal(sample.facts.requests, seed.baseline.requests + input.requestsDelta);
                assert.equal(sample.facts.tokens, seed.baseline.tokens + input.tokensDelta);
              }
              if (round >= 0) console.log(JSON.stringify({ dataset: config.name, round: round + 1,
                scenario: input.name, variant, ms: +sample.elapsedMs.toFixed(3), rows: sample.metrics.parsedRows }));
            }
          } finally {
            if (input.target) {
              await fsp.writeFile(input.target.path, input.base);
              await fsp.utimes(input.target.path, input.target.originalAtime / 1000, input.target.originalMtime / 1000);
            }
          }
        }
        result.summary = summarize(result.samples);
        await writeReport();
      }
      for (const sample of result.samples) {
        const limited = sample.variant === 'fingerprint-tail' && sample.scenario.startsWith('middle-');
        if (limited) continue;
        assert.deepEqual(comparable(sample), expected.get(sample.scenario));
      }
      result.checks.push({ allRequiredFactsAndQueriesMatched: true, independentMeansChecked: true });
      for (const file of config.snapshot.files) assert.equal(sha(await fsp.readFile(file.path)), file.sha256, 'Frozen input changed');
    } finally { for (const child of children.values()) child.close(); }
    await writeReport();
  }
  report.finishedAt = new Date().toISOString();
  report.runner = treeFingerprint(__dirname);
  await writeReport();
  console.log(JSON.stringify({ complete: true, output }));
}

if (process.argv[2] === '--child') {
  childMain(process.argv[3], process.argv[4]).catch(error => { console.error(error.stack); process.exitCode = 1; });
} else if (require.main === module) {
  main().catch(error => { console.error(error.stack); process.exitCode = 1; });
}

module.exports = { stats, summarize, comparable };
