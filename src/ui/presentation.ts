import type { QuotaProviderId } from '../quota/types';
import type { UsageQuery } from '../summary/types';

export const providerName = (id: QuotaProviderId): string => id === 'claude' ? 'Claude' : 'Codex';
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export type DashboardTab = 'usage' | 'diagnostics';
export type DashboardMessage =
  | { type: 'ready' }
  | { type: 'tab'; tab: DashboardTab }
  | { type: 'settings' }
  | { type: 'cancelUsage' }
  | { type: 'queryUsage'; query: UsageQuery; fromDay?: string; toDay?: string }
  | { type: 'diagnostics'; offset: number };

/** A Webview may only ask for known operations; it cannot select files or commands. */
export function parseDashboardMessage(input: unknown): DashboardMessage | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  switch (value.type) {
    case 'ready': case 'cancelUsage': return { type: value.type };
    case 'tab': return ['usage', 'diagnostics'].includes(String(value.tab)) ? { type: 'tab', tab: value.tab as DashboardTab } : null;
    case 'settings': return value.provider === undefined ? { type: 'settings' } : null;
    case 'diagnostics': return { type: 'diagnostics', offset: boundedOffset(value.offset) };
    case 'queryUsage': {
      if (!value.query || typeof value.query !== 'object') return null;
      const raw = value.query as Record<string, unknown>;
      const groupBy = raw.groupBy;
      if (!['day', 'month', 'project', 'session', 'all', 'turn'].includes(String(groupBy))) return null;
      const query: UsageQuery = { groupBy: groupBy as UsageQuery['groupBy'], limit: 100, offset: boundedOffset(raw.offset) };
      if (raw.provider === 'claude' || raw.provider === 'codex') query.provider = raw.provider;
      for (const key of ['projectKey', 'sessionId', 'projectName', 'sessionName'] as const) if (typeof raw[key] === 'string' && raw[key].length <= 2048 && raw[key]) query[key] = raw[key];
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
