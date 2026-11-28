// 화면의 문자열을 안전하게 변환하고 Webview 요청의 종류와 조회 범위를 검증한다.
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
  // [표시 정책] HTML 구문에 쓰이는 문자를 엔티티로 바꿔 텍스트로 표시한다.
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
export type DashboardMessage =
  | { type: 'ready' }
  | { type: 'openDiagnostics' }
  | { type: 'settings' }
  | { type: 'cancelUsage' }
  | { type: 'retryUsage' }
  | { type: 'setSessionBilling'; provider: 'claude' | 'codex'; sessionId: string; mode: BillingMode | null }
  | { type: 'queryUsage'; query: UsageQuery; fromDay?: string; toDay?: string; recentDays?: 7 | 30 | 90 }
  | { type: 'queryNames'; query: NameQuery; requestId: number }
  | { type: 'diagnostics'; offset: number };

/**
 * 책임: Webview가 요청할 수 있는 작업과 데이터 범위를 제한한다.
 * 알고리즘: 명령 종류·열거 값·ID 길이·숫자 범위를 검사하고 허용 필드만 새 메시지로 복사해 임의 파일·명령 선택을 차단한다.
 */
export function parseDashboardMessage(input: unknown): DashboardMessage | null {
  // [DTO 정책] 허용된 명령만 분기하고 입력 전체 대신 검증된 필드로 새 메시지를 만든다.
  if (!input || typeof input !== 'object') return null;
  const value = input as Record<string, unknown>;
  switch (value.type) {
    case 'ready': case 'cancelUsage': case 'retryUsage': case 'openDiagnostics': return { type: value.type };
    case 'settings': return value.provider === undefined ? { type: 'settings' } : null;
    case 'setSessionBilling': return parseSessionBillingMessage(value);
    case 'diagnostics': return { type: 'diagnostics', offset: boundedOffset(value.offset) };
    case 'queryNames': return parseNamesMessage(value);
    case 'queryUsage': return parseUsageMessage(value);
    default: return null;
  }
}

function parseSessionBillingMessage(value: Record<string, unknown>): DashboardMessage | null {
  // [결제 정책] 사용 가능한 제공자, 제한 길이의 세션 ID, 허용 결제 방식만 받는다.
  if (value.provider !== 'claude' && value.provider !== 'codex') return null;
  if (typeof value.sessionId !== 'string') return null;
  if (!value.sessionId || value.sessionId.length > MAX_ID_LENGTH) return null;
  const { mode } = value;
  if (mode !== null && mode !== 'subscription' && mode !== 'api' && mode !== 'unknown') return null;
  return { type: 'setSessionBilling', provider: value.provider, sessionId: value.sessionId, mode };
}

function parseNamesMessage(value: Record<string, unknown>): DashboardMessage | null {
  // [DTO 정책] 이름 요청 ID와 종류를 검사하고 고정 페이지 크기와 제한된 오프셋을 부여한다.
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
  // [DTO 정책] 조회 제어값을 먼저 검증하고 표시 옵션·필터·기간을 허용 필드로 조립한다.
  if (!value.query || typeof value.query !== 'object') return null;
  const raw = value.query as Record<string, unknown>;
  const query = parseUsageControls(raw);
  if (!query) return null;
  if (raw.recentDays !== undefined && ![7, 30, 90].includes(raw.recentDays as number)) return null;
  applyUsagePresentation(query, raw);
  applyUsageFilters(query, raw);
  applyTimestampRange(query, raw);
  const message: Extract<DashboardMessage, { type: 'queryUsage' }> = { type: 'queryUsage', query };
  applyCalendarRange(message, raw);
  return message;
}

function parseUsageControls(raw: Record<string, unknown>): UsageQuery | null {
  // [페이지 정책] 요청 단위 선택을 일별로 매핑한 뒤 집계 차원과 페이지 크기를 검증한다.
  const groupBy = raw.groupBy === 'turn' ? 'day' : raw.groupBy;
  if (!['day', 'month', 'project', 'session', 'all'].includes(String(groupBy))) return null;
  const limit = raw.limit === undefined ? DEFAULT_PAGE_LIMIT : raw.limit;
  if (!validPageLimit(limit)) return null;
  const query: UsageQuery = { groupBy: groupBy as UsageQuery['groupBy'], limit, offset: boundedOffset(raw.offset) };
  // [조회 정책] 표 정렬·화면 구역·도구별 페이지 옵션을 각각 검증한다.
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
  // [정렬 정책] 생략은 유지하고 정렬을 지정했다면 알려진 열과 방향만 허용한다.
  if (raw.tableSort === undefined) return undefined;
  if (!raw.tableSort || typeof raw.tableSort !== 'object') return null;
  const sort = raw.tableSort as Record<string, unknown>;
  if (!USAGE_SORT_KEYS.includes(sort.key as UsageSort['key'])) return null;
  if (!['asc', 'desc'].includes(String(sort.direction))) return null;
  return { key: sort.key as UsageSort['key'], direction: sort.direction as UsageSort['direction'] };
}

function applyCapabilityOffsets(query: UsageQuery, raw: Record<string, unknown>): void {
  // [페이지 정책] 지원하는 도구 분류별로 오프셋을 허용 범위에 맞춘다.
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
    // [페이지 정책] 빠진 도구 분류는 기본값을 쓰고 잘못된 크기가 하나라도 있으면 요청을 거부한다.
    if (limits[category] === undefined) continue;
    if (!validPageLimit(limits[category])) return null;
    pageSizes[category] = limits[category];
  }
  return pageSizes;
}

function applyUsagePresentation(query: UsageQuery, raw: Record<string, unknown>): void {
  // [표시 정책] 비용은 불리언으로, 차트 지표와 분류는 지원하는 값으로 제한한다.
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
  // [조회 정책] 제공자와 비어 있지 않은 제한 길이의 프로젝트·세션 ID만 필터에 쓴다.
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
  // [기간 정책] Date 범위에 들어오는 안전한 정수 밀리초만 사용한다.
  for (const key of ['fromMs', 'toMs'] as const) {
    if (typeof raw[key] !== 'number') continue;
    if (!Number.isSafeInteger(raw[key])) continue;
    const withinDateRange = Math.abs(raw[key]) <= MAX_EPOCH_MS;
    if (!withinDateRange) continue;
    query[key] = raw[key];
  }
}

function applyCalendarRange(message: Extract<DashboardMessage, { type: 'queryUsage' }>, raw: Record<string, unknown>): void {
  // [기간 정책] 지원하는 최근 기간을 우선하고 개별 경계는 연-월-일 형식만 복사한다.
  if (raw.recentDays === 7 || raw.recentDays === 30 || raw.recentDays === 90) {
    message.recentDays = raw.recentDays;
    return;
  }
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
