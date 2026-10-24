import type { QuotaProviderId } from '../quota/types';
import type { UsageQuery, NameQuery } from '../summary/types';
import { USAGE_SORT_KEYS, type BillingMode, type UsageSort } from '../summary/db/types';

const DEFAULT_PAGE_LIMIT = 100;
const MAX_PAGE_LIMIT = 1000;
const MAX_QUERY_OFFSET = 10_000_000;
const MAX_ID_LENGTH = 2048;
const MAX_EPOCH_MS = 8.64e15;

export const providerName = (id: QuotaProviderId): string => id === 'claude' ? 'Claude' : 'Codex';
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export type DashboardMessage =
  | { type: 'ready' }
  | { type: 'openDiagnostics' }
  | { type: 'settings' }
  | { type: 'cancelUsage' }
  | { type: 'setSessionBilling'; provider: 'claude' | 'codex'; sessionId: string; mode: BillingMode }
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
    case 'setSessionBilling': return parseSessionBillingMessage(value);
    case 'diagnostics': return { type: 'diagnostics', offset: boundedOffset(value.offset) };
    case 'queryNames': return parseNamesMessage(value);
    case 'queryUsage': return parseUsageMessage(value);
    default: return null;
  }
}

function parseSessionBillingMessage(value: Record<string, unknown>): DashboardMessage | null {
  if (value.provider !== 'claude' && value.provider !== 'codex') return null;
  if (typeof value.sessionId !== 'string') return null;
  if (!value.sessionId || value.sessionId.length > MAX_ID_LENGTH) return null;
  if (!['subscription', 'api', 'unknown'].includes(String(value.mode))) return null;
  return { type: 'setSessionBilling', provider: value.provider, sessionId: value.sessionId, mode: value.mode as BillingMode };
}

function parseNamesMessage(value: Record<string, unknown>): DashboardMessage | null {
  if (!value.query || typeof value.query !== 'object') return null;
  if (!Number.isSafeInteger(value.requestId) || (value.requestId as number) < 0) return null;
  const raw = value.query as Record<string, unknown>;
  if (raw.kind !== 'project' && raw.kind !== 'session') return null;
  const query: NameQuery = { kind: raw.kind, limit: DEFAULT_PAGE_LIMIT, offset: boundedOffset(raw.offset) };
  if (raw.provider === 'claude' || raw.provider === 'codex') {
    query.provider = raw.provider;
  }
  applyNamesProjectFilter(query, raw);
  return { type: 'queryNames', query, requestId: value.requestId as number };
}

function applyNamesProjectFilter(query: NameQuery, raw: Record<string, unknown>): void {
  if (raw.kind !== 'session') return;
  if (typeof raw.projectKey !== 'string') return;
  if (raw.projectKey.length <= MAX_ID_LENGTH && raw.projectKey) {
    query.projectKey = raw.projectKey;
  }
}

function parseUsageMessage(value: Record<string, unknown>): DashboardMessage | null {
  if (!value.query || typeof value.query !== 'object') return null;
  const raw = value.query as Record<string, unknown>;
  const query = parseUsageControls(raw);
  if (!query) return null;
  applyUsagePresentation(query, raw);
  applyUsageFilters(query, raw);
  applyTimestampRange(query, raw);
  const message: Extract<DashboardMessage, { type: 'queryUsage' }> = { type: 'queryUsage', query };
  applyCalendarRange(message, raw);
  return message;
}

function parseUsageControls(raw: Record<string, unknown>): UsageQuery | null {
  const groupBy = raw.groupBy;
  if (!['day', 'month', 'project', 'session', 'all', 'turn'].includes(String(groupBy))) return null;
  const limit = raw.limit === undefined ? DEFAULT_PAGE_LIMIT : raw.limit;
  if (!validPageLimit(limit)) return null;
  const query: UsageQuery = { groupBy: groupBy as UsageQuery['groupBy'], limit, offset: boundedOffset(raw.offset) };
  const sort = parseUsageSort(raw);
  if (sort === null) return null;
  if (sort !== undefined) query.tableSort = sort;
  if (raw.section !== undefined && raw.section !== 'tokens' && raw.section !== 'skills') return null;
  if (raw.section) {
    query.section = raw.section;
  }
  applyCapabilityOffsets(query, raw);
  const capabilityLimits = parseCapabilityLimits(raw);
  if (capabilityLimits === null) return null;
  if (capabilityLimits !== undefined) query.capabilityLimits = capabilityLimits;
  return query;
}

