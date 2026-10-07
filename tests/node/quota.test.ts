import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ClaudeCliCredentials, ClaudeQuotaProvider, CodexQuotaProvider, parseClaudeQuota,
  parseCodexQuota, parseRetryAfter, QuotaError, QuotaService,
  type QuotaClock, type QuotaProvider, type QuotaSnapshot } from '../../src/quota';

const signal = () => new AbortController().signal;
const snapshot = (now: number, used = 25): QuotaSnapshot => ({ provider: 'claude', fetchedAt: now,
  windows: [{ id: '5h', label: '5h', usedPercent: used, current: used, maximum: 100, resetsAt: now - 1, windowDurationMins: 300 }] });

class FakeClock implements QuotaClock {
  time = 1_000_000;
  serial = 0;
  tasks = new Map<number, { at: number; callback(): void }>();
  now = () => this.time;
  setTimeout(callback: () => void, delay: number): number {
    const id = ++this.serial;
    this.tasks.set(id, { at: this.time + delay, callback });
    return id;
  }
  clearTimeout(timer: unknown): void { this.tasks.delete(timer as number); }
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    for (let iteration = 0; iteration < 10_000; iteration++) {
      const task = [...this.tasks.entries()].filter(([, item]) => item.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!task) { this.time = end; await settle(); return; }
      this.tasks.delete(task[0]);
      this.time = task[1].at;
      task[1].callback();
      await settle();
    }
    throw new Error('Timer loop');
  }
}
async function settle(): Promise<void> { for (let i = 0; i < 8; i++) await Promise.resolve(); }
function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

test('manual refresh policy skips startup, focus and timers and can switch live', async () => {
  const clock = new FakeClock();
  let reads = 0;
  const service = new QuotaService([{id: 'claude', read: async () => { reads++; return snapshot(clock.now()); }}], {clock, refreshPolicy: 'manual'});
  try {
    service.start(); await settle();
    await clock.advance(3_600_000);
    service.setFocused(false); service.setFocused(true); await settle();
    await service.refresh('claude');
    assert.equal(reads, 0);
    await service.refresh('claude', true);
    assert.equal(reads, 1);
    assert.equal(clock.tasks.size, 0);
    service.setRefreshPolicy('automatic'); await settle();
    assert.equal(reads, 2);
    await clock.advance(900_000);
    assert.equal(reads, 3);
    service.setRefreshPolicy('manual');
    await clock.advance(3_600_000);
    assert.equal(reads, 3);
    assert.equal(clock.tasks.size, 0);
  } finally { await service.dispose(); }
});

test('both providers use common focused polling and live interval changes preserve focus debounce and minimum delay', async () => {
  const clock = new FakeClock();
  const reads = { claude: 0, codex: 0 };
  const service = new QuotaService((['claude', 'codex'] as const).map(id => ({
    id, read: async () => { reads[id]++; return { ...snapshot(clock.now()), provider: id }; },
  })), { clock });
  service.start();
  await settle();
  assert.deepEqual(reads, { claude: 1, codex: 1 });
  await clock.advance(299_000);
  service.setFocused(false); service.setFocused(true);
  await settle();
  assert.deepEqual(reads, { claude: 1, codex: 1 });
  await clock.advance(1000);
  service.setFocused(false); service.setFocused(true);
  await settle();
  assert.deepEqual(reads, { claude: 2, codex: 2 });
  await clock.advance(899_999);
  assert.deepEqual(reads, { claude: 2, codex: 2 });
  await clock.advance(1);
  assert.deepEqual(reads, { claude: 3, codex: 3 });
  service.setFocused(false);
  await clock.advance(3_600_000);
  assert.deepEqual(reads, { claude: 3, codex: 3 });
  service.setFocused(true);
  await settle();
  assert.deepEqual(reads, { claude: 4, codex: 4 });
  service.setPollingInterval(120);
  await clock.advance(119_999);
  assert.deepEqual(reads, { claude: 4, codex: 4 });
  await clock.advance(1);
  assert.deepEqual(reads, { claude: 5, codex: 5 });
  service.setPollingInterval(1);
  await clock.advance(29_999);
  assert.deepEqual(reads, { claude: 5, codex: 5 });
  await clock.advance(1);
  assert.deepEqual(reads, { claude: 6, codex: 6 });
  await service.dispose();
  assert.equal(clock.tasks.size, 0);
});

