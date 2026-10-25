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
      await session.request('initialize', { clientInfo: { name: 'agent_tracker', title: 'Agent Tracker', version: extensionVersion }, capabilities: null });
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
