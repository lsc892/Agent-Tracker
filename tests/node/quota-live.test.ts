import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseClaudeQuota, parseCodexQuota, type QuotaSnapshot, type QuotaWindow } from '../../src/quota';
import { statusBarPresentation } from '../../src/ui/statusBarPresentation';

type Expected = { provider: 'codex' | 'claude'; windows: Array<Pick<QuotaWindow, 'id' | 'usedPercent' | 'resetsAt' | 'windowDurationMins' | 'limitId'>>;
  rateLimitResetCredits?: QuotaSnapshot['rateLimitResetCredits'] };
type Result = { provider: string; passed: boolean; error?: { code: string; retryAfterMs?: number };
  processExitConfirmed?: boolean; httpStatuses?: number[]; phases?: string[]; windows?: Expected['windows'] };
const qa = require(resolve(__dirname, '../../../tools/quota/live-qa.cjs')) as {
  optionsFromArgs(args: string[]): { real: boolean; providers: string[]; timeoutMs: number };
  readClaude(options: object, signal: AbortSignal, dependencies?: object): Promise<Result>;
  readCodex(options: object, signal: AbortSignal, directory: string, dependencies?: object): Promise<Result>;
  runQa(options: object, dependencies?: object): Promise<{ passed: boolean; results: Result[] }>;
};
const contract = require(resolve(__dirname, '../../../tools/quota/contract.cjs')) as {
  expectedClaude(value: unknown): Expected;
  expectedCodex(value: unknown): Expected;
  compareSnapshot(snapshot: QuotaSnapshot, expected: Expected): void;
  checkPresentation(snapshot: QuotaSnapshot, expected: Expected, present: typeof statusBarPresentation): object;
};
const signal = () => new AbortController().signal;
const fixture = resolve(__dirname, '../../../tests/fixtures/quota-app-server.cjs');

test('live quota CLI requires real opt-in and validates provider and timeout options', () => {
  assert.throws(() => qa.optionsFromArgs([]), { code: 'real-opt-in-required' });
  assert.throws(() => qa.optionsFromArgs(['--real=false']), { code: 'invalid-options' });
  assert.throws(() => qa.optionsFromArgs(['--real', '--provider=unknown']), { code: 'invalid-options' });
  assert.throws(() => qa.optionsFromArgs(['--real', '--timeout-ms=NaN']), { code: 'invalid-options' });
  assert.deepEqual(qa.optionsFromArgs(['--real']).providers, ['codex', 'claude']);
  assert.deepEqual(qa.optionsFromArgs(['--real', '--provider=claude']).providers, ['claude']);
});

test('independent Claude oracle catches wrong percentages, reset units and omitted windows', () => {
  const raw = { five_hour: { utilization: 23.6, resets_at: '2026-10-08T12:34:56+09:00' },
    seven_day: { utilization: 110, resets_at: null }, ignored: { email: 'private-canary' } };
  const expected = contract.expectedClaude(raw);
  const snapshot = parseClaudeQuota(raw, 1000);
  assert.equal(expected.windows[0].resetsAt, Date.UTC(2026, 9, 8, 3, 34, 56));
  contract.compareSnapshot(snapshot, expected);
  assert.deepEqual(contract.checkPresentation(snapshot, expected, statusBarPresentation), {
    'detailed-used': [100, 24], 'detailed-remaining': [0, 76], 'compact-used': [24], 'compact-remaining': [76],
  });
  for (const field of ['usedPercent', 'resetsAt', 'current', 'maximum']) {
    const wrong = structuredClone(snapshot);
    Object.assign(wrong.windows[0], { [field]: 123 });
    assert.throws(() => contract.compareSnapshot(wrong, expected), { code: 'snapshot-mismatch' });
  }
  assert.throws(() => contract.compareSnapshot({ ...snapshot, windows: snapshot.windows.slice(0, 1) }, expected), { code: 'snapshot-mismatch' });
  assert.throws(() => contract.checkPresentation(snapshot, expected, () => ({ text: '99% 사용', accessibleText: '' })), { code: 'presentation-mismatch' });
});

