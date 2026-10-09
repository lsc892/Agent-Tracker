import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, delimiter } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { asRecord, durationLabel, QuotaError, type QuotaProvider, type QuotaReadContext, type QuotaSnapshot, type QuotaWindow } from './types';

export interface CodexQuotaProviderOptions {
  dataHome?: string;
  executable?: string;
  /** Prefix arguments allow a test process or an explicitly configured CLI launcher. */
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  shutdownGraceMs?: number;
  now?: () => number;
  onLifecycle?: (event: { event: 'started' | 'stopped'; pid: number | undefined; elapsedMs: number }) => void;
  onPhase?: (event: { phase: 'initialized' | 'account-read' | 'quota-read'; pid: number | undefined; elapsedMs: number }) => void;
}

/** No thread or turn methods are sent; every read owns one short-lived process. */
export class CodexQuotaProvider implements QuotaProvider {
  readonly id = 'codex' as const;
  private readonly active = new Set<AbortController>();
  private readonly reads = new Set<Promise<QuotaSnapshot>>();
  private disposed = false;
  constructor(private readonly options: CodexQuotaProviderOptions = {}) {}

  read(context: QuotaReadContext): Promise<QuotaSnapshot> {
    if (this.disposed) return Promise.reject(new QuotaError('cancelled', { key: 'quota.codexClosed' }));
    const promise = this.readOnce(context);
    this.reads.add(promise);
    void promise.finally(() => this.reads.delete(promise)).catch(() => {});
    return promise;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    for (const controller of this.active) controller.abort();
    await Promise.allSettled(this.reads);
  }

  private async readOnce(context: QuotaReadContext): Promise<QuotaSnapshot> {
    const controller = new AbortController();
    this.active.add(controller);
    const signal = AbortSignal.any([controller.signal, context.signal]);
    const now = this.options.now ?? Date.now;
    const startedAt = performance.now();
    let session: RpcSession | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let canNotify = false;
    try {
      if (signal.aborted) throw cancelled();
      const env = { ...process.env, ...this.options.env,
        CODEX_HOME: this.options.dataHome || this.options.env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex') };
      const executable = await resolveCodexExecutable(this.options.executable || 'codex', env);
      if (signal.aborted) throw cancelled();
      const child = spawn(executable, [...(this.options.args ?? []), 'app-server'], {
        stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env,
        // Avoid repository-owned project configuration when reading account quota.
        cwd: homedir(),
      });
      this.lifecycle('started', child.pid, performance.now() - startedAt);
      session = new RpcSession(child, signal, this.options.shutdownGraceMs ?? 500, value => {
        if (!canNotify || signal.aborted) return;
        const snapshot = parseCodexQuota(value, now());
        context.onSnapshot?.(snapshot);
      });
      timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs ?? 15_000);
      timeout.unref?.();
      await session.request('initialize', { clientInfo: { name: 'agent_tracker', title: 'Agent Tracker', version: '0.1.0' }, capabilities: null });
      session.notify('initialized', {});
      this.phase('initialized', child.pid, performance.now() - startedAt);
      const accountResult = asRecord(await session.request('account/read', { refreshToken: false }));
      this.phase('account-read', child.pid, performance.now() - startedAt);
      const account = asRecord(accountResult?.account);
      if (!account) throw new QuotaError('authentication', { key: 'quota.codexLoginRequired' });
      if (account.type !== 'chatgpt' && account.type !== 'chatgptAuthTokens') {
        throw new QuotaError('unsupported-account', { key: 'quota.codexUnsupportedAccount' });
      }
      canNotify = true;
      const result = await session.request('account/rateLimits/read');
      const snapshot = parseCodexQuota(result, now());
      this.phase('quota-read', child.pid, performance.now() - startedAt);
      // Shutdown is part of success: failures to reap the child must be reported.
      await session.close();
      // Cancellation or timeout may arrive after the response, while close() reaps the child.
      if (signal.aborted) throw cancelled();
      return snapshot;
    } catch (error) {
      if (timedOut) throw new QuotaError('timeout', { key: 'quota.codexTimeout' });
      if (signal.aborted) throw cancelled();
      if (error instanceof QuotaError) throw error;
      throw new QuotaError('process', { key: 'quota.codexLaunchFailed' });
    } finally {
      if (timeout) clearTimeout(timeout);
      canNotify = false;
      try { await session?.close(); }
      finally {
        if (session?.hasExited) this.lifecycle('stopped', session.child.pid, performance.now() - startedAt);
        this.active.delete(controller);
      }
    }
  }

  private lifecycle(event: 'started' | 'stopped', pid: number | undefined, elapsedMs: number): void {
    try { this.options.onLifecycle?.({ event, pid, elapsedMs }); } catch { /* Diagnostic callbacks cannot own lifecycle. */ }
  }
  private phase(phase: 'initialized' | 'account-read' | 'quota-read', pid: number | undefined, elapsedMs: number): void {
    try { this.options.onPhase?.({ phase, pid, elapsedMs }); } catch { /* Metrics cannot interrupt the protocol. */ }
  }
}

