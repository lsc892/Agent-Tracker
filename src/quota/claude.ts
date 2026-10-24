import { extensionVersion } from '../version';
import { BaseQuotaProvider } from './base';
import { readBoundedJson } from './claude/httpBody';
import { parseClaudeQuota } from './claude/response';
import { createClaudeCredentials, type ClaudeCredentialSource } from './claudeCredentials';
import { QuotaError, type QuotaReadContext, type QuotaSnapshot } from './types';

export { parseClaudeQuota } from './claude/response';
export type { ClaudeCredentialSource } from './claudeCredentials';

export interface ClaudeQuotaProviderOptions {
  dataHome?: string;
  credentials?: ClaudeCredentialSource;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

export class ClaudeQuotaProvider extends BaseQuotaProvider {
  readonly id = 'claude' as const;
  protected readonly closedMessage = { key: 'quota.claudeCancelled' } as const;
  private readonly credentials: ClaudeCredentialSource;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(options: ClaudeQuotaProviderOptions = {}) {
    super();
    this.credentials = options.credentials ?? createClaudeCredentials(options.dataHome);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  /**
   * 책임: Claude OAuth 사용량을 취소·시간 제한 안에서 조회한다.
   * 알고리즘: GET 요청 후 401일 때만 인증을 다시 읽어 한 번 재시도하고, HTTP 상태를 분류한 뒤 제한된 JSON을 정규화한다.
   */
  protected async readQuota(context: QuotaReadContext): Promise<QuotaSnapshot> {
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    timeout.unref?.();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signal.throwIfAborted();
        const response = await this.requestUsage(attempt === 1, signal);
        if (response.status === 401 && attempt === 0) {
          // A failed body stream must not erase the status needed for auth/retry policy.
          await response.body?.cancel().catch(() => {});
          continue;
        }
        await this.ensureUsageResponseOk(response);
        const body = await readBoundedJson(response);
        signal.throwIfAborted();
        return parseClaudeQuota(body, this.now());
      }
      throw new QuotaError('authentication', { key: 'quota.claudeSignInAgain' });
    } catch (error) {
      if (timedOut) throw new QuotaError('timeout', { key: 'quota.claudeTimeout' });
      if (signal.aborted) throw new QuotaError('cancelled', { key: 'quota.claudeCancelled' });
      if (error instanceof QuotaError) throw error;
      throw new QuotaError('network', { key: 'quota.claudeNetworkFailed' });
    } finally {
      clearTimeout(timeout);
    }
  }

  /** 인증 정보를 읽고 취소 여부를 확인한 뒤 HTTP 요청 한 번을 보낸다. */
  private async requestUsage(refresh: boolean, signal: AbortSignal): Promise<Response> {
    const token = await this.credentials.getAccessToken(refresh, signal);
    signal.throwIfAborted();
    return this.fetcher('https://api.anthropic.com/api/oauth/usage', {
      method: 'GET', signal, redirect: 'error',
      headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': `agent-tracker/${extensionVersion}`, Accept: 'application/json' },
    });
  }

  /** 실패 응답의 본문을 폐기하고 HTTP 상태에 맞는 안전한 오류를 던진다. */
  private async ensureUsageResponseOk(response: Response): Promise<void> {
    if (response.ok) return;
    // Body cancellation failures must not replace the HTTP status error.
    await response.body?.cancel().catch(() => {});
    switch (response.status) {
      case 401:
        throw new QuotaError('authentication', { key: 'quota.claudeLoginExpired' });
      case 403:
        throw new QuotaError('authentication', { key: 'quota.claudeAccessDenied' });
      case 429:
        throw new QuotaError('rate-limit', { key: 'quota.claudeRateLimited' },
          parseRetryAfter(response.headers.get('retry-after'), this.now()));
      default:
        throw new QuotaError('network', { key: 'quota.claudeHttpFailed', values: { value0: response.status } });
    }
  }
}

/**
 * 책임: HTTP 재시도 안내를 밀리초 지연으로 변환한다.
 * 알고리즘: 숫자는 초 단위로, 그 외는 HTTP 날짜로 해석하고 음수 지연을 0으로 보정하며 타이머 상한을 제한한다.
 */
export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_147_000_000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(2_147_000_000, Math.max(0, date - now)) : undefined;
}
