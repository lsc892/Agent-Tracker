import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asRecord, QuotaError, type QuotaProvider, type QuotaReadContext, type QuotaSnapshot, type QuotaWindow } from './types';

export interface ClaudeCredentialSource {
  /** refresh=true re-reads the CLI-owned credential source after a 401. */
  getAccessToken(refresh: boolean, signal: AbortSignal): Promise<string>;
}

export interface ClaudeQuotaProviderOptions {
  dataHome?: string;
  credentials?: ClaudeCredentialSource;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  now?: () => number;
}

/** Keeps credentials owned by Claude Code; never persists or logs token material. */
export class ClaudeCliCredentials implements ClaudeCredentialSource {
  private readonly dataHome: string;
  constructor(dataHome?: string) {
    this.dataHome = dataHome || process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  }

  async getAccessToken(_refresh: boolean, signal: AbortSignal): Promise<string> {
    let serialized: string | undefined;
    try {
      const path = join(this.dataHome, '.credentials.json');
      const metadata = await stat(path);
      if (metadata.size > 1_048_576 || !metadata.isFile()) throw new Error('Invalid credential file');
      serialized = await readFile(path, { encoding: 'utf8', signal });
    } catch {
      if (signal.aborted) throw new QuotaError('cancelled', { key: 'quota.claudeCancelled' });
      // macOS Claude Code normally stores credentials in the login keychain.
      if (process.platform === 'darwin' && this.dataHome === join(homedir(), '.claude')) {
        try {
          serialized = await new Promise<string>((resolve, reject) => {
            execFile('/usr/bin/security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
              { signal, timeout: 5_000, maxBuffer: 1_048_576, windowsHide: true },
              (error, stdout) => error ? reject(new Error('Credential unavailable')) : resolve(stdout));
          });
        } catch { /* Return only the fixed login guidance below. */ }
      }
    }
    try {
      const credential = asRecord(asRecord(JSON.parse(serialized ?? 'null'))?.claudeAiOauth);
      const token = credential?.accessToken;
      if (typeof token === 'string' && token.length > 0 && token.length <= 16_384 && !/[\r\n]/.test(token)) return token;
    } catch { /* Never expose JSON parse errors from credentials. */ }
    finally { serialized = undefined; }
    throw new QuotaError('authentication', { key: 'quota.claudeLoginRequired' });
  }
}

export class ClaudeQuotaProvider implements QuotaProvider {
  readonly id = 'claude' as const;
  private readonly credentials: ClaudeCredentialSource;
  private readonly fetcher: typeof globalThis.fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly active = new Set<AbortController>();

  constructor(options: ClaudeQuotaProviderOptions = {}) {
    this.credentials = options.credentials ?? new ClaudeCliCredentials(options.dataHome);
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async read(context: QuotaReadContext): Promise<QuotaSnapshot> {
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, controller.signal]);
    this.active.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    timeout.unref?.();
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        signal.throwIfAborted();
        let token: string | undefined = await this.credentials.getAccessToken(attempt === 1, signal);
        let response: Response;
        try {
          signal.throwIfAborted();
          response = await this.fetcher('https://api.anthropic.com/api/oauth/usage', {
            method: 'GET', signal, redirect: 'error',
            headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20',
              'User-Agent': 'agent-tracker/0.1.0', Accept: 'application/json' },
          });
        } finally { token = undefined; }
        if (response.status === 401) {
          // A failed body stream must not erase the status needed for auth/retry policy.
          await response.body?.cancel().catch(() => {});
          if (attempt === 0) continue;
          throw new QuotaError('authentication', { key: 'quota.claudeLoginExpired' });
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          if (response.status === 429) throw new QuotaError('rate-limit', { key: 'quota.claudeRateLimited' },
            parseRetryAfter(response.headers.get('retry-after'), this.now()));
          if (response.status === 403) throw new QuotaError('authentication', { key: 'quota.claudeAccessDenied' });
          throw new QuotaError('network', { key: 'quota.claudeHttpFailed', values: { value0: response.status } });
        }
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
      this.active.delete(controller);
    }
  }

  dispose(): void { for (const controller of this.active) controller.abort(); }
}

export function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(2_147_000_000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(2_147_000_000, Math.max(0, date - now)) : undefined;
}

export function parseClaudeQuota(value: unknown, fetchedAt: number): QuotaSnapshot {
  const data = asRecord(value);
  if (!data) throw new QuotaError('protocol', { key: 'quota.claudeUnsupportedResponse' });
  const windows: QuotaWindow[] = [];
  for (const [id, raw] of Object.entries(data)) {
    const window = asRecord(raw);
    if (!window || window.utilization == null) continue;
    const used = window.utilization;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) {
      throw new QuotaError('protocol', { key: 'quota.claudeInvalidPercentage' });
    }
    const reset = window.resets_at;
    const resetsAt = typeof reset === 'string' ? Date.parse(reset) : null;
    if ((reset != null && typeof reset !== 'string') || (resetsAt !== null && !Number.isFinite(resetsAt))) {
      throw new QuotaError('protocol', { key: 'quota.claudeInvalidReset' });
    }
    const minutes = id.startsWith('five_hour') ? 300 : id.startsWith('seven_day') ? 10_080 : null;
    const label = id.replace(/^five_hour/, '5h').replace(/^seven_day/, '7d').replaceAll('_', ' ').slice(0, 100);
    windows.push({ id: id.slice(0, 100), label, usedPercent: used, current: used, maximum: 100, resetsAt, windowDurationMins: minutes });
    if (windows.length > 100) throw new QuotaError('protocol', { key: 'quota.claudeTooManyWindows' });
  }
  if (windows.length === 0) throw new QuotaError('unavailable', { key: 'quota.claudeUnavailable' });
  return { provider: 'claude', fetchedAt, windows };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new QuotaError('protocol', { key: 'quota.claudeEmptyResponse' });
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 1_048_576) throw new QuotaError('protocol', { key: 'quota.claudeResponseTooLarge' });
      chunks.push(part.value);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new QuotaError('protocol', { key: 'quota.claudeInvalidJson' }); }
  } finally {
    try { await reader.cancel(); } catch { /* Preserve the safe error above. */ }
    reader.releaseLock();
  }
}