type Pending = { resolve(value: unknown): void; reject(reason: QuotaError): void };

class RpcSession {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly decoder = new StringDecoder('utf8');
  private buffered = '';
  private failure: QuotaError | null = null;
  private closing = false;
  private closed = false;
  private readonly exited: Promise<void>;
  private closePromise?: Promise<void>;
  private readonly abort: () => void;

  get hasExited(): boolean { return this.closed; }

  constructor(readonly child: ChildProcessWithoutNullStreams, private readonly signal: AbortSignal,
    private readonly graceMs: number, private readonly onSnapshot: (value: unknown) => void) {
    this.exited = new Promise(resolve => {
      child.once('close', (code, exitSignal) => {
        this.closed = true;
        if (!this.closing || (code !== 0 && exitSignal === null)) {
          this.fail(new QuotaError('process', { key: 'quota.codexServerExited' }));
        }
        resolve();
      });
    });
    child.on('error', () => this.fail(new QuotaError('process', { key: 'quota.codexServerStartFailed' })));
    child.stdin.on('error', () => this.fail(new QuotaError('process', { key: 'quota.codexCommunicationClosed' })));
    child.stdout.on('error', () => this.fail(new QuotaError('process', { key: 'quota.codexReadFailed' })));
    child.stderr.on('error', () => {});
    // Drain stderr without retaining arbitrary CLI diagnostics (which can contain secrets).
    child.stderr.resume();
    child.stdout.on('data', (chunk: Buffer) => this.consume(chunk));
    this.abort = () => this.fail(cancelled());
    signal.addEventListener('abort', this.abort, { once: true });
    if (signal.aborted) this.abort();
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closed || this.closing) return Promise.reject(new QuotaError('process', { key: 'quota.codexConnectionClosed' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params: unknown): void {
    if (this.failure) throw this.failure;
    this.write({ method, params });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    this.signal.removeEventListener('abort', this.abort);
    this.rejectPending(cancelled());
    this.child.stdin.end();
    try {
      if (!(await this.waitExit(this.graceMs))) {
        this.child.kill('SIGTERM');
        if (!(await this.waitExit(this.graceMs))) {
          this.child.kill('SIGKILL');
          if (!(await this.waitExit(Math.max(1000, this.graceMs)))) {
            throw new QuotaError('process', { key: 'quota.codexStopFailed' });
          }
        }
      }
      if (this.failure && this.failure.code !== 'cancelled') throw this.failure;
    } finally {
      this.buffered = '';
      this.child.stdin.destroy();
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    }
  }

  private async waitExit(ms: number): Promise<boolean> {
    if (this.closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([this.exited.then(() => true), new Promise<boolean>(resolve => {
        timer = setTimeout(() => resolve(false), Math.max(1, ms));
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }

  private consume(chunk: Buffer): void {
    if (this.closing || this.failure) return;
    this.buffered += this.decoder.write(chunk);
    while (true) {
      const newline = this.buffered.indexOf('\n');
      if (newline < 0) break;
      if (newline > 1_048_576) { this.fail(protocolError()); return; }
      const line = this.buffered.slice(0, newline).trim();
      this.buffered = this.buffered.slice(newline + 1);
      if (!line) continue;
      try { this.receive(JSON.parse(line)); }
      catch { this.fail(protocolError()); return; }
    }
    if (this.buffered.length > 1_048_576) this.fail(protocolError());
  }

  private receive(value: unknown): void {
    const message = asRecord(value);
    if (!message) throw protocolError();
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        // A quota read never accepts server-initiated tool execution or login requests.
        this.write({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } });
      } else if (message.method === 'account/rateLimits/updated') {
        this.onSnapshot(message.params);
      }
      return;
    }
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    const error = asRecord(message.error);
    if (error) {
      const data = asRecord(error.data);
      const status = data?.statusCode ?? data?.status ?? error.code;
      if (status === 429) pending.reject(new QuotaError('rate-limit', { key: 'quota.codexRateLimited' }));
      else if (status === 401 || status === 403) pending.reject(new QuotaError('authentication', { key: 'quota.codexSignInAgain' }));
      else pending.reject(new QuotaError('protocol', { key: 'quota.codexRequestFailed' }));
    } else if ('result' in message) pending.resolve(message.result);
    else pending.reject(protocolError());
  }

  private write(message: unknown): void {
    try { this.child.stdin.write(`${JSON.stringify(message)}\n`); }
    catch { this.fail(new QuotaError('process', { key: 'quota.codexSendFailed' })); }
  }
  private fail(error: QuotaError): void {
    this.failure ??= error;
    this.rejectPending(this.failure);
  }
  private rejectPending(error: QuotaError): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}

export function parseCodexQuota(value: unknown, fetchedAt: number): QuotaSnapshot {
  const result = asRecord(value);
  if (!result) throw protocolError();
  const byLimit = asRecord(result.rateLimitsByLimitId);
  if (result.rateLimitsByLimitId != null && !byLimit) throw protocolError();
  // An explicitly present empty map is authoritative, not a reason to use stale fallback data.
  const buckets = byLimit ? Object.entries(byLimit) : [['codex', result.rateLimits] as const];
  const windows: QuotaWindow[] = [];
  for (const [key, raw] of buckets) {
    const bucket = asRecord(raw);
    if (!bucket) throw protocolError();
    const limitId = typeof bucket.limitId === 'string' ? bucket.limitId.slice(0, 100) : key.slice(0, 100);
    const limitName = typeof bucket.limitName === 'string' && bucket.limitName ? bucket.limitName.slice(0, 100) : undefined;
    for (const windowId of ['primary', 'secondary'] as const) {
      if (bucket[windowId] == null) continue;
      const window = asRecord(bucket[windowId]);
      if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) throw protocolError();
      const mins = window.windowDurationMins;
      if (mins != null && (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0)) throw protocolError();
      const reset = window.resetsAt;
      if (reset != null && (typeof reset !== 'number' || !Number.isFinite(reset) || Math.abs(reset) > 8.64e12)) throw protocolError();
      const duration = typeof mins === 'number' ? mins : null;
      const durationText = durationLabel(duration, windowId);
      windows.push({ id: `${limitId}:${windowId}`, limitId,
        ...(limitName ? { limitName } : {}),
        label: buckets.length === 1 || limitId === 'codex' ? durationText : `${limitName || limitId} ${durationText}`,
        usedPercent: window.usedPercent, current: window.usedPercent, maximum: 100,
        resetsAt: typeof reset === 'number' ? reset * 1000 : null, windowDurationMins: duration,
        ...(typeof bucket.rateLimitReachedType === 'string' ? { rateLimitReachedType: bucket.rateLimitReachedType.slice(0, 100) } : {}),
      });
      if (windows.length > 100) throw protocolError();
    }
  }
  if (windows.length === 0) throw new QuotaError('unavailable', { key: 'quota.codexUnavailable' });
  const rateLimitResetCredits = parseResetCredits(result.rateLimitResetCredits);
  return { provider: 'codex', fetchedAt, windows, ...(rateLimitResetCredits ? { rateLimitResetCredits } : {}) };
}

function parseResetCredits(value: unknown): QuotaSnapshot['rateLimitResetCredits'] {
  const summary = asRecord(value);
  const count = summary?.availableCount;
  // The backend may cap detail rows; their length is never the available reset count.
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return undefined;
  let nextExpiresAt: number | null = null;
  if (count > 0 && Array.isArray(summary?.credits)) {
    for (const raw of summary.credits) {
      const credit = asRecord(raw);
      if (credit?.status !== 'available' || credit.resetType !== 'codexRateLimits') continue;
      const expiresAt = credit.expiresAt;
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < 0 || expiresAt > 8.64e12) continue;
      const timestamp = expiresAt * 1000;
      if (nextExpiresAt === null || timestamp < nextExpiresAt) nextExpiresAt = timestamp;
    }
  }
  return { availableCount: count, nextExpiresAt };
}

function protocolError(): QuotaError { return new QuotaError('protocol', { key: 'quota.codexUnsupportedResponse' }); }
function cancelled(): QuotaError { return new QuotaError('cancelled', { key: 'quota.codexCancelled' }); }

/** Resolve npm's Windows .cmd shim to its native executable without spawning a shell. */
export async function resolveCodexExecutable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<string> {
  if (process.platform !== 'win32') return command;
  const hasDirectory = isAbsolute(command) || command.includes('/') || command.includes('\\');
  const paths = hasDirectory ? [command] : (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean)
    .flatMap(dir => /\.(exe|cmd|ps1)$/i.test(command) ? [join(dir, command)] : [join(dir, `${command}.exe`), join(dir, `${command}.cmd`), join(dir, command)]);
  for (const candidate of paths) {
    if (!(await exists(candidate))) continue;
    if (!/\.(cmd|ps1)$/i.test(candidate)) return candidate;
    if (!/^codex\.(cmd|ps1)$/i.test(basename(candidate))) {
      throw new QuotaError('process', { key: 'quota.codexExeRequired' });
    }
    const bin = dirname(await realpath(candidate));
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
    const packageRoot = join(bin, 'node_modules', '@openai', 'codex');
    const nativeCandidates = [
      join(packageRoot, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
      join(bin, 'node_modules', '@openai', `codex-win32-${arch}`, 'vendor', triple, 'bin', 'codex.exe'),
      join(packageRoot, 'vendor', triple, 'bin', 'codex.exe'),
    ];
    for (const native of nativeCandidates) if (await exists(native)) return native;
  }
  throw new QuotaError('process', { key: 'quota.codexExeMissing' });
}

async function exists(path: string): Promise<boolean> { try { await access(path); return true; } catch { return false; } }