test('inactive activation defers first read until focus; automatic joins and manual clicks coalesce to one rerun', async () => {
  const first = deferred<QuotaSnapshot>();
  let reads = 0;
  const service = new QuotaService([{ id: 'claude', read: async () => ++reads === 1 ? first.promise : snapshot(Date.now(), 42) }]);
  service.start(false);
  await settle();
  assert.equal(reads, 0);
  service.setFocused(true);
  const joined = service.refresh('claude');
  // Include manual clicks before the initial provider invocation microtask.
  assert.equal(service.refresh('claude', true), joined);
  service.refresh('claude', true);
  service.refresh('claude', true);
  await settle();
  assert.equal(reads, 1);
  assert.equal(service.getState('claude').refreshing, true);
  first.resolve(snapshot(Date.now()));
  await joined;
  assert.equal(reads, 2);
  assert.equal(service.getState('claude').snapshot?.windows[0].usedPercent, 42);
  await service.dispose();
});

test('failed focus retries back off per provider; forced manual refresh bypasses Retry-After', async () => {
  const clock = new FakeClock();
  let reads = 0;
  const service = new QuotaService([{ id: 'claude', read: async () => { reads++; throw new QuotaError('network', 'network'); } }], { clock });
  service.start(); await settle();
  assert.equal(service.getState('claude').nextAllowedAt, clock.now() + 30_000);
  service.setFocused(false); service.setFocused(true); await settle();
  assert.equal(reads, 1);
  await clock.advance(30_000);
  service.setFocused(false); service.setFocused(true); await settle();
  assert.equal(reads, 2);
  assert.equal(service.getState('claude').nextAllowedAt, clock.now() + 60_000);
  await service.refresh('claude', true);
  assert.equal(reads, 3);
  assert.equal(service.getState('claude').nextAllowedAt, clock.now() + 120_000);
  await service.dispose();

  let limitedReads = 0;
  const limited = new QuotaService([{ id: 'claude', read: async () => { limitedReads++; throw new QuotaError('rate-limit', 'limited', 7_200_000); } }], { clock });
  limited.start(); await settle();
  await clock.advance(900_000);
  assert.equal(limitedReads, 1);
  await limited.refresh('claude', true);
  assert.equal(limitedReads, 2);
  await limited.dispose();
});

test('failed snapshots expire at 30 minutes or 24 hours, retain last success time, and never infer reset usage', async () => {
  for (const [code, ttl] of [['network', 1_800_000], ['authentication', 1_800_000], ['rate-limit', 86_400_000]] as const) {
    const clock = new FakeClock();
    let fail = false;
    const service = new QuotaService([{ id: 'claude', read: async () => {
      if (fail) throw new QuotaError(code, 'safe error');
      return snapshot(clock.now());
    } }], { clock });
    service.start(); await settle();
    const lastSuccess = clock.now();
    fail = true;
    await service.refresh('claude', true);
    service.setFocused(false);
    assert.equal(service.getState('claude').status, 'stale');
    await clock.advance(ttl - 1);
    assert.equal(service.getState('claude').snapshot?.windows[0].usedPercent, 25);
    await clock.advance(1);
    assert.equal(service.getState('claude').status, 'unavailable');
    assert.equal(service.getState('claude').snapshot, null);
    assert.equal(service.getState('claude').lastSuccessAt, lastSuccess);
    await service.dispose();
  }
});

