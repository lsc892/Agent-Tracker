import type { QuotaProviderId, QuotaState } from '../quota/types';
import type { UsageQuery } from '../summary/types';

export const providerName = (id: QuotaProviderId): string => id === 'claude' ? 'Claude' : 'Codex';
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export function statusPresentation(state: QuotaState, percentage: 'used' | 'remaining', detail: 'compact' | 'detailed'): { text: string; warning: boolean } {
  const name = providerName(state.provider);
  const windows = state.snapshot?.windows ?? [];
  if (!windows.length) return { text: `${name} ${state.refreshing ? '$(sync~spin)' : '조회 불가'}`, warning: false };
  const selected = detail === 'compact' ? [windows.reduce((a, b) => a.usedPercent >= b.usedPercent ? a : b)] : windows.slice(0, 2);
  const value = selected.map(window => `${window.label.replace(/\$\(/g, '(').replace(/[\r\n]/g, ' ')}:${Math.round(percentage === 'remaining' ? Math.max(0, 100 - window.usedPercent) : window.usedPercent)}%`).join(' ');
  return { text: `${name} ${percentage === 'remaining' ? '남음 ' : ''}${value}${state.status === 'stale' ? ' $(history)' : ''}${state.refreshing ? ' $(sync~spin)' : ''}`, warning: windows.some(window => window.usedPercent >= 90) };
}

export type DashboardTab = 'quota' | 'usage' | 'diagnostics';
export type DashboardMessage =
  | { type: 'ready' }
  | { type: 'tab'; tab: DashboardTab }
  | { type: 'refreshQuota'; provider: QuotaProviderId }
  | { type: 'settings'; provider?: QuotaProviderId }
  | { type: 'refreshUsage' }
  | { type: 'cancelUsage' }
  | { type: 'queryUsage'; query: UsageQuery; fromDay?: string; toDay?: string }
  | { type: 'diagnostics'; offset: number };

/** A Webview may only ask for known operations; it cannot select files or commands. */
export function parseDashboardMessage(input: unknown): DashboardMessage | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  const provider = value.provider === 'claude' || value.provider === 'codex' ? value.provider : undefined;
  switch (value.type) {
    case 'ready': case 'refreshUsage': case 'cancelUsage': return { type: value.type };
    case 'tab': return ['quota', 'usage', 'diagnostics'].includes(String(value.tab)) ? { type: 'tab', tab: value.tab as DashboardTab } : null;
    case 'refreshQuota': return provider ? { type: 'refreshQuota', provider } : null;
    case 'settings': return value.provider === undefined || provider ? { type: 'settings', provider } : null;
    case 'diagnostics': return { type: 'diagnostics', offset: boundedOffset(value.offset) };
    case 'queryUsage': {
      if (!value.query || typeof value.query !== 'object') return null;
      const raw = value.query as Record<string, unknown>;
      const groupBy = raw.groupBy;
      if (!['day', 'month', 'project', 'session', 'all', 'turn'].includes(String(groupBy))) return null;
      const query: UsageQuery = { groupBy: groupBy as UsageQuery['groupBy'], limit: 100, offset: boundedOffset(raw.offset) };
      if (raw.provider === 'claude' || raw.provider === 'codex') query.provider = raw.provider;
      for (const key of ['projectKey', 'sessionId'] as const) if (typeof raw[key] === 'string' && raw[key].length <= 2048 && raw[key]) query[key] = raw[key];
      for (const key of ['fromMs', 'toMs'] as const) if (typeof raw[key] === 'number' && Number.isSafeInteger(raw[key]) && Math.abs(raw[key]) <= 8.64e15) query[key] = raw[key];
      const message: DashboardMessage = { type: 'queryUsage', query };
      for (const key of ['fromDay', 'toDay'] as const) if (typeof raw[key] === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw[key])) message[key] = raw[key];
      return message;
    }
    default: return null;
  }
}
function boundedOffset(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(0, Math.min(value, 10_000_000)) : 0;
}
