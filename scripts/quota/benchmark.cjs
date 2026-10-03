'use strict';
const { spawn } = require('node:child_process');
const { mkdtemp, mkdir, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { basename, dirname, join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { createInterface } = require('node:readline');

function optionsFromArgs(args) {
  const result = { real: false, iterations: undefined, sampleMs: 50,
    output: resolve(__dirname, '../../benchmark-results/quota.json'), executable: undefined, dataHome: undefined };
  for (const arg of args) {
    if (arg === '--real') { result.real = true; continue; }
    const match = /^--(iterations|sample-ms|output|executable|data-home)=(.+)$/.exec(arg);
    if (!match) throw new Error('Invalid benchmark options; see docs/QuotaBenchmark.md.');
    if (match[1] === 'iterations') result.iterations = Number(match[2]);
    else if (match[1] === 'sample-ms') result.sampleMs = Number(match[2]);
    else if (match[1] === 'output') result.output = resolve(match[2]);
    else if (match[1] === 'executable') result.executable = match[2];
    else result.dataHome = match[2];
  }
  result.iterations ??= result.real ? 1 : 2;
  if (!Number.isInteger(result.iterations) || result.iterations < 1 || result.iterations > 10 ||
      !Number.isInteger(result.sampleMs) || result.sampleMs < 10 || result.sampleMs > 1000) {
    throw new Error('iterations must be 1–10 and sample-ms must be 10–1000.');
  }
  if (!result.real && (result.executable || result.dataHome)) throw new Error('CLI configuration requires the explicit --real option.');
  return result;
}

function summarizeSamples(samples, method, intervalMs, childLifetimeMs) {
  const valid = samples.filter(sample => Number.isFinite(sample.rssBytes) && sample.rssBytes > 0 && Number.isFinite(sample.offsetMs));
  const mean = valid.length ? valid.reduce((sum, sample) => sum + sample.rssBytes, 0) / valid.length : null;
  const first = valid[0];
  const last = valid.at(-1);
  const span = first && last ? last.offsetMs - first.offsetMs : 0;
  const gaps = valid.slice(1).map((sample, index) => sample.offsetMs - valid[index].offsetMs);
  const osPeaks = valid.map(sample => sample.osPeakRssBytes).filter(value => Number.isFinite(value) && value > 0);
  const cpu = valid.map(sample => sample.cpuMs).filter(value => Number.isFinite(value) && value >= 0);
  return { method, requestedIntervalMs: intervalMs, sampleCount: valid.length,
    observedMeanRssBytes: mean, sampledPeakRssBytes: valid.length ? Math.max(...valid.map(sample => sample.rssBytes)) : null,
    osPeakRssBytesAtLastSamples: osPeaks.length ? Math.max(...osPeaks) : null,
    cpuTimeAtLastSampleMs: cpu.at(-1) ?? null,
    firstSampleAfterTargetMs: first?.offsetMs ?? null, lastSampleAfterTargetMs: last?.offsetMs ?? null,
    observedMeanIntervalMs: gaps.length ? span / gaps.length : null,
    observedMaxIntervalMs: gaps.length ? Math.max(...gaps) : null,
    observedSpanMs: span, observedCoverageFraction: childLifetimeMs > 0 ? Math.min(1, span / childLifetimeMs) : null,
    estimatedCycleMeanRssBytesAt900Seconds: mean !== null && childLifetimeMs !== null ? mean * childLifetimeMs / 900_000 : null };
}

async function createSampler(intervalMs) {
  const command = process.platform === 'win32'
    ? join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : process.execPath;
  const args = process.platform === 'win32'
    ? ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(__dirname, 'sample-rss.ps1'), '-SampleMilliseconds', String(intervalMs)]
    : [join(__dirname, 'sample-rss.cjs'), String(intervalMs)];
  const sampler = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  const samples = [];
  let method = 'unavailable';
  let closed = false;
  let ready;
  const startup = new Promise(resolve => { ready = resolve; });
  const exited = new Promise(resolve => sampler.once('close', () => { closed = true; ready(); resolve(); }));
  sampler.on('error', () => ready());
  sampler.stdin.on('error', () => {});
  sampler.stderr.resume();
  const lines = createInterface({ input: sampler.stdout });
  lines.on('line', line => {
    if (line.length > 4096) return;
    try {
      const value = JSON.parse(line);
      if (value.event === 'ready') { method = value.method; ready(); }
      else if (value.event === 'sample' && samples.length < 10_000) samples.push(value);
    } catch { /* The sampler never forwards raw output into the report. */ }
  });
  await raceDelay(startup, 5000);
  if (method === 'unavailable' && !closed) sampler.kill();
  return {
    target(pid) { if (method !== 'unavailable' && !closed && Number.isInteger(pid)) sampler.stdin.end(`${pid}\n`); },
    async finish(lifetimeMs) {
      if (!closed) { sampler.stdin.end(); await raceDelay(exited, 1500); }
      if (!closed) { sampler.kill(); await raceDelay(exited, 1500); }
      lines.close();
      sampler.stdin.destroy(); sampler.stdout.destroy(); sampler.stderr.destroy();
      return { ...summarizeSamples(samples, method, intervalMs, lifetimeMs), samplerExitConfirmed: closed };
    },
  };
}

async function raceDelay(promise, ms) {
  let timer;
  try { await Promise.race([promise, new Promise(resolve => { timer = setTimeout(resolve, ms); })]); }
  finally { clearTimeout(timer); }
}

async function runScenario(options, scenario, iteration, directory) {
  const { CodexQuotaProvider, QuotaError } = require('../../dist/src/quota');
  const sampler = await createSampler(options.sampleMs);
  const resourceFile = join(directory, `resources-${scenario}-${iteration}.json`);
  const controller = new AbortController();
  const phases = {};
  let processStartedAt = null;
  let processStoppedAt = null;
  let processId;
  let cancelTimer;
  let outcome = 'success';
  let errorCode = null;
  const start = performance.now();
  const provider = new CodexQuotaProvider({
    ...(options.real ? { executable: options.executable, dataHome: options.dataHome } : {
      executable: process.execPath, args: [join(__dirname, 'fixture-app-server.cjs')], dataHome: directory,
      env: { QUOTA_BENCHMARK_MODE: scenario, QUOTA_BENCHMARK_RESOURCE_FILE: resourceFile },
    }),
    timeoutMs: options.real ? 15_000 : scenario === 'timeout' ? 750 : 5000,
    shutdownGraceMs: 200,
    onLifecycle: event => {
      if (event.event === 'started') {
        processId = event.pid;
        processStartedAt = event.elapsedMs;
        sampler.target(event.pid);
      } else processStoppedAt = event.elapsedMs;
    },
    onPhase: event => {
      phases[event.phase] = event.elapsedMs;
      if (scenario === 'cancel' && event.phase === 'account-read') cancelTimer = setTimeout(() => controller.abort(), 200);
    },
  });
  try {
    // Discard the entire snapshot; quota percentages, account data and reset times never reach the report.
    await provider.read({ signal: controller.signal });
  } catch (error) {
    outcome = 'error';
    errorCode = error instanceof QuotaError ? error.code : 'unknown';
  } finally {
    clearTimeout(cancelTimer);
    await provider.dispose();
  }
  const elapsedMs = performance.now() - start;
  const childLifetimeMs = processStartedAt !== null && processStoppedAt !== null ? processStoppedAt - processStartedAt : null;
  const memory = await sampler.finish(childLifetimeMs);
  let processStillAlive = null;
  if (processId) {
    try { process.kill(processId, 0); processStillAlive = true; }
    catch (error) { processStillAlive = error?.code === 'ESRCH' ? false : null; }
  }
  let fixtureResources = null;
  if (!options.real) {
    try {
      const resource = JSON.parse(await readFile(resourceFile, 'utf8'));
      fixtureResources = { selfReportedLifetimeMaxRssBytes: resource.lifetimeMaxRssBytes,
        selfReportedCpuTotalMs: resource.cpuTotalMs };
    } catch { /* A force-killed fixture may not have written a final sample. */ }
  }
  const expectedError = { error: 'protocol', timeout: 'timeout', cancel: 'cancelled' }[scenario] ?? null;
  return { scenario, iteration, outcome, errorCode,
    expectedOutcome: expectedError ? 'error' : 'success', expectedErrorCode: expectedError,
    matchedExpectedOutcome: expectedError ? errorCode === expectedError : outcome === 'success',
    latency: { elapsedMs, spawnReturnedMs: processStartedAt, initializeCompletedMs: phases.initialized ?? null,
      accountReadCompletedMs: phases['account-read'] ?? null, quotaReadCompletedMs: phases['quota-read'] ?? null,
      shutdownMs: phases['quota-read'] !== undefined && processStoppedAt !== null ? processStoppedAt - phases['quota-read'] : null,
      childLifetimeMs },
    processExitConfirmed: processStoppedAt !== null, processStillAlive, memory, fixtureResources };
}

async function main(args = process.argv.slice(2)) {
  const options = optionsFromArgs(args);
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-quota-benchmark-'));
  const results = [];
  try {
    for (let iteration = 1; iteration <= options.iterations; iteration++) {
      for (const scenario of options.real ? ['success'] : ['success', 'error', 'timeout', 'cancel']) {
        results.push(await runScenario(options, scenario, iteration, directory));
      }
    }
    const report = { schemaVersion: 1, mode: options.real ? 'real-opt-in' : 'synthetic',
      generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch,
      sampleIntervalMs: options.sampleMs, iterations: options.iterations,
      notes: [
        'Measurements cover only the directly spawned child; descendants and sampler overhead are excluded.',
        'Sampled RSS peak and arithmetic sample mean can miss allocation spikes and startup/shutdown intervals.',
        '900-second cycle mean is an estimate from sample mean times child lifetime, not a continuously observed measurement.',
        'CPU at last sample is partial lifetime CPU. Self-reported final CPU is available only for synthetic fixtures.',
        'Repeated iterations do not prove cold/warm filesystem or authentication cache conditions.',
      ], results };
    await mkdir(dirname(options.output), { recursive: true });
    await writeFile(options.output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    if (results.some(result => !result.matchedExpectedOutcome || !result.processExitConfirmed || result.processStillAlive !== false || !result.memory.samplerExitConfirmed)) process.exitCode = 1;
    return report;
  } finally {
    // Delete only this invocation's mkdtemp result, never a configured CODEX_HOME.
    if (dirname(directory) !== resolve(tmpdir()) || !basename(directory).startsWith('agent-tracker-quota-benchmark-')) throw new Error('Unexpected temporary directory.');
    await rm(directory, { recursive: true, force: true });
  }
}

if (require.main === module) main().catch(() => {
  console.error('Quota benchmark could not complete. Build first and check the options in docs/QuotaBenchmark.md.');
  process.exitCode = 1;
});
module.exports = { optionsFromArgs, summarizeSamples, main };