test('switching to a non-subscription account invalidates the previous quota snapshot', async () => {
  const clock = new FakeClock();
  let changed = false;
  const service = new QuotaService([{ id: 'claude', read: async () => {
    if (changed) throw new QuotaError('unsupported-account', 'No subscription quota');
    return snapshot(clock.now());
  } }], { clock });
  service.start(); await settle();
  assert.equal(service.getState('claude').status, 'ready');
  changed = true;
  await service.refresh('claude', true);
  assert.equal(service.getState('claude').snapshot, null);
  assert.equal(service.getState('claude').lastSuccessAt, null);
  assert.equal(service.getState('claude').status, 'unavailable');
  await service.dispose();
});

test('long polling intervals respect the Node timer delay bound without refreshing early', async () => {
  const clock = new FakeClock();
  let reads = 0;
  const service = new QuotaService([{ id: 'claude', read: async () => { reads++; return snapshot(clock.now()); } }],
    { clock, pollingSeconds: 10_000_000 });
  service.start(); await settle();
  assert.equal([...clock.tasks.values()][0].at - clock.now(), 2_147_483_647);
  await clock.advance(2_147_483_647);
  assert.equal(reads, 1);
  assert.equal([...clock.tasks.values()][0].at - clock.now(), 2_147_483_647);
  await service.dispose();
});

test('notifications update immediately; listener failures do not affect cleanup; disposal cancels reads', async () => {
  let aborted = false;
  const provider: QuotaProvider = { id: 'claude', read: context => {
    context.onSnapshot?.(snapshot(Date.now(), 66));
    return new Promise((_resolve, reject) => context.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); }, { once: true }));
  } };
  const service = new QuotaService([provider]);
  const seen: number[] = [];
  service.subscribe(() => { throw new Error('UI failure'); });
  service.subscribe(states => { if (states[0].snapshot) seen.push(states[0].snapshot.windows[0].usedPercent); });
  service.start(); await settle();
  assert.ok(seen.includes(66));
  await service.dispose();
  assert.equal(aborted, true);
});

test('manual refresh affects only the chosen provider and a successful retry clears failure backoff', async () => {
  const clock = new FakeClock();
  let claudeReads = 0;
  let codexReads = 0;
  const service = new QuotaService([
    { id: 'claude', read: async () => { claudeReads++; if (claudeReads === 1) throw new QuotaError('network', 'failed'); return snapshot(clock.now()); } },
    { id: 'codex', read: async () => { codexReads++; return { ...snapshot(clock.now()), provider: 'codex' }; } },
  ], { clock });
  service.start(); await settle();
  await service.refresh('claude', true);
  assert.equal(claudeReads, 2);
  assert.equal(codexReads, 1);
  assert.equal(service.getState('claude').nextAllowedAt, 0);
  assert.equal(service.getState('claude').error, null);
  assert.equal(service.getState('claude').status, 'ready');
  const view = service.getState('claude');
  view.snapshot!.windows[0].usedPercent = 999;
  assert.equal(service.getState('claude').snapshot!.windows[0].usedPercent, 25);
  await service.dispose();
});

test('Claude parses all quota windows and reset timezones without inventing missing reset values', () => {
  const result = parseClaudeQuota({ five_hour: { utilization: 32, resets_at: '2026-10-03T15:00:00+09:00' },
    seven_day_sonnet: { utilization: 18, resets_at: null }, extra_usage: { is_enabled: false }, seven_day: null }, 1);
  assert.equal(result.windows[0].resetsAt, Date.parse('2026-10-03T06:00:00Z'));
  assert.equal(result.windows[1].label, '7d sonnet');
  assert.equal(result.windows[1].resetsAt, null);
  assert.throws(() => parseClaudeQuota({ five_hour: { utilization: '32' } }, 1), { code: 'protocol' });
  assert.throws(() => parseClaudeQuota({ future: [] }, 1), { code: 'unavailable' });
});

