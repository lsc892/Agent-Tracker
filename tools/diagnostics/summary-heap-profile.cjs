// Profiles the public SummaryClient workload in the host, summary worker and file workers.
'use strict';

const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { readFileSync, writeFileSync } = require('node:fs');
const fs = require('node:fs/promises');
const { Session } = require('node:inspector');
const { dirname, join, relative, resolve, sep } = require('node:path');
const { setImmediate: immediate } = require('node:timers/promises');
const { fileURLToPath } = require('node:url');
const { BroadcastChannel, Worker, isMainThread, parentPort, threadId, workerData } = require('node:worker_threads');
const { fileHash, treeHash } = require('../../tests/benchmarks/thread-token-buffer-ab.cjs');

const repo = resolve(__dirname, '../..');
const configKey = 'AGENT_TRACKER_SUMMARY_HEAP_PROFILE';
const intervalMs = 5;
const samplingInterval = 16 * 1024;
const timezone = 'Asia/Seoul';
const scanStages = new Set(['lock', 'discover', 'names', 'parseChanged', 'expandRelated', 'aggregate',
  'commitComponents', 'finishScan', 'optimize', 'sourcePoolClose']);

function readConfig() {
  return JSON.parse(process.env[configKey]);
}

function sendCommand(inspector, method, params = {}) {
  let value, failure, completed = false;
  inspector.post(method, params, (error, result) => {
    completed = true;
    failure = error;
    value = result;
  });
  assert.ok(completed, `Expected synchronous local inspector response for ${method}`);
  if (failure) throw failure;
  return value;
}

function summarizeProfile(profile, root) {
  const stack = [{ node: profile.head }];
  const sites = new Map();
  let bytes = 0;
  while (stack.length) {
    const { node, productFrame } = stack.pop();
    const { functionName, url, lineNumber } = node.callFrame;
    const filename = url.startsWith('file:') ? fileURLToPath(url) : url;
    const within = filename.startsWith(root + sep);
    const frame = within ? `${relative(root, filename).split(sep).join('/')}:${lineNumber + 1} ${functionName || '(anonymous)'}` : productFrame;
    bytes += node.selfSize;
    if (node.selfSize && frame) sites.set(frame, (sites.get(frame) ?? 0) + node.selfSize);
    for (const child of node.children) stack.push({ node: child, productFrame: frame });
  }
  return {
    sampledBytes: bytes, samples: profile.samples.length,
    productSites: [...sites].sort((a, b) => b[1] - a[1]).slice(0, 80),
  };
}

function sampleHeap(config, role) {
  const marks = {}, peaks = {}, root = join(config.product, 'dist/src');
  let activity = 'boot';
  let inspector;
  if (config.mode !== 'timeline') {
    inspector = new Session();
    inspector.connect();
    const includeCollected = config.mode === 'allocations';
    sendCommand(inspector, 'HeapProfiler.startSampling', { samplingInterval,
      includeObjectsCollectedByMajorGC: includeCollected, includeObjectsCollectedByMinorGC: includeCollected });
  }
  const sample = (point) => {
    const { heapUsed, external, arrayBuffers, rss } = process.memoryUsage();
    const current = { heapUsed, external, arrayBuffers, rss, ms: performance.now() };
    if (point) marks[point] = current;
    const prior = peaks[activity];
    if (!prior || heapUsed > prior.heapUsed) peaks[activity] = current;
    return current;
  };
  const timer = setInterval(sample, intervalMs);
  timer.unref();
  return {
    get phase() { return activity; },
    set phase(value) { activity = value; },
    sample,
    profiles: {},
    shape: undefined,
    profile() {
      if (inspector) return summarizeProfile(sendCommand(inspector, 'HeapProfiler.getSamplingProfile').profile, root);
    },
    async gc(point) {
      await immediate();
      global.gc();
      await immediate();
      global.gc();
      const measured = sample(point);
      if (config.mode === 'retained') this.profiles[point] = this.profile();
      return measured;
    },
    finish() {
      clearInterval(timer);
      sample('beforeExit');
      const allAllocations = config.mode === 'allocations' ? this.profile() : undefined;
      if (inspector) {
        sendCommand(inspector, 'HeapProfiler.stopSampling');
        inspector.disconnect();
      }
      writeFileSync(join(config.run, `isolate-${threadId}.json`),
        JSON.stringify({ role, threadId, marks, peaks, shape: this.shape, profiles: this.profiles, allAllocations }));
    },
  };
}

