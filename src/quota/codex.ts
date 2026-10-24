import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, delimiter } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { performance } from 'node:perf_hooks';
import { BaseQuotaProvider } from './base';
import { asRecord, durationLabel, QuotaError, type QuotaReadContext, type QuotaSnapshot, type QuotaWindow } from './types';

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

/**
 * 책임: 대화 생성 없이 Codex 계정의 구독 quota만 조회한다.
 * 알고리즘: 조회마다 짧게 실행한 App Server에서 초기화·계정 확인·한도 조회를 순서대로 수행하고 프로세스 종료까지 기다린다.
 */
export class CodexQuotaProvider extends BaseQuotaProvider {
  readonly id = 'codex' as const;
  protected readonly closedMessage = { key: 'quota.codexClosed' } as const;

  constructor(private readonly options: CodexQuotaProviderOptions = {}) {
    super();
  }

  /**
   * 책임: Codex quota 조회 한 번의 통신·시간 제한·프로세스 회수를 수행한다.
   * 알고리즘: 초기화와 구독 계정 확인 뒤 한도를 읽고 계정 확인 이후의 갱신 알림만 전달하며, 성공 응답 후에도 종료 중 취소·시간 초과를 확인한다.
   */
  protected async readQuota(context: QuotaReadContext): Promise<QuotaSnapshot> {
    const controller = new AbortController();
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
      this.ensureSupportedAccount(accountResult);
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
      }
    }
  }

  /** 로그인 상태와 구독 계정 유형을 확인한 뒤에만 quota 조회·알림을 허용한다. */
  private ensureSupportedAccount(accountResult: Record<string, unknown> | null): void {
    const account = asRecord(accountResult?.account);
    if (!account) throw new QuotaError('authentication', { key: 'quota.codexLoginRequired' });
    if (account.type !== 'chatgpt' && account.type !== 'chatgptAuthTokens') {
      throw new QuotaError('unsupported-account', { key: 'quota.codexUnsupportedAccount' });
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

/**
 * 책임: 한 App Server 프로세스의 JSON-RPC 연결과 요청 수명을 소유한다.
 * 알고리즘: 요청 ID별 Promise와 UTF-8 행 버퍼로 응답·알림을 분배하고, 실패 시 대기 요청을 함께 거절한다.
 */
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

  /**
   * 책임: 정상 종료·취소·실패 모두에서 자식 프로세스를 회수한다.
   * 알고리즘: 입력을 닫고 종료를 기다린 뒤 유예 시간을 넘으면 SIGTERM·SIGKILL 순으로 종료를 강화하고 스트림을 해제한다.
   */
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

  /**
   * 책임: stdout 청크를 크기가 제한된 JSON-RPC 메시지로 복원한다.
   * 알고리즘: UTF-8 decoder로 분할 문자를 이어 붙이고 개행마다 JSON을 해석하며, 행 또는 미완성 버퍼가 상한을 넘으면 실패시킨다.
   */
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

  /**
   * 책임: RPC 응답과 서버 알림을 올바른 소비자에게 전달한다.
   * 알고리즘: ID로 대기 요청을 찾고 상태 코드를 공통 오류로 변환하며, 한도 갱신 알림만 허용하고 서버 실행 요청은 거부한다.
   */
  private receive(value: unknown): void {
    const message = asRecord(value);
    if (!message) throw protocolError();
    if (typeof message.method === 'string') {
      this.handleServerMessage(message);
      return;
    }
    this.handleResponse(message);
  }

  /** 서버 실행 요청은 거부하고 quota 갱신 알림만 전달한다. */
  private handleServerMessage(message: Record<string, unknown>): void {
    if (message.id !== undefined) {
      // A quota read never accepts server-initiated tool execution or login requests.
      this.write({ id: message.id, error: { code: -32601, message: 'Unsupported client method' } });
      return;
    }
    if (message.method === 'account/rateLimits/updated') this.onSnapshot(message.params);
  }

  /** 일치하는 대기 요청을 제거하고 응답 결과 또는 분류한 오류로 완료한다. */
  private handleResponse(message: Record<string, unknown>): void {
    if (typeof message.id !== 'number') return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    const error = asRecord(message.error);
    if (error) {
      pending.reject(this.parseResponseError(error));
      return;
    }
    if ('result' in message) {
      pending.resolve(message.result);
      return;
    }
    pending.reject(protocolError());
  }

  /** RPC 오류의 상태 코드만 해석하며 서버 오류 본문은 노출하지 않는다. */
  private parseResponseError(error: Record<string, unknown>): QuotaError {
    const data = asRecord(error.data);
    const status = data?.statusCode ?? data?.status ?? error.code;
    switch (status) {
      case 429:
        return new QuotaError('rate-limit', { key: 'quota.codexRateLimited' });
      case 401:
      case 403:
        return new QuotaError('authentication', { key: 'quota.codexSignInAgain' });
      default:
        return new QuotaError('protocol', { key: 'quota.codexRequestFailed' });
    }
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

/**
 * 책임: Codex의 단일·다중 한도 응답을 공통 quota 창으로 변환한다.
 * 알고리즘: 명시된 한도 맵을 우선해 각 primary·secondary를 검증하고 초기화 초를 밀리초로 바꾸며 reset credit을 별도 해석한다.
 */
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
      const window = parseCodexQuotaWindow(bucket[windowId], windowId);
      if (!window) continue;
      windows.push({ ...window, id: `${limitId}:${windowId}`, limitId,
        ...(limitName ? { limitName } : {}),
        label: buckets.length === 1 || limitId === 'codex' ? window.label : `${limitName || limitId} ${window.label}`,
        ...(typeof bucket.rateLimitReachedType === 'string' ? { rateLimitReachedType: bucket.rateLimitReachedType.slice(0, 100) } : {}),
      });
    }
  }
  if (windows.length === 0) throw new QuotaError('unavailable', { key: 'quota.codexUnavailable' });
  const rateLimitResetCredits = parseResetCredits(result.rateLimitResetCredits);
  return { provider: 'codex', fetchedAt, windows, ...(rateLimitResetCredits ? { rateLimitResetCredits } : {}) };
}