test('Claude re-reads credentials once on 401, does not expose response secrets, honors Retry-After', async () => {
  const refreshes: boolean[] = [];
  let requests = 0;
  const provider = new ClaudeQuotaProvider({ credentials: { getAccessToken: async refresh => { refreshes.push(refresh); return 'fixture-token'; } },
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
      requests++;
      return requests === 1 ? new Response('secret-body', { status: 401 }) : Response.json({ five_hour: { utilization: 5, resets_at: null } });
    } });
  assert.equal((await provider.read({ signal: signal() })).windows[0].usedPercent, 5);
  assert.deepEqual(refreshes, [false, true]);
  const unauthorized = new ClaudeQuotaProvider({ credentials: { getAccessToken: async () => 'secret' }, fetch: async () => new Response('secret', { status: 401 }) });
  await assert.rejects(unauthorized.read({ signal: signal() }), (error: unknown) => error instanceof QuotaError && error.code === 'authentication' && !error.message.includes('secret'));
  const limited = new ClaudeQuotaProvider({ credentials: { getAccessToken: async () => 'secret' }, fetch: async () => new Response('secret', { status: 429, headers: { 'Retry-After': '120' } }) });
  await assert.rejects(limited.read({ signal: signal() }), { code: 'rate-limit', retryAfterMs: 120_000 });
  assert.equal(parseRetryAfter('Sat, 03 Oct 2026 06:00:00 GMT', Date.parse('2026-10-03T05:59:00Z')), 60_000);
});

test('Claude HTTP status remains authoritative when cancelling an errored response body', async () => {
  const brokenResponse = (status: number) => new Response(new ReadableStream({
    start(controller) { controller.error(new Error('private-response-stream-error')); },
  }), { status, headers: { 'Retry-After': '45' } });
  const refreshes: boolean[] = [];
  let requests = 0;
  const credentials = { getAccessToken: async (refresh: boolean) => { refreshes.push(refresh); return 'synthetic-token'; } };
  const unauthorized = new ClaudeQuotaProvider({ credentials, fetch: async () => {
    requests++;
    return requests === 1 ? brokenResponse(401) : Response.json({ five_hour: { utilization: 5, resets_at: null } });
  } });
  assert.equal((await unauthorized.read({ signal: signal() })).windows[0].usedPercent, 5);
  assert.deepEqual(refreshes, [false, true]);
  const limited = new ClaudeQuotaProvider({ credentials, fetch: async () => brokenResponse(429) });
  await assert.rejects(limited.read({ signal: signal() }), { code: 'rate-limit', retryAfterMs: 45_000 });
});

test('Claude credentials use configured CLI home and report safe guidance for unreadable or malformed files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-quota-'));
  try {
    const credentials = new ClaudeCliCredentials(directory);
    await assert.rejects(credentials.getAccessToken(false, signal()), { code: 'authentication' });
    await writeFile(join(directory, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'synthetic-token' } }));
    assert.equal(await credentials.getAccessToken(false, signal()), 'synthetic-token');
    await writeFile(join(directory, '.credentials.json'), 'secret-malformed');
    await assert.rejects(credentials.getAccessToken(true, signal()), (error: unknown) => error instanceof QuotaError && !error.message.includes('secret'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Claude timeout and cancellation abort fetch, and oversized response is rejected', async () => {
  const credentials = { getAccessToken: async () => 'synthetic-token' };
  const fetcher: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('secret-network-details')), { once: true });
  });
  const timeoutProvider = new ClaudeQuotaProvider({ credentials, fetch: fetcher, timeoutMs: 20 });
  // Keep the test runtime alive while the production timeout intentionally uses unref().
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(timeoutProvider.read({ signal: signal() }), { code: 'timeout' }); }
  finally { clearTimeout(keepAlive); }
  const controller = new AbortController();
  const cancelProvider = new ClaudeQuotaProvider({ credentials, fetch: fetcher });
  const pending = cancelProvider.read({ signal: controller.signal });
  await settle();
  controller.abort();
  await assert.rejects(pending, { code: 'cancelled' });
  const oversized = new ClaudeQuotaProvider({ credentials, fetch: async () => new Response('x'.repeat(1_048_577)) });
  await assert.rejects(oversized.read({ signal: signal() }), { code: 'protocol' });
});

