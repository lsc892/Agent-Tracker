import type { QuotaProviderId } from '../quota/types';
import type { UsageQuery, NameQuery } from '../summary/types';
import { USAGE_SORT_KEYS, type UsageSort } from '../summary/db/types';

export const providerName = (id: QuotaProviderId): string => id === 'claude' ? 'Claude' : 'Codex';
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export type DashboardMessage =
  | { type: 'ready' }
  | { type: 'openDiagnostics' }
  | { type: 'settings' }
  | { type: 'cancelUsage' }
  | { type: 'setSessionBilling'; provider: 'claude' | 'codex'; sessionId: string; mode: import('../summary/db/types').BillingMode }
  | { type: 'queryUsage'; query: UsageQuery; fromDay?: string; toDay?: string }
  | { type: 'queryNames'; query: NameQuery; requestId: number }
  | { type: 'diagnostics'; offset: number };

/**
 * 책임: Webview가 요청할 수 있는 작업과 데이터 범위를 제한한다.
 * 알고리즘: 명령 종류·열거 값·ID 길이·숫자 범위를 검사하고 허용 필드만 새 메시지로 복사해 임의 파일·명령 선택을 차단한다.
 */
export function parseDashboardMessage(input: unknown): DashboardMessage | null {
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  switch (value.type) {
    case 'ready': case 'cancelUsage': case 'openDiagnostics': return { type: value.type };
    case 'settings': return value.provider === undefined ? { type: 'settings' } : null;
    case 'setSessionBilling': {
      if ((value.provider !== 'claude' && value.provider !== 'codex') || typeof value.sessionId !== 'string'
        || !value.sessionId || value.sessionId.length > 2048 || !['subscription','api','unknown'].includes(String(value.mode))) return null;
      return { type: 'setSessionBilling',provider:value.provider,sessionId:value.sessionId,mode:value.mode as import('../summary/db/types').BillingMode };
    }
    case 'diagnostics': return { type: 'diagnostics', offset: boundedOffset(value.offset) };
    case 'queryNames': {
      if (!value.query || typeof value.query !== 'object' || !Number.isSafeInteger(value.requestId) || (value.requestId as number) < 0) return null;
      const raw = value.query as Record<string, unknown>;
      if (raw.kind !== 'project' && raw.kind !== 'session') return null;
      const query: NameQuery = { kind: raw.kind, limit: 100, offset: boundedOffset(raw.offset) };
      if (raw.provider === 'claude' || raw.provider === 'codex') query.provider = raw.provider;
      if (raw.kind === 'session' && typeof raw.projectKey === 'string' && raw.projectKey.length <= 2048 && raw.projectKey) query.projectKey = raw.projectKey;
      return { type: 'queryNames', query, requestId: value.requestId as number };
    }
    case 'queryUsage': {
      if (!value.query || typeof value.query !== 'object') return null;
      const raw = value.query as Record<string, unknown>;
      const groupBy = raw.groupBy;
      if (!['day', 'month', 'project', 'session', 'all', 'turn'].includes(String(groupBy))) return null;
      const limit = raw.limit === undefined ? 100 : raw.limit;
      if (!validPageLimit(limit)) return null;
      const query: UsageQuery = { groupBy: groupBy as UsageQuery['groupBy'], limit, offset: boundedOffset(raw.offset) };
      if (raw.tableSort !== undefined) {
        if (!raw.tableSort || typeof raw.tableSort !== 'object') return null;
        const sort = raw.tableSort as Record<string, unknown>;
        if (!USAGE_SORT_KEYS.includes(sort.key as UsageSort['key']) || !['asc', 'desc'].includes(String(sort.direction))) return null;
        query.tableSort = { key: sort.key as UsageSort['key'], direction: sort.direction as UsageSort['direction'] };
      }
      if (raw.section !== undefined && raw.section !== 'tokens' && raw.section !== 'skills') return null;
      if (raw.section) query.section = raw.section;
      if (raw.capabilityOffsets && typeof raw.capabilityOffsets === 'object') {
        const offsets=raw.capabilityOffsets as Record<string,unknown>;
        query.capabilityOffsets=Object.fromEntries((['skill','subagent','plugin','model'] as const)
          .map(category=>[category,boundedOffset(offsets[category])]));
      }
      if (raw.capabilityLimits !== undefined) {
        if (!raw.capabilityLimits || typeof raw.capabilityLimits !== 'object') return null;
        const limits = raw.capabilityLimits as Record<string, unknown>;
        query.capabilityLimits = {};
        for (const category of ['skill', 'subagent', 'plugin', 'model'] as const) {
          if (limits[category] === undefined) continue;
          if (!validPageLimit(limits[category])) return null;
          query.capabilityLimits[category] = limits[category];
        }
      }
      if (typeof raw.includeCosts === 'boolean') query.includeCosts = raw.includeCosts;
      if (['tokens', 'requests', 'averageTokens', 'averageDuration'].includes(String(raw.chartMetric))) query.chartMetric = raw.chartMetric as UsageQuery['chartMetric'];
      if (raw.chartBy === 'provider' || raw.chartBy === 'model') query.chartBy = raw.chartBy;
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
function validPageLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= 1000;
}
function boundedOffset(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(0, Math.min(value, 10_000_000)) : 0;
}