function aggregationShape(aggregation) {
  let checkpointIntervals = 0, checkpointKeys = 0, responseRows = 0, responseKeyCodeUnits = 0;
  let legacyRows = 0, legacySignatureCodeUnits = 0, responseBufferBytes = 0, legacyBufferBytes = 0;
  let legacySignatureBufferBytes = 0;
  let turnIdCodeUnits = 0, responseIdCodeUnits = 0, uniqueLegacyCodeUnits = 0, uuidTurnRows = 0;
  const turnIds = new Set(), responseIds = new Set(), legacySignatures = new Set(), models = new Set();
  const uuid = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
  for (const { source, codex } of aggregation.threads.values()) {
    if (!codex) continue;
    const responseIndex = codex.indices ?? codex.winners;
    responseRows += responseIndex.size;
    responseBufferBytes += codex.tokens?.values.byteLength ?? 0;
    for (const key of responseIndex.keys()) responseKeyCodeUnits += key.length;
    for (const row of codex.rows ?? codex.winners.values()) {
      turnIds.add(row.turnId);
      responseIds.add(row.responseId);
      models.add(row.model);
      turnIdCodeUnits += row.turnId.length;
      responseIdCodeUnits += row.responseId.length;
      if (uuid.test(row.turnId)) uuidTurnRows++;
    }
    for (const interval of source.codex?.checkpoints ?? []) {
      checkpointIntervals++;
      checkpointKeys += interval.responseKeys.length;
    }
    const legacy = source.codex?.legacy;
    if (!legacy) continue;
    const signatures = legacy.signatures ?? legacy;
    legacyBufferBytes += legacy.tokens?.byteLength ?? 0;
    let keys = signatures;
    if (signatures.rowIds) {
      const { rowIds, offsets, bytes } = signatures;
      legacySignatureBufferBytes += rowIds.buffer.byteLength + offsets.buffer.byteLength + bytes.buffer.byteLength;
      const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const dictionary = Array.from({ length: Math.max(0, offsets.length - 1) }, (_, id) =>
        buffer.toString('utf8', offsets[id], offsets[id + 1]));
      keys = Array.from(rowIds, id => dictionary[id]);
    }
    legacyRows += keys.length;
    for (const entry of keys) {
      const key = typeof entry === 'string' ? entry : entry.signature;
      legacySignatureCodeUnits += key.length;
      if (legacySignatures.has(key)) continue;
      legacySignatures.add(key);
      uniqueLegacyCodeUnits += key.length;
    }
  }
  return { groups: aggregation.threads.size, claudeMessageGroups: aggregation.claude.size, parentIndex: aggregation.parents.size,
    responseRows, responseKeyCodeUnits, checkpointIntervals, checkpointKeys, legacyRows, legacySignatureCodeUnits,
    responseBufferBytes, legacyBufferBytes, legacySignatureBufferBytes, turnIds: turnIds.size, responseIds: responseIds.size, models: models.size,
    turnIdCodeUnits, responseIdCodeUnits, uuidTurnRows, uniqueLegacySignatures: legacySignatures.size, uniqueLegacyCodeUnits };
}

function instrumentSummary(config, sampler) {
  let refreshes = 0;
  parentPort.on('message', ({ method, payload }) => {
    if (method === 'refresh') sampler.phase = ++refreshes === 1 ? 'coldRefresh' : `unchangedRefresh/${refreshes - 1}`;
    else if (method === 'query') sampler.phase = queryPhase(payload);
    else sampler.phase = method;
    sampler.sample();
  });
  const { StageProfiler } = require(join(config.product, 'dist/src/summary/profiling'));
  const originalMeasure = StageProfiler.prototype.measure, originalAsync = StageProfiler.prototype.measureAsync;
  const inStage = stage => { const previous = sampler.phase; sampler.phase = `${previous}/${stage}`; sampler.sample(); return previous; };
  const outStage = previous => { sampler.sample(); sampler.phase = previous; };
  StageProfiler.prototype.measure = function(stage, action) {
    if (!scanStages.has(stage)) return originalMeasure.call(this, stage, action);
    const previous = inStage(stage);
    try { return originalMeasure.call(this, stage, action); }
    finally { outStage(previous); }
  };
  StageProfiler.prototype.measureAsync = async function(stage, action) {
    if (!scanStages.has(stage)) return originalAsync.call(this, stage, action);
    const previous = inStage(stage);
    try { return await originalAsync.call(this, stage, action); }
    finally { outStage(previous); }
  };
  const { ThreadAggregation } = require(join(config.product, 'dist/src/summary/scanner/refresh/aggregation'));
  const summarize = ThreadAggregation.prototype.summarize;
  ThreadAggregation.prototype.summarize = function(...args) {
    if (this.threads.size && !sampler.shape && config.mode === 'retained') {
      sampler.sample('beforeAggregate');
      sampler.shape = aggregationShape(this);
      global.gc();
      sampler.sample('beforeAggregateAfterGc');
      sampler.profiles.beforeAggregate = sampler.profile();
    }
    return summarize.apply(this, args);
  };
}