test('Codex prefers multi-bucket data, uses dynamic durations, seconds reset and authoritative empty map', () => {
  const bucket = (used: number, minutes: number) => ({ primary: { usedPercent: used, windowDurationMins: minutes, resetsAt: 1700000000 }, secondary: null });
  const result = parseCodexQuota({ rateLimits: bucket(99, 300), rateLimitsByLimitId: { codex: bucket(25, 90), other: bucket(42, 60) } }, 1);
  assert.deepEqual(result.windows.map(window => window.usedPercent), [25, 42]);
  assert.equal(result.windows[0].label, '90m');
  assert.equal(result.windows[1].label, 'other 1h');
  assert.equal(result.windows[0].resetsAt, 1700000000000);
  assert.throws(() => parseCodexQuota({ rateLimits: bucket(99, 300), rateLimitsByLimitId: {} }, 1), { code: 'unavailable' });
  assert.throws(() => parseCodexQuota({ rateLimits: bucket(99, 300), rateLimitsByLimitId: [] }, 1), { code: 'protocol' });
  assert.throws(() => parseCodexQuota({ rateLimits: { primary: { usedPercent: NaN } } }, 1), { code: 'protocol' });
});

test('Codex reset credits keep the authoritative count and earliest available credit expiry', () => {
  const rateLimits = { primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1700000000 } };
  const credit = (expiresAt: unknown, status = 'available', resetType = 'codexRateLimits') => ({ expiresAt, status, resetType });
  const result = parseCodexQuota({ rateLimits, rateLimitResetCredits: { availableCount: 7, credits: [
    credit(1700000900), credit(1700000300), credit(1700000001, 'redeemed'), credit(1700000002, 'available', 'unknown'), credit(null), credit('invalid'),
  ] } }, 1);
  assert.deepEqual(result.rateLimitResetCredits, { availableCount: 7, nextExpiresAt: 1700000300000 });
  for (const credits of [null, []]) {
    assert.deepEqual(parseCodexQuota({ rateLimits, rateLimitResetCredits: { availableCount: 2, credits } }, 1).rateLimitResetCredits,
      { availableCount: 2, nextExpiresAt: null });
  }
  assert.deepEqual(parseCodexQuota({ rateLimits, rateLimitResetCredits: { availableCount: 0, credits: [credit(1700000300)] } }, 1).rateLimitResetCredits,
    { availableCount: 0, nextExpiresAt: null });
  for (const summary of [undefined, null, {}, { availableCount: -1 }, { availableCount: 1.5 }, { availableCount: '2' }]) {
    const snapshot = parseCodexQuota({ rateLimits, rateLimitResetCredits: summary }, 1);
    assert.equal(snapshot.rateLimitResetCredits, undefined);
    assert.equal(snapshot.windows[0].usedPercent, 25, 'optional credit metadata never hides valid quota usage');
  }
});

