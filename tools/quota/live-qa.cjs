'use strict';

const { mkdir, mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { QaError, requireValue, expectedClaude, compareSnapshot, checkPresentation } = require('./contract.cjs');
const root = resolve(__dirname, '../..');

function optionsFromArgs(args) {
  const options = { real: false, providers: ['codex', 'claude'], timeoutMs: 15000,
    output: join(root, 'tests/results/quota-live.json') };
  for (const arg of args) {
    if (arg === '--real') { options.real = true; continue; }
    const match = /^--(provider|timeout-ms|output|codex-executable|codex-home|claude-home)=(.+)$/.exec(arg);
    if (!match) throw new QaError('invalid-options');
    const [, key, value] = match;
    if (key === 'provider') options.providers = value === 'both' ? ['codex', 'claude'] : [value];
    else if (key === 'timeout-ms') options.timeoutMs = Number(value);
    else if (key === 'output') options.output = resolve(value);
    else options[{ 'codex-executable': 'codexExecutable', 'codex-home': 'codexHome', 'claude-home': 'claudeHome' }[key]] = value;
  }
  requireValue(options.real, 'real-opt-in-required');
  requireValue(options.providers.every(id => ['codex', 'claude'].includes(id)), 'invalid-options');
  requireValue(Number.isInteger(options.timeoutMs) && options.timeoutMs >= 100 && options.timeoutMs <= 60000, 'invalid-options');
  return options;
}
async function boundedBody(response) {
  requireValue(response.body, 'reference-protocol');
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      requireValue(bytes <= 1_048_576, 'reference-protocol');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function safeError(error) {
  const codes = new Set(['authentication', 'unsupported-account', 'rate-limit', 'network', 'timeout', 'cancelled',
    'protocol', 'process', 'unavailable', 'reference-protocol', 'snapshot-mismatch', 'presentation-mismatch',
    'unexpected-rpc', 'process-exit-unconfirmed', 'missing-evidence']);
  return { code: codes.has(error?.code) ? error.code : 'qa-error',
    ...(Number.isFinite(error?.retryAfterMs) && error.retryAfterMs >= 0 ? { retryAfterMs: error.retryAfterMs } : {}) };
}
function verify(snapshot, expected) {
  const { statusBarPresentation } = require('../../dist/src/ui/statusBarPresentation');
  compareSnapshot(snapshot, expected);
  return { serverValuesMatch: true, presentation: checkPresentation(snapshot, expected, statusBarPresentation),
    windows: expected.windows.map(row => ({ ...row, remainingPercent: Math.max(0, Math.min(100, 100 - row.usedPercent)),
      ...(row.resetsAt !== null ? { resetsAtIso: new Date(row.resetsAt).toISOString() } : {}) })),
    ...(expected.rateLimitResetCredits ? { rateLimitResetCredits: expected.rateLimitResetCredits } : {}) };
}
async function readClaude(options, signal, dependencies = {}) {
  const { ClaudeQuotaProvider } = require('../../dist/src/quota');
  const statuses = [];
  let expected;
  let referenceError;
  const fetcher = dependencies.fetch ?? globalThis.fetch;
  const provider = new ClaudeQuotaProvider({ dataHome: options.claudeHome, timeoutMs: options.timeoutMs,
    ...(dependencies.credentials ? { credentials: dependencies.credentials } : {}),
    fetch: async (url, init) => {
      const response = await fetcher(url, init);
      statuses.push(response.status);
      if (!response.ok) return response;
      try {
        const body = await boundedBody(response);
        expected = expectedClaude(JSON.parse(body.toString('utf8')));
        return new Response(body, { status: response.status, headers: response.headers });
      } catch (error) {
        if (error instanceof QaError || error instanceof SyntaxError) referenceError = new QaError('reference-protocol');
        throw error;
      }
    },
  });
  const started = performance.now();
  let result;
  try {
    const snapshot = await provider.read({ signal });
    requireValue(expected, 'missing-evidence');
    result = { provider: 'claude', passed: true, ...verify(snapshot, expected) };
  } catch (error) { result = { provider: 'claude', passed: false, error: safeError(referenceError ?? error) }; }
  finally { provider.dispose(); }
  return { ...result, httpStatuses: statuses, elapsedMs: Math.round(performance.now() - started) };
}
function alive(pid) {
  if (!Number.isInteger(pid)) return null;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'ESRCH' ? false : null; }
}
async function readCodex(options, signal, directory, dependencies = {}) {
  const { CodexQuotaProvider, resolveCodexExecutable } = require('../../dist/src/quota');
  const evidencePath = join(directory, 'codex.json');
  const lifecycle = [];
  const phases = [];
  const started = performance.now();
  let provider;
  let snapshot;
  let failure;
  try {
    const env = { ...process.env, ...dependencies.env };
    const executable = await resolveCodexExecutable(options.codexExecutable || 'codex', env);
    provider = new CodexQuotaProvider({ executable: process.execPath,
      args: [join(__dirname, 'observe-codex.cjs'), executable, evidencePath, ...(dependencies.args ?? [])],
      env, dataHome: options.codexHome, timeoutMs: options.timeoutMs,
      onLifecycle: event => lifecycle.push({ event: event.event, pid: event.pid }),
      onPhase: event => phases.push(event.phase) });
    snapshot = await provider.read({ signal });
  } catch (error) { failure = safeError(error); }
  finally {
    try { await provider?.dispose(); }
    catch (error) { failure ??= safeError(error); }
  }
  let evidence;
  try { evidence = JSON.parse(await readFile(evidencePath, 'utf8')); }
  catch { /* Missing evidence is an explicit failure, never an implicit pass. */ }
  const proxyPid = lifecycle.find(event => event.event === 'started')?.pid;
  const processExitConfirmed = lifecycle.some(event => event.event === 'stopped') && alive(proxyPid) === false
    && evidence?.nativeExitConfirmed === true && alive(evidence.nativePid) === false;
  let result;
  try {
    if (failure) throw new QaError(failure.code);
    requireValue(processExitConfirmed, 'process-exit-unconfirmed');
    requireValue(evidence?.expected, 'missing-evidence');
    requireValue(!evidence.errorCode, evidence.errorCode || 'reference-protocol');
    requireValue(['chatgpt', 'chatgptAuthTokens'].includes(evidence.accountType), 'unsupported-account');
    requireValue(JSON.stringify(evidence.methods) === JSON.stringify(['initialize', 'initialized', 'account/read', 'account/rateLimits/read']), 'unexpected-rpc');
    requireValue(JSON.stringify(phases) === JSON.stringify(['initialized', 'account-read', 'quota-read']), 'unexpected-rpc');
    result = { provider: 'codex', passed: true, ...verify(snapshot, evidence.expected) };
  } catch (error) { result = { provider: 'codex', passed: false, error: failure ?? safeError(error) }; }
  return { ...result, processExitConfirmed, phases, elapsedMs: Math.round(performance.now() - started) };
}
async function runQa(options, dependencies = {}) {
  requireValue(options.real, 'real-opt-in-required');
  const signal = dependencies.signal ?? new AbortController().signal;
  const cache = join(root, 'tests/.cache/quota-qa');
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, 'run-'));
  try {
    const results = [];
    for (const id of options.providers) {
      const read = dependencies[id] ?? (id === 'codex' ? readCodex : (options, signal) => readClaude(options, signal));
      try { results.push(await read(options, signal, directory)); }
      catch (error) { results.push({ provider: id, passed: false, error: safeError(error) }); }
    }
    return { schemaVersion: 1, mode: 'real-account', generatedAt: new Date().toISOString(),
      passed: results.length === options.providers.length && results.every(row => row.passed),
      scope: 'Same-response server fields, production quota providers and status-bar formatting; installed VS Code UI is not observed.', results };
  } finally {
    // Only this mkdtemp directory is removed; CLI data homes and login files are preserved.
    await rm(directory, { recursive: true, force: true });
  }
}
async function main(args = process.argv.slice(2)) {
  const options = optionsFromArgs(args);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    const report = await runQa(options, { signal: controller.signal });
    await mkdir(resolve(options.output, '..'), { recursive: true });
    await writeFile(options.output, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    for (const row of report.results) {
      console.log(`${row.provider}: ${row.passed ? 'PASS' : `FAIL (${row.error.code})`} ${row.elapsedMs ?? 0}ms`);
      for (const window of row.windows ?? []) console.log(`  ${window.id}: used=${window.usedPercent}% remaining=${window.remainingPercent}% reset=${window.resetsAtIso ?? 'unknown'}`);
      if (row.error?.retryAfterMs != null) console.log(`  retry-after=${row.error.retryAfterMs}ms`);
    }
    console.log(`Report: ${options.output}`);
    process.exitCode = report.passed ? 0 : 1;
    return report;
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
if (require.main === module) main().catch(() => { console.error('Quota QA could not complete. Check options, build output and report permissions.'); process.exitCode = 1; });
module.exports = { optionsFromArgs, boundedBody, safeError, readClaude, readCodex, runQa, main };
