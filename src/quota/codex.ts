// Codex App Server를 실행해 구독 quota를 조회하고 프로세스를 회수한다.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { extensionVersion } from '../version';
import { BaseQuotaProvider } from './base';
import { cancelled } from './codex/errors';
import { resolveCodexExecutable } from './codex/executable';
import { parseCodexQuota } from './codex/response';
import { RpcSession } from './codex/rpcSession';
import { asRecord, QuotaError, type QuotaReadContext, type QuotaSnapshot } from './types';

export { parseCodexQuota, resolveCodexExecutable };

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 500;

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

/** 대화 생성 없이 Codex 구독 quota를 조회하고 App Server의 실행 수명을 관리한다. */
export class CodexQuotaProvider extends BaseQuotaProvider {
  readonly id = 'codex' as const;
  protected readonly closedMessage = { key: 'quota.codexClosed' } as const;

  constructor(private readonly options: CodexQuotaProviderOptions = {}) {
    super();
  }

  /**
   * 책임: Codex quota 조회 단계와 오류·자원 정리의 순서를 조율한다.
   * 알고리즘: 세션 준비·초기화·계정 확인·한도 읽기·종료를 순서대로 수행하고, 조회별 시간 제한과 알림 허용 시점을 관리한다.
   */
  protected async readQuota(context: QuotaReadContext): Promise<QuotaSnapshot> {
    // [취소 정책] 호출자 취소와 자체 시간 제한을 하나의 신호로 묶는다.
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, context.signal]);
    const now = this.options.now ?? Date.now;
    const startedAt = performance.now();
    let session: RpcSession | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    let canNotify = false;
    try {
      // [실행 정책] 실행 파일을 확인해 App Server를 열고 세션 시간 제한을 시작한다.
      if (signal.aborted) throw cancelled();
      const env = this.createEnvironment();
      const executable = await resolveCodexExecutable(this.options.executable || 'codex', env);
      if (signal.aborted) throw cancelled();
      session = this.startSession(executable, env, signal, startedAt, value => {
        if (!canNotify || signal.aborted) return;
        this.forwardQuotaUpdate(value, now, context);
      });
      timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      timeout.unref();

      // [인증 정책] RPC 초기화 후 구독 계정을 확인하고 저장된 토큰 갱신은 요청하지 않는다.
      await this.requestInitialization(session);
      this.notifyInitialized(session, startedAt);
      const accountResult = await session.request('account/read', { refreshToken: false });
      this.verifyAccountResponse(accountResult, session, startedAt);

      // [조회 정책] 지원되는 계정에만 quota 조회와 서버 갱신 알림을 허용한다.
      canNotify = true;
      const result = await session.request('account/rateLimits/read');
      const snapshot = this.parseQuotaResponse(result, now, session, startedAt);

      // [종료 정책] 자식 프로세스를 회수하고 다시 취소 여부를 확인한 뒤 결과를 반환한다.
      await session.close();
      if (signal.aborted) throw cancelled();
      return snapshot;
    } catch (error) {
      throw this.classifyReadError(error, timedOut, signal);
    } finally {
      // [종료 정책] 성공·실패와 관계없이 시간 제한과 세션을 정리하고 실제 종료를 알린다.
      if (timeout) clearTimeout(timeout);
      canNotify = false;
      try { await session?.close(); }
      finally { this.notifySessionStopped(session, startedAt); }
    }
  }

  private createEnvironment(): NodeJS.ProcessEnv {
    // [설정 정책] 데이터 홈은 명시 설정, 전달된 환경, 현재 환경, 사용자 기본 경로 순으로 고른다.
    return { ...process.env, ...this.options.env,
      CODEX_HOME: this.options.dataHome || this.options.env?.CODEX_HOME || process.env.CODEX_HOME || join(homedir(), '.codex') };
  }

  private startSession(executable: string, env: NodeJS.ProcessEnv, signal: AbortSignal, startedAt: number,
    onSnapshot: (value: unknown) => void): RpcSession {
    // [실행 정책] 셸 없이 사용자 홈에서 App Server를 시작해 작업 폴더 설정이 섞이지 않게 한다.
    const child = spawn(executable, [...(this.options.args ?? []), 'app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true, env,
      cwd: homedir(),
    });
    this.lifecycle('started', child.pid, performance.now() - startedAt);
    return new RpcSession(child, signal, this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS, onSnapshot);
  }

  private forwardQuotaUpdate(value: unknown, now: () => number, context: QuotaReadContext): void {
    const snapshot = parseCodexQuota(value, now());
    context.onSnapshot?.(snapshot);
  }

  private requestInitialization(session: RpcSession): Promise<unknown> {
    return session.request('initialize', {
      clientInfo: { name: 'agent_tracker', title: 'Agent Tracker', version: extensionVersion }, capabilities: null,
    });
  }

  private notifyInitialized(session: RpcSession, startedAt: number): void {
    session.notify('initialized', {});
    this.phase('initialized', session.child.pid, performance.now() - startedAt);
  }

  /** 로그인 상태와 구독 계정 유형을 확인한 뒤에만 quota 조회·알림을 허용한다. */
  private verifyAccountResponse(value: unknown, session: RpcSession, startedAt: number): void {
    // [인증 정책] 로그인 정보 없음과 구독을 지원하지 않는 계정 유형을 별도 오류로 구분한다.
    const accountResult = asRecord(value);
    this.phase('account-read', session.child.pid, performance.now() - startedAt);
    const account = asRecord(accountResult?.account);
    if (!account) throw new QuotaError('authentication', { key: 'quota.codexLoginRequired' });
    if (account.type !== 'chatgpt' && account.type !== 'chatgptAuthTokens') {
      throw new QuotaError('unsupported-account', { key: 'quota.codexUnsupportedAccount' });
    }
  }

  private parseQuotaResponse(value: unknown, now: () => number, session: RpcSession, startedAt: number): QuotaSnapshot {
    const snapshot = parseCodexQuota(value, now());
    this.phase('quota-read', session.child.pid, performance.now() - startedAt);
    return snapshot;
  }

  private classifyReadError(error: unknown, timedOut: boolean, signal: AbortSignal): QuotaError {
    // [오류 정책] 시간 초과, 취소, 이미 분류된 오류 순으로 판단하고 그 외는 프로세스 오류로 전달한다.
    if (timedOut) return new QuotaError('timeout', { key: 'quota.codexTimeout' });
    if (signal.aborted) return cancelled();
    if (error instanceof QuotaError) return error;
    return new QuotaError('process', { key: 'quota.codexLaunchFailed' });
  }

  private notifySessionStopped(session: RpcSession | undefined, startedAt: number): void {
    if (session?.hasExited) this.lifecycle('stopped', session.child.pid, performance.now() - startedAt);
  }

  private lifecycle(event: 'started' | 'stopped', pid: number | undefined, elapsedMs: number): void {
    try { this.options.onLifecycle?.({ event, pid, elapsedMs }); } catch { /* Diagnostic callbacks cannot own lifecycle. */ }
  }
  private phase(phase: 'initialized' | 'account-read' | 'quota-read', pid: number | undefined, elapsedMs: number): void {
    try { this.options.onPhase?.({ phase, pid, elapsedMs }); } catch { /* Metrics cannot interrupt the protocol. */ }
  }
}