const fixture = resolve('tests/fixtures/quota-app-server.cjs');
test('Codex short-lived subprocess handshakes, reads once, forwards notification, and confirms process exit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-tracker-quota-'));
  const log = join(directory, 'protocol.json');
  const events: string[] = [];
  const received: number[] = [];
  try {
    const provider = new CodexQuotaProvider({ executable: process.execPath, args: [fixture], dataHome: directory,
      env: { QUOTA_FIXTURE_MODE: 'notification', QUOTA_FIXTURE_LOG: log }, onLifecycle: event => events.push(event.event) });
    const result = await provider.read({ signal: signal(), onSnapshot: value => received.push(value.windows[0].usedPercent) });
    assert.equal(result.windows[0].usedPercent, 43);
    assert.deepEqual(result.rateLimitResetCredits, { availableCount: 2, nextExpiresAt: 1700600000000 });
    assert.deepEqual(received, [42]);
    assert.deepEqual(events, ['started', 'stopped']);
    const recorded = JSON.parse(await readFile(log, 'utf8')) as { methods: string[]; pid: number; dataHome: string };
    assert.deepEqual(recorded.methods, ['initialize', 'initialized', 'account/read', 'account/rateLimits/read']);
    assert.equal(recorded.dataHome, directory);
    assert.throws(() => process.kill(recorded.pid, 0));
    await provider.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const [mode, code] of [['api-key', 'unsupported-account'], ['logged-out', 'authentication'], ['rpc-error', 'rate-limit'],
  ['exit', 'process'], ['malformed', 'protocol'], ['oversize', 'protocol'], ['stall', 'timeout']] as const) {
  test(`Codex ${mode} rejects safely and reaps child`, async () => {
    let pid: number | undefined;
    const provider = new CodexQuotaProvider({ executable: process.execPath, args: [fixture], env: { QUOTA_FIXTURE_MODE: mode },
      timeoutMs: mode === 'stall' ? 250 : 5000, shutdownGraceMs: 50, onLifecycle: event => { if (event.event === 'started') pid = event.pid; } });
    await assert.rejects(provider.read({ signal: signal() }), (error: unknown) => error instanceof QuotaError && error.code === code && !error.message.includes('secret'));
    assert.ok(pid);
    assert.throws(() => process.kill(pid!, 0));
    await provider.dispose();
  });
}

test('Codex cancellation and provider disposal reap an in-flight process; stubborn shutdown escalates', async () => {
  for (const mode of ['cancel', 'dispose', 'ignore-end']) {
    let pid: number | undefined;
    const started = deferred<void>();
    const provider = new CodexQuotaProvider({ executable: process.execPath, args: [fixture],
      env: { QUOTA_FIXTURE_MODE: mode === 'ignore-end' ? mode : 'stall' }, shutdownGraceMs: 50,
      onLifecycle: event => { if (event.event === 'started') { pid = event.pid; started.resolve(); } } });
    const controller = new AbortController();
    const reading = provider.read({ signal: controller.signal });
    const outcome = mode === 'ignore-end' ? reading : assert.rejects(reading, { code: 'cancelled' });
    await started.promise;
    if (mode === 'cancel') controller.abort();
    if (mode === 'dispose') await provider.dispose();
    await outcome;
    assert.ok(pid);
    assert.throws(() => process.kill(pid!, 0));
    await provider.dispose();
  }
});

test('Codex cancellation after quota response still rejects and confirms process cleanup', async () => {
  const controller = new AbortController();
  let pid: number | undefined;
  let reachedQuota = false;
  const provider = new CodexQuotaProvider({ executable: process.execPath, args: [fixture],
    onLifecycle: event => { if (event.event === 'started') pid = event.pid; },
    onPhase: event => { if (event.phase === 'quota-read') { reachedQuota = true; controller.abort(); } },
  });
  try {
    await assert.rejects(provider.read({ signal: controller.signal }), { code: 'cancelled' });
    assert.equal(reachedQuota, true);
    assert.ok(pid);
    assert.throws(() => process.kill(pid!, 0));
  } finally { await provider.dispose(); }
});

test('Codex timeout includes waiting for a process that ignores graceful shutdown', async () => {
  let pid: number | undefined;
  let reachedQuota = false;
  const provider = new CodexQuotaProvider({ executable: process.execPath, args: [fixture],
    env: { QUOTA_FIXTURE_MODE: 'ignore-end' }, timeoutMs: 750, shutdownGraceMs: 1000,
    onLifecycle: event => { if (event.event === 'started') pid = event.pid; },
    onPhase: event => { if (event.phase === 'quota-read') reachedQuota = true; },
  });
  try {
    await assert.rejects(provider.read({ signal: signal() }), { code: 'timeout' });
    assert.equal(reachedQuota, true);
    assert.ok(pid);
    assert.throws(() => process.kill(pid!, 0));
  } finally { await provider.dispose(); }
});