function instrumentSource(config, sampler) {
  const parser = require(join(config.product, 'dist/src/summary/parsers/threadUsage'));
  const read = require(join(config.product, 'dist/src/summary/scanner/sourcePreparation'));
  const row = parser.ThreadLogParser.prototype.row, prepare = read.prepareSource;
  let counter = 0;
  parser.ThreadLogParser.prototype.row = function(...args) {
    const result = row.apply(this, args);
    if (++counter % 128 === 0) sampler.sample();
    return result;
  };
  read.prepareSource = async (file, options) => {
    sampler.phase = file.path.endsWith('.zst') ? 'parse/compressed' : 'parse/plain';
    sampler.sample();
    try { return await prepare(file, options); }
    finally { sampler.sample(); }
  };
}

function channelTools(config, sampler) {
  process.on('worker', worker => worker.on('error', error => console.error(error)));
  const channel = new BroadcastChannel(`agent-tracker-heap-profile-${config.run}`);
  channel.unref();
  channel.onmessage = async ({ data }) => {
    if (data.target !== threadId) return;
    try {
      if (data.action === 'finish') sampler.finish();
      else await sampler.gc(data.action);
      channel.postMessage({ reply: data.request });
    } catch (error) {
      channel.postMessage({ reply: data.request, error: error.message });
    }
  };
  let nextId = 0;
  const request = (target, action) => new Promise((done, reject) => {
    const key = `${threadId}/${++nextId}`;
    const receive = ({ data }) => {
      if (data.reply !== key) return;
      clearTimeout(timer);
      channel.removeEventListener('message', receive);
      if (data.error) reject(new Error(data.error));
      else done();
    };
    const timer = setTimeout(() => {
      channel.removeEventListener('message', receive);
      reject(new Error(`Worker ${target} did not report ${action}`));
    }, 10000);
    channel.addEventListener('message', receive);
    channel.postMessage({ target, action, request: key });
  });
  const terminate = Worker.prototype.terminate;
  Worker.prototype.terminate = async function(...args) {
    try { if (this.threadId > 0) await request(this.threadId, 'finish'); }
    finally { await terminate.apply(this, args); }
  };
  return { request, close: () => channel.close() };
}

function instrumentWorker() {
  const config = readConfig();
  const role = typeof workerData?.dbPath === 'string' ? 'summary' : 'source';
  const sampler = sampleHeap(config, role);
  if (role === 'summary') instrumentSummary(config, sampler);
  else instrumentSource(config, sampler);
  channelTools(config, sampler);
}

function queryPhase(payload) {
  const { groupBy = 'total', limit = 100, chartBy = 'provider' } = payload ?? {};
  return `query/${groupBy}/${chartBy}/${limit}`;
}

