// Codex 한도 응답과 초기화 크레딧을 검증해 공통 quota 스냅샷으로 변환한다.
import { asRecord, durationLabel, QuotaError, type QuotaSnapshot, type QuotaWindow } from '../types';
import { protocolError } from './errors';

interface CodexLimit {
  source: Record<string, unknown>;
  id: string;
  name: string | undefined;
  usesWindowLabel: boolean;
}

/**
 * 책임: Codex의 단일·다중 한도 응답을 공통 quota 창으로 변환한다.
 * 알고리즘: 명시된 한도 맵을 우선해 각 primary·secondary를 검증하고 초기화 초를 밀리초로 바꾸며 reset credit을 별도 해석한다.
 */
export function parseCodexQuota(value: unknown, fetchedAt: number): QuotaSnapshot {
  const result = asRecord(value);
  if (!result) throw protocolError();

  const windows = parseQuotaWindows(result);
  if (windows.length === 0) throw new QuotaError('unavailable', { key: 'quota.codexUnavailable' });
  const rateLimitResetCredits = parseResetCredits(result.rateLimitResetCredits);
  return { provider: 'codex', fetchedAt, windows, ...(rateLimitResetCredits ? { rateLimitResetCredits } : {}) };
}

function parseQuotaWindows(result: Record<string, unknown>): QuotaWindow[] {
  const byLimit = asRecord(result.rateLimitsByLimitId);
  if (result.rateLimitsByLimitId != null && !byLimit) throw protocolError();
  // An explicitly present empty map is authoritative, not a reason to use stale fallback data.
  const buckets = byLimit ? Object.entries(byLimit) : [['codex', result.rateLimits] as const];
  const windows: QuotaWindow[] = [];
  for (const [key, raw] of buckets) {
    appendLimitWindows(windows, key, raw, buckets.length === 1);
  }
  return windows;
}

function appendLimitWindows(windows: QuotaWindow[], key: string, value: unknown, isSingleLimit: boolean): void {
  const bucket = asRecord(value);
  if (!bucket) throw protocolError();
  const limitId = typeof bucket.limitId === 'string' ? bucket.limitId.slice(0, 100) : key.slice(0, 100);
  const limitName = typeof bucket.limitName === 'string' && bucket.limitName ? bucket.limitName.slice(0, 100) : undefined;
  const limit: CodexLimit = { source: bucket, id: limitId, name: limitName, usesWindowLabel: isSingleLimit || limitId === 'codex' };
  appendLimitWindow(windows, limit, 'primary');
  appendLimitWindow(windows, limit, 'secondary');
}

function appendLimitWindow(windows: QuotaWindow[], limit: CodexLimit, windowId: 'primary' | 'secondary'): void {
  const window = parseCodexQuotaWindow(limit.source[windowId], windowId);
  if (!window) return;
  windows.push({ ...window, id: `${limit.id}:${windowId}`, limitId: limit.id,
    ...(limit.name ? { limitName: limit.name } : {}),
    label: limit.usesWindowLabel ? window.label : `${limit.name || limit.id} ${window.label}`,
    ...(typeof limit.source.rateLimitReachedType === 'string' ? { rateLimitReachedType: limit.source.rateLimitReachedType.slice(0, 100) } : {}),
  });
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
  if (count === 0 || !Array.isArray(summary?.credits)) return { availableCount: count, nextExpiresAt: null };
  let nextExpiresAt: number | null = null;
  for (const raw of summary.credits) {
    const credit = asRecord(raw);
    if (credit?.status !== 'available' || credit.resetType !== 'codexRateLimits') continue;
    const expiresAt = credit.expiresAt;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt < 0 || expiresAt > 8.64e12) continue;
    const timestamp = expiresAt * 1000;
    if (nextExpiresAt === null || timestamp < nextExpiresAt) nextExpiresAt = timestamp;
  }
  return { availableCount: count, nextExpiresAt };
}
