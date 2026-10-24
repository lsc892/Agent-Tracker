import { asRecord, QuotaError, type QuotaSnapshot, type QuotaWindow } from '../types';

/**
 * 책임: Claude 응답의 사용률·초기화 시각을 공통 quota 창으로 변환한다.
 * 알고리즘: utilization이 있는 항목을 순회해 유한한 비음수 사용률과 날짜를 검증하고 공통 quota 창으로 변환한다.
 */
export function parseClaudeQuota(value: unknown, fetchedAt: number): QuotaSnapshot {
  const data = asRecord(value);
  if (!data) throw new QuotaError('protocol', { key: 'quota.claudeUnsupportedResponse' });
  const windows: QuotaWindow[] = [];
  for (const [id, raw] of Object.entries(data)) {
    const window = parseClaudeQuotaWindow(id, raw);
    if (!window) continue;
    windows.push(window);
  }
  if (windows.length === 0) throw new QuotaError('unavailable', { key: 'quota.claudeUnavailable' });
  return { provider: 'claude', fetchedAt, windows };
}

/** 사용률이 있는 창 하나의 백분율·초기화 시각을 검증하고 정규화한다. */
function parseClaudeQuotaWindow(id: string, value: unknown): QuotaWindow | null {
  const window = asRecord(value);
  if (!window || window.utilization == null) return null;
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
  return { id: id.slice(0, 100), label, usedPercent: used, current: used, maximum: 100, resetsAt, windowDurationMins: minutes };
}