test('Codex oracle prefers the authoritative map and compares seconds and reset credit expiry', () => {
  const window = { usedPercent: 42.5, resetsAt: 1700000000, windowDurationMins: 300 };
  const raw = { rateLimits: { primary: { ...window, usedPercent: 99 } },
    rateLimitsByLimitId: { codex: { primary: window, secondary: { ...window, usedPercent: 12, windowDurationMins: 10080 } },
      other: { limitId: 'other', primary: { ...window, usedPercent: 50, windowDurationMins: 60 } } },
    rateLimitResetCredits: { availableCount: 7, credits: [
      { status: 'available', resetType: 'codexRateLimits', expiresAt: 1700600000 },
      { status: 'used', resetType: 'codexRateLimits', expiresAt: 1600000000 },
      { status: 'available', resetType: 'codexRateLimits', expiresAt: 1700300000 },
    ] } };
  const expected = contract.expectedCodex(raw);
  const snapshot = parseCodexQuota(raw, 1000);
  assert.equal(expected.windows[0].usedPercent, 42.5);
  assert.equal(expected.windows[0].resetsAt, 1700000000000);
  assert.deepEqual(expected.rateLimitResetCredits, { availableCount: 7, nextExpiresAt: 1700300000000 });
  contract.compareSnapshot(snapshot, expected);
  contract.checkPresentation(snapshot, expected, statusBarPresentation);
  const wrong = structuredClone(snapshot);
  wrong.rateLimitResetCredits!.availableCount = 3;
  assert.throws(() => contract.compareSnapshot(wrong, expected), { code: 'snapshot-mismatch' });
  assert.throws(() => contract.expectedCodex({ ...raw, rateLimitsByLimitId: {} }), { code: 'reference-protocol' });
});

test('Claude QA uses the production read path, retries one 401, and excludes credentials and arbitrary response data', async () => {
  const refreshes: boolean[] = [];
  let calls = 0;
  const dependencies = { credentials: { async getAccessToken(refresh: boolean) { refreshes.push(refresh); return 'credential-private-canary'; } },
    fetch: async (_url: string, init: RequestInit) => {
      assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer credential-private-canary');
      if (++calls === 1) return new Response('body-private-canary', { status: 401 });
      return Response.json({ five_hour: { utilization: 25, resets_at: '2026-10-08T12:00:00Z' },
        account: { email: 'email-private-canary', accessToken: 'token-private-canary' } });
    } };
  const result = await qa.readClaude({ timeoutMs: 1000 }, signal(), dependencies);
  assert.equal(result.passed, true);
  assert.deepEqual(result.httpStatuses, [401, 200]);
  assert.deepEqual(refreshes, [false, true]);
  assert.doesNotMatch(JSON.stringify(result), /private-canary|Authorization|accessToken|email/);
});

test('Claude QA fails on 429, malformed responses, and bounded response overflow without retrying or leaking bodies', async () => {
  for (const [response, code, statuses] of [
    [new Response('server-private-canary', { status: 429, headers: { 'retry-after': '2' } }), 'rate-limit', [429]],
    [Response.json({ five_hour: { utilization: '25' }, email: 'private-canary' }), 'reference-protocol', [200]],
    [new Response('x'.repeat(1_048_577)), 'reference-protocol', [200]],
  ] as const) {
    let calls = 0;
    const result = await qa.readClaude({ timeoutMs: 1000 }, signal(), {
      credentials: { getAccessToken: async () => 'private-canary' }, fetch: async () => { calls++; return response; },
    });
    assert.equal(result.passed, false);
    assert.equal(result.error?.code, code);
    assert.deepEqual(result.httpStatuses, statuses);
    assert.equal(calls, 1);
    assert.doesNotMatch(JSON.stringify(result), /private-canary/);
    if (code === 'rate-limit') assert.equal(result.error?.retryAfterMs, 2000);
  }
});

test('Codex observer verifies actual provider RPC, values and both child exits with a local fixture', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-live-qa-'));
  try {
    const result = await qa.readCodex({ codexExecutable: process.execPath, codexHome: directory, timeoutMs: 5000 }, signal(), directory,
      { args: [fixture], env: { QUOTA_FIXTURE_MODE: 'notification' } });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.equal(result.windows?.[0].usedPercent, 43);
    assert.equal(result.processExitConfirmed, true);
    assert.deepEqual(result.phases, ['initialized', 'account-read', 'quota-read']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Codex observer reports timeout and verifies both child exits', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-live-timeout-'));
  try {
    const result = await qa.readCodex({ codexExecutable: process.execPath, codexHome: directory, timeoutMs: 500 }, signal(), directory,
      { args: [fixture], env: { QUOTA_FIXTURE_MODE: 'stall' } });
    assert.equal(result.passed, false);
    assert.equal(result.error?.code, 'timeout');
    assert.equal(result.processExitConfirmed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('overall QA attempts both providers, preserves failures and removes only its temporary evidence', async () => {
  const cache = resolve(__dirname, '../../../tests/.cache/quota-qa');
  const called: string[] = [];
  const options = qa.optionsFromArgs(['--real']);
  const report = await qa.runQa(options, {
    codex: async () => { called.push('codex'); return { provider: 'codex', passed: true }; },
    claude: async () => { called.push('claude'); throw new Error('credential-private-canary'); },
  });
  assert.equal(report.passed, false);
  assert.deepEqual(called, ['codex', 'claude']);
  assert.equal(report.results[1].error?.code, 'qa-error');
  assert.doesNotMatch(JSON.stringify(report), /private-canary/);
  assert.equal((await readdir(cache)).filter(name => name.startsWith('run-')).length, 0);
});