function parseUsageSort(raw: Record<string, unknown>): UsageSort | null | undefined {
  if (raw.tableSort === undefined) return undefined;
  if (!raw.tableSort || typeof raw.tableSort !== 'object') return null;
  const sort = raw.tableSort as Record<string, unknown>;
  if (!USAGE_SORT_KEYS.includes(sort.key as UsageSort['key'])) return null;
  if (!['asc', 'desc'].includes(String(sort.direction))) return null;
  return { key: sort.key as UsageSort['key'], direction: sort.direction as UsageSort['direction'] };
}

function applyCapabilityOffsets(query: UsageQuery, raw: Record<string, unknown>): void {
  if (!raw.capabilityOffsets || typeof raw.capabilityOffsets !== 'object') return;
  const offsets = raw.capabilityOffsets as Record<string, unknown>;
  query.capabilityOffsets = Object.fromEntries((['skill', 'subagent', 'plugin', 'model'] as const)
    .map(category => [category, boundedOffset(offsets[category])]));
}

function parseCapabilityLimits(raw: Record<string, unknown>): UsageQuery['capabilityLimits'] | null {
  if (raw.capabilityLimits === undefined) return undefined;
  if (!raw.capabilityLimits || typeof raw.capabilityLimits !== 'object') return null;
  const limits = raw.capabilityLimits as Record<string, unknown>;
  const pageSizes: NonNullable<UsageQuery['capabilityLimits']> = {};
  for (const category of ['skill', 'subagent', 'plugin', 'model'] as const) {
    // Omitted categories keep their defaults; a supplied invalid size rejects the query.
    if (limits[category] === undefined) continue;
    if (!validPageLimit(limits[category])) return null;
    pageSizes[category] = limits[category];
  }
  return pageSizes;
}

function applyUsagePresentation(query: UsageQuery, raw: Record<string, unknown>): void {
  if (typeof raw.includeCosts === 'boolean') {
    query.includeCosts = raw.includeCosts;
  }
  if (['tokens', 'requests', 'averageTokens', 'averageDuration'].includes(String(raw.chartMetric))) {
    query.chartMetric = raw.chartMetric as UsageQuery['chartMetric'];
  }
  if (raw.chartBy === 'provider' || raw.chartBy === 'model') {
    query.chartBy = raw.chartBy;
  }
}

function applyUsageFilters(query: UsageQuery, raw: Record<string, unknown>): void {
  if (raw.provider === 'claude' || raw.provider === 'codex') {
    query.provider = raw.provider;
  }
  for (const key of ['projectKey', 'sessionId'] as const) {
    if (typeof raw[key] !== 'string') continue;
    const withinIdLength = raw[key].length <= MAX_ID_LENGTH;
    if (!withinIdLength || !raw[key]) continue;
    query[key] = raw[key];
  }
}

function applyTimestampRange(query: UsageQuery, raw: Record<string, unknown>): void {
  for (const key of ['fromMs', 'toMs'] as const) {
    if (typeof raw[key] !== 'number') continue;
    if (!Number.isSafeInteger(raw[key])) continue;
    const withinDateRange = Math.abs(raw[key]) <= MAX_EPOCH_MS;
    if (!withinDateRange) continue;
    query[key] = raw[key];
  }
}

function applyCalendarRange(message: Extract<DashboardMessage, { type: 'queryUsage' }>, raw: Record<string, unknown>): void {
  for (const key of ['fromDay', 'toDay'] as const) {
    if (typeof raw[key] !== 'string') continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw[key])) continue;
    message[key] = raw[key];
  }
}

function validPageLimit(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_PAGE_LIMIT;
}
function boundedOffset(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return 0;
  return Math.max(0, Math.min(value, MAX_QUERY_OFFSET));
}