async function runHost() {
  const config = readConfig();
  const sampler = sampleHeap(config, 'client');
  const channel = channelTools(config, sampler);
  const { roots } = JSON.parse(readFileSync(config.manifest, 'utf8'));
  const { SummaryClient } = require(join(config.product, 'dist/src/summary/client'));
  const workers = [];
  process.on('worker', worker => workers.push(worker.threadId));
  const client = new SummaryClient({ roots, dbPath: join(config.run, 'profile.sqlite'), timezone, sourceWorkers: 4,
    collectCapabilities: false });
  async function phase(name, action) {
    sampler.phase = name;
    sampler.sample();
    const result = await action();
    sampler.sample(name + '/end');
    return result;
  }
  try {
    await phase('initialize', () => client.initialize());
    assert.equal(workers.length, 1);
    const summaryWorker = workers[0];
    await channel.request(summaryWorker, 'initialAfterGc');
    await sampler.gc('initialAfterGc');
    const cold = await phase('coldRefresh', () => client.refresh());
    assert.equal(cold.interrupted, false, cold.error);
    assert.equal(cold.failed, 0);
    assert.equal(cold.parsed, config.expected.parsed);
    assert.equal(cold.bodyBytes, config.expected.bytes);
    if (config.mode === 'retained') await channel.request(summaryWorker, 'coldAfterGc');
    for (const groupBy of ['day', 'month', 'session', 'project']) {
      const query = { groupBy, limit: 100, chartMetric: 'tokens' };
      await phase(queryPhase(query), () => client.query(query));
    }
    const wideQuery = { groupBy: 'session', limit: 1000, chartBy: 'model', chartMetric: 'averageTokens' };
    await phase(queryPhase(wideQuery), () => client.query(wideQuery));
    const total = await phase('query/total/provider/100', () => client.query({ groupBy: 'total', unknownTime: 'include' }));
    assert.equal(total.rows.reduce((sum, row) => sum + row.total_tokens, 0), config.expected.tokens);
    const diagnostics = await phase('diagnostics', () => client.diagnostics({ limit: 100 }));
    assert.equal(diagnostics.counts.error, 0);
    const idle = [];
    for (let index = 0; index < 5; index++) {
      const result = await phase('unchangedRefresh', () => client.refresh());
      assert.equal(result.interrupted, false, result.error);
      assert.equal(result.failed, 0);
      assert.equal(result.bodyBytes, 0);
      idle.push({ parsed: result.parsed, bodyBytes: result.bodyBytes });
      await channel.request(summaryWorker, `unchangedAfterGc/${index + 1}`);
    }
    await sampler.gc('steadyAfterGc');
    await fs.writeFile(join(config.run, 'workload.json'), JSON.stringify({ elapsedMs: cold.timings.totalMs,
      parsed: cold.parsed, bodyBytes: cold.bodyBytes, unchanged: idle, totals: { tokens: config.expected.tokens },
      processMaxRss: process.resourceUsage().maxRSS * 1024 }));
  } finally {
    await client.dispose();
    sampler.finish();
    channel.close();
  }
}