/** 창 하나의 사용률·기간·초기화 초를 검증하고 공통 quota 창으로 변환한다. */
function parseCodexQuotaWindow(value: unknown, windowId: string): QuotaWindow | null {
  if (value == null) return null;
  const window = asRecord(value);
  if (!window || typeof window.usedPercent !== 'number' || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) throw protocolError();
  const mins = window.windowDurationMins;
  if (mins != null && (typeof mins !== 'number' || !Number.isFinite(mins) || mins <= 0)) throw protocolError();
  const reset = window.resetsAt;
  if (reset != null && (typeof reset !== 'number' || !Number.isFinite(reset) || Math.abs(reset) > 8.64e12)) throw protocolError();
  const duration = typeof mins === 'number' ? mins : null;
  return { id: windowId, label: durationLabel(duration, windowId),
    usedPercent: window.usedPercent, current: window.usedPercent, maximum: 100,
    resetsAt: typeof reset === 'number' ? reset * 1000 : null, windowDurationMins: duration };
}

/**
 * 책임: 초기화 크레딧의 서버 기준 개수와 가장 이른 만료 시각을 보존한다.
 * 알고리즘: availableCount를 개수로 사용하고 사용 가능한 Codex 크레딧만 순회해 유효한 만료 시각의 최솟값을 구한다.
 */
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

/**
 * 책임: Windows에서도 셸 실행 없이 Codex의 실제 실행 파일을 찾는다.
 * 알고리즘: 지정 경로 또는 PATH를 순회하고 공식 npm shim이면 아키텍처별 패키지의 codex.exe 후보로 해석한다.
 */
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