async function runQuota() {
  const config = readConfig();
  const sampler = sampleHeap(config, 'offlineQuota');
  await sampler.gc('preloadAfterGc');
  const root = join(config.product, 'dist/src');
  const { QuotaService } = require(join(root, 'quota/service'));
  const { parseClaudeQuota } = require(join(root, 'quota/claude/response'));
  const { parseCodexQuota } = require(join(root, 'quota/codex/response'));
  const { quotaHoverSummary } = require(join(root, 'ui/statusBarPresentation'));
  const rawClaude = { five_hour: { utilization: 20 }, seven_day: { utilization: 30 } };
  const rawCodex = { rateLimits: { primary: { usedPercent: 20, windowDurationMins: 300 },
    secondary: { usedPercent: 35, windowDurationMins: 10080 } } };
  const providers = [{ id: 'claude', read: async () => parseClaudeQuota(rawClaude, Date.now()) },
    { id: 'codex', read: async () => parseCodexQuota(rawCodex, Date.now()) }];
  const service = new QuotaService(providers);
  sampler.phase = 'quota';
  try {
    await sampler.gc('initializedAfterGc');
    for (let index = 0; index < 30; index++) {
      await Promise.all(providers.map(provider => service.refresh(provider.id, true)));
      const states = service.getStates();
      assert.ok(states.every(state => state.snapshot?.windows.length === 2));
      quotaHoverSummary(states);
      sampler.sample();
    }
    await sampler.gc('repeatedAfterGc');
  } finally {
    await service.dispose();
    sampler.finish();
  }
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).map(arg => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
  assert.ok(args.workspace && args.reference && args.output, 'Pass --workspace, --reference and --output');
  const variant = args.variant ?? 'B';
  assert.ok(['A', 'B', 'both'].includes(variant), 'Use --variant=A, --variant=B or --variant=both');
  assert.ok(!args.mode || ['timeline', 'allocations', 'retained'].includes(args.mode), 'Unknown profile mode');
  const timelineRuns = Number(args['timeline-runs'] ?? (args.mode === 'timeline' ? 1 : 3));
  assert.ok(Number.isSafeInteger(timelineRuns) && timelineRuns > 0, '--timeline-runs must be a positive integer');
  const variants = variant === 'both' ? ['A', 'B'] : [variant];
  const modes = args.mode && args.mode !== 'timeline' ? [args.mode] : Array(timelineRuns).fill('timeline');
  if (!args.mode) modes.push('allocations', 'retained');
  const workspace = resolve(args.workspace);
  const reference = JSON.parse(await fs.readFile(args.reference, 'utf8'));
  const products = {};
  for (const id of variants) {
    const product = products[id] = join(workspace, id);
    assert.equal(await treeHash(join(product, 'dist/src')), reference.builds[id].build);
    assert.equal(await treeHash(join(product, 'src')), reference.builds[id].source);
  }
  const folder = await fs.mkdtemp(join(repo, 'tests/.cache/summary-heap-profile-'));
  const inputs = {};
  const startedAt = new Date().toISOString();
  for (const name of args.dataset ? [args.dataset] : ['real', '10000']) {
    const manifest = join(workspace, name, 'snapshot.json');
    const input = reference.inputs[name];
    const snapshot = JSON.parse(await fs.readFile(manifest, 'utf8'));
    assert.equal(snapshot.sha256, input.sha256);
    for (const file of snapshot.files) assert.equal(await fileHash(file.path), file.sha256);
    const rows = inputs[name] = { sha256: input.sha256, runs: [] };
    for (const [index, mode] of modes.entries()) {
      const order = index % 2 === 0 ? variants : variants.toReversed();
      for (const id of order) {
        const run = join(folder, `${name}-${mode}-${index + 1}-${id}`);
        await fs.mkdir(run);
        const original = input.samples.cold[0][id];
        const expected = { parsed: original.parsed, bytes: original.bytes,
          tokens: original.totals.reduce((sum, row) => sum + row.tokens, 0) };
        await profileChild('--child', { product: products[id], manifest, mode, run, expected });
        const files = (await fs.readdir(run)).filter(file => file.startsWith('isolate-')).sort();
        const isolates = files.map(file => JSON.parse(readFileSync(join(run, file), 'utf8')));
        assert.equal(isolates.filter(row => row.role === 'summary').length, 1);
        assert.equal(isolates.filter(row => row.role === 'client').length, 1);
        if (name === 'real') assert.equal(isolates.filter(row => row.role === 'source').length, 4);
        rows.runs.push({ variant: id, mode, workload: JSON.parse(readFileSync(join(run, 'workload.json'), 'utf8')), isolates });
        console.log(`${name} ${mode} ${id} ${index + 1}/${modes.length}`);
      }
    }
  }
  const offlineQuota = [];
  if (args['skip-quota'] !== 'true') {
    for (const id of variants) {
      for (let index = 0; index < 3; index++) {
        const run = join(folder, `quota-${index + 1}-${id}`);
        await fs.mkdir(run);
        await profileChild('--quota', { product: products[id], mode: 'timeline', run });
        offlineQuota.push({ variant: id, ...JSON.parse(readFileSync(join(run, 'isolate-0.json'), 'utf8')) });
      }
    }
  }
  const output = resolve(args.output);
  await fs.mkdir(dirname(output), { recursive: true });
  const builds = Object.fromEntries(variants.map(id => [id, reference.builds[id]]));
  await fs.writeFile(output, JSON.stringify({ startedAt, completedAt: new Date().toISOString(),
    ...(variants.length === 1 ? { build: builds[variant] } : {}), builds,
    environment: { node: process.version, v8: process.versions.v8, sqlite: process.versions.sqlite, platform: process.platform },
    intervalMs, samplingInterval, inputs, offlineQuota }, null, 2) + '\n', { flag: 'wx' });
}

function profileChild(action, config) {
  const execArgv = ['--no-warnings', '--expose-gc'];
  if (action === '--child') execArgv.push('--require', __filename);
  return new Promise((done, reject) => {
    const child = fork(__filename, [action], {
      execArgv, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, [configKey]: JSON.stringify(config) }, windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? done() : reject(new Error(`${action} profile exited with code ${code}`)));
  });
}

if (!isMainThread && process.env[configKey]) instrumentWorker();
const isHost = isMainThread && process.argv[2] === '--child' && process.env[configKey];
if (isHost || isMainThread && require.main === module) {
  const run = isHost ? runHost() : process.argv[2] === '--quota' ? runQuota() : main();
  run.catch(error => { console.error(error); process.exitCode = 1; })
    .finally(() => { if (process.connected) process.disconnect(); });
}
