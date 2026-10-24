import type { SQLInputValue } from 'node:sqlite';
import { usageTableOrder } from './sorting';
import type { NameQuery } from '../types';
import type { ChartMetric, SummaryFilter, UsageGrouping, UsageSort } from './types';
import { calendarPeriod } from './timezone';

export type UsageBasis = 'provider' | 'model';

/** Filter/period bindings come first; database methods append validated pagination bindings. */
export interface QuerySql {
  sql: string;
  values: SQLInputValue[];
}

interface UsageScope {
  where: string;
  values: SQLInputValue[];
  groups: string[];
  period: string;
  calendar: boolean;
  project: boolean;
  session: boolean;
}

const RECORDED_USAGE = '(total_tokens > 0 OR has_model = 1)';

// NULL means usage was not recorded; '' means recorded usage has an unknown model.
const MODEL_NAME = `CASE
  WHEN coalesce(m.model, '') = '' AND coalesce(m.input_tokens + m.output_tokens, t.total_tokens) = 0 THEN NULL
  ELSE coalesce(m.model, '')
END AS model`;

const MODEL_TOKENS = `
  coalesce(m.input_tokens, t.input_tokens) AS input_tokens,
  coalesce(m.output_tokens, t.output_tokens) AS output_tokens,
  CASE WHEN m.turn_id IS NULL THEN t.cache_write_input_tokens ELSE m.cache_write_input_tokens END AS cache_write_input_tokens,
  CASE WHEN m.turn_id IS NULL THEN t.cache_read_input_tokens ELSE m.cache_read_input_tokens END AS cache_read_input_tokens`;

const MODEL_COSTS = `
  coalesce(c.billing_mode, 'unknown') AS billing_mode,
  CASE
    WHEN c.billing_mode = 'subscription' THEN 0
    WHEN c.billing_mode = 'api' THEN m.estimated_cost_usd
  END AS cost_usd,
  CASE
    WHEN c.billing_mode = 'subscription' OR c.billing_mode = 'api' AND m.estimated_cost_usd IS NOT NULL THEN 0
    ELSE 1
  END AS unknown_costs`;

const COST_SUMS = `
  SUM(cost_usd) AS cost_usd,
  SUM(unknown_costs) AS unknown_costs,
  CASE WHEN min(billing_mode) = max(billing_mode) THEN min(billing_mode) ELSE 'unknown' END AS billing_mode`;

function modelTurns(costs: boolean): string {
  return `(SELECT
    t.id, t.provider, t.project_key, t.session_id, t.root_turn_id,
    t.request_title, coalesce(m.model, '') <> '' AS has_model,
    t.started_at_ms, t.completed_at_ms, t.duration_ms, t.duration_quality, t.status, t.quality_flags,
    t.diagnostic_file_id, t.diagnostic_offset, t.last_error, t.updated_at,
    ${MODEL_NAME},
    ${MODEL_TOKENS},
    coalesce(m.input_tokens + m.output_tokens, t.total_tokens) AS total_tokens${costs ? `, ${MODEL_COSTS}` : ''}
  FROM turn_summary t
  LEFT JOIN turn_model_usage m ON m.turn_id = t.id
  ${costs ? 'LEFT JOIN turn_costs c ON c.turn_id = t.id' : ''})`;
}

/**
 * 책임: 제공자·모델 기준 집계가 사용할 요청 원본 projection을 만든다.
 * 알고리즘: 모델 기준은 LEFT JOIN으로 기록 부재·모델 미상을 보존하고 제공자 기준은 요청을 유지하며 비용 열은 요청될 때만 연결한다.
 */
export function usageTurns(costs = false, by: UsageBasis = 'provider'): string {
  if (by === 'model') return modelTurns(costs);
  if (by !== 'provider') throw new RangeError('Unknown usage grouping basis');

  const source = costs ? `(SELECT
    t.*, c.cost_usd, coalesce(c.unknown_costs, 1) AS unknown_costs,
    coalesce(c.billing_mode, 'unknown') AS billing_mode
    FROM turn_summary t LEFT JOIN turn_costs c ON c.turn_id = t.id)` : 'turn_summary';
  return `(SELECT
    t.*, EXISTS(SELECT 1 FROM turn_model_usage m WHERE m.turn_id = t.id AND m.model <> '') AS has_model
    FROM ${source} t)`;
}

function namedTurns(costs = false, by: UsageBasis = 'provider'): string {
  return `(SELECT t.*, p.project_name, s.session_name
    FROM ${usageTurns(costs, by)} t
    JOIN projects p ON p.project_key = t.project_key
    JOIN sessions s ON s.provider = t.provider AND s.session_id = t.session_id)`;
}

function unknownOrder(by: UsageBasis, time?: string): string {
  const flags: string[] = [];
  if (time) flags.push(time);
  if (by === 'model') flags.push("coalesce(model, '') = ''");
  if (!flags.length) return '';

  const combined = flags.length > 1 ? `(${flags.join(' OR ')}), ` : '';
  return `${combined}${flags.join(', ')}, `;
}

/**
 * 책임: 행 조회와 개수 조회에 동일한 필터 의미를 제공한다.
 * 알고리즘: 허용된 열의 조건과 바인딩을 순서대로 만들고 이름 검색 문자를 escape하며 날짜를 검증해 미상 시간 포함 정책을 적용한다.
 */
export function buildQueryFilter(filter: SummaryFilter): QuerySql {
  const clauses: string[] = [];
  const values: SQLInputValue[] = [];
  if (filter.providers) {
    clauses.push(filter.providers.length ? `provider IN (${filter.providers.map(() => '?').join(',')})` : '0 = 1');
    values.push(...filter.providers);
  }
  for (const [name, column] of [['provider', 'provider'], ['projectKey', 'project_key'], ['sessionId', 'session_id']] as const) {
    if (filter[name] === undefined) continue;
    clauses.push(`${column} = ?`);
    values.push(filter[name]!);
  }
  for (const [name, table, condition, column] of [
    ['projectName', 'projects', 'projects.project_key = turn_summary.project_key', 'project_name'],
    ['sessionName', 'sessions', 'sessions.provider = turn_summary.provider AND sessions.session_id = turn_summary.session_id', 'session_name'],
  ] as const) {
    if (!filter[name]) continue;
    clauses.push(`EXISTS(SELECT 1 FROM ${table} WHERE ${condition} AND ${column} LIKE ? ESCAPE '\\')`);
    values.push(`%${filter[name]!.replace(/[\\%_]/g, character => `\\${character}`)}%`);
  }
  appendTimeFilter(filter, clauses, values);
  return { sql: clauses.length ? clauses.join(' AND ') : '1 = 1', values };
}

function appendTimeFilter(filter: SummaryFilter, clauses: string[], values: SQLInputValue[]): void {
  const time: string[] = [];
  const timeValues: SQLInputValue[] = [];
  for (const [name, operator] of [['fromMs', '>='], ['toMs', '<']] as const) {
    if (filter[name] === undefined) continue;
    if (!Number.isSafeInteger(filter[name])) throw new RangeError(`${name} must be an epoch millisecond integer`);
    time.push(`started_at_ms ${operator} ?`);
    timeValues.push(filter[name]!);
  }
  if (filter.unknownTime === 'only') {
    clauses.push('started_at_ms IS NULL');
    return;
  }
  if (time.length) {
    const interval = time.join(' AND ');
    clauses.push(filter.unknownTime === 'include' ? `((${interval}) OR started_at_ms IS NULL)` : `(${interval})`);
    values.push(...timeValues);
    return;
  }
  if (filter.unknownTime === 'exclude') clauses.push('started_at_ms IS NOT NULL');
}

/**
 * 책임: 행·개수 조회가 공유할 집계 차원과 바인딩 순서를 정한다.
 * 알고리즘: 그룹·시간대를 검증하고 일·월 조회의 미상 시간 포함 규칙을 적용한 뒤 제공자·모델·프로젝트·세션·기간 차원을 조립한다.
 */
function usageScope(filter: SummaryFilter, groupBy: UsageGrouping, timezone: string, by: UsageBasis): UsageScope {
  if (!['total', 'project', 'session', 'day', 'month'].includes(groupBy)) throw new RangeError('Unknown usage grouping');
  const calendar = groupBy === 'day' || groupBy === 'month';
  if (calendar) calendarPeriod(0, timezone, groupBy);

  // Calendar queries retain undated requests in a separate NULL-period group, even with a date range.
  const where = buildQueryFilter(calendar && filter.unknownTime === undefined ? { ...filter, unknownTime: 'include' } : filter);
  const project = groupBy === 'project' || groupBy === 'session';
  const session = groupBy === 'session';
  const groups = by === 'model' ? ['provider', 'model'] : ['provider'];
  if (project) groups.push('project_key');
  if (session) groups.push('session_id');
  if (calendar) groups.push('period');
  return {
    where: where.sql,
    values: [...(calendar ? [timezone, groupBy] : []), ...where.values],
    period: calendar ? 'agent_tracker_period(started_at_ms, ?, ?)' : 'NULL',
    groups, calendar, project, session,
  };
}

/**
 * 책임: 요청 총량·완료 표본 평균·미상 캐시를 일관되게 집계한다.
 * 알고리즘: 합계는 모든 상태를 포함하고 평균은 완료 표본만 사용하며, 캐시는 알려진 값의 개수가 표본 수와 같을 때만 합계·평균을 반환한다.
 */
function usageSums(excludeEmptyUsage = false): string {
  // Totals include every status; averages use completed requests and optionally recorded usage only.
  const completed = `status = 'completed'${excludeEmptyUsage ? ` AND ${RECORDED_USAGE}` : ''}`;
  const averageCache = (column: string): string => `CASE
    WHEN COUNT(CASE WHEN ${completed} THEN ${column} END) = SUM(${completed})
    THEN AVG(CASE WHEN ${completed} THEN ${column} END)
  END AS avg_${column}`;
  return `
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    CASE WHEN COUNT(cache_write_input_tokens) = COUNT(*) THEN SUM(cache_write_input_tokens) END AS cache_write_input_tokens,
    CASE WHEN COUNT(cache_read_input_tokens) = COUNT(*) THEN SUM(cache_read_input_tokens) END AS cache_read_input_tokens,
    SUM(total_tokens) AS total_tokens,
    COUNT(*) AS turn_count,
    SUM(status = 'completed') AS completed_turns,
    SUM(${RECORDED_USAGE}) AS recorded_turns,
    SUM(status = 'completed' AND ${RECORDED_USAGE}) AS recorded_completed_turns,
    AVG(CASE WHEN ${completed} THEN total_tokens END) AS avg_tokens_per_turn,
    AVG(CASE WHEN ${completed} THEN input_tokens END) AS avg_input_tokens,
    AVG(CASE WHEN ${completed} THEN output_tokens END) AS avg_output_tokens,
    ${averageCache('cache_write_input_tokens')},
    ${averageCache('cache_read_input_tokens')},
    AVG(CASE WHEN ${completed} THEN duration_ms END) AS avg_duration_ms,
    SUM(${completed} AND duration_ms IS NOT NULL) AS turns_with_duration,
    SUM(${completed} AND duration_quality = 'exact') AS exact_duration_turns,
    SUM(${completed} AND duration_quality = 'derived') AS derived_duration_turns,
    SUM(${completed} AND duration_quality = 'approximate') AS approximate_duration_turns,
    SUM(${completed} AND duration_ms IS NULL) AS missing_duration_turns,
    SUM(started_at_ms IS NULL) AS unknown_time_turns,
    SUM(last_error IS NOT NULL) AS stale_turns,
    MAX(updated_at) AS last_successful_update`;
}

/**
 * 책임: 집계 결과에 필요한 이름·기간·세션 시작 열을 구성한다.
 * 알고리즘: 활성 차원만 projection에 포함하고 이름은 저장 metadata로 조회하며 세션 시작은 현재 날짜 필터와 독립적인 최소 요청 시각으로 구한다.
 */
function usageDimensions(scope: UsageScope, by: UsageBasis): string[] {
  const dimensions = ['provider'];
  if (by === 'model') dimensions.push('model');
  dimensions.push(scope.project ? 'project_key' : 'NULL AS project_key');
  dimensions.push(scope.project
    ? '(SELECT project_name FROM projects p WHERE p.project_key = turn_summary.project_key) AS project_name'
    : 'NULL AS project_name');
  dimensions.push(scope.session ? 'session_id' : 'NULL AS session_id');
  dimensions.push(scope.session
    ? '(SELECT session_name FROM sessions s WHERE s.provider = turn_summary.provider AND s.session_id = turn_summary.session_id) AS session_name'
    : 'NULL AS session_name');
  // Session start is its earliest stored request, independently of the current date filter.
  dimensions.push(scope.session
    ? '(SELECT MIN(t.started_at_ms) FROM turn_summary t WHERE t.provider = turn_summary.provider AND t.session_id = turn_summary.session_id) AS session_started_at_ms'
    : 'NULL AS session_started_at_ms');
  dimensions.push(`${scope.period} AS period`);
  return dimensions;
}

/**
 * 책임: 기간·프로젝트·세션별 원본 통계 SQL을 생성한다.
 * 알고리즘: 공통 scope와 지표 식을 조합해 GROUP BY하고 미상 우선순위·전체 결과 정렬을 적용한 뒤 LIMIT·OFFSET을 붙인다.
 */
export function buildUsageQuery(filter: SummaryFilter, groupBy: UsageGrouping, timezone: string,
  by: UsageBasis, sortBy?: ChartMetric, tableSort?: UsageSort): QuerySql {
  const scope = usageScope(filter, groupBy, timezone, by);
  const groups = scope.groups.join(', ');
  const metrics = { tokens: 'total_tokens', requests: 'turn_count', averageTokens: 'avg_tokens_per_turn', averageDuration: 'avg_duration_ms' };
  const order = sortBy ? `${metrics[sortBy]} DESC, ${groups}` : groups;
  return {
    sql: `${tableSort ? 'SELECT * FROM (' : ''}SELECT
      ${usageDimensions(scope, by).join(',\n      ')},
      ${usageSums(filter.excludeEmptyUsage)}${filter.includeCosts ? `, ${COST_SUMS}` : ''}
    FROM ${usageTurns(filter.includeCosts, by)} AS turn_summary
    WHERE ${scope.where}
    GROUP BY ${groups}
    ${tableSort ? `) ORDER BY ${usageTableOrder(tableSort, groupBy, by === 'model', filter.includeCosts)}`
      : `ORDER BY ${unknownOrder(by, scope.calendar ? 'period IS NULL' : undefined)}${order}`}
    LIMIT ? OFFSET ?`,
    values: scope.values,
  };
}

export function buildUsageCountQuery(filter: SummaryFilter, groupBy: UsageGrouping, timezone: string, by: UsageBasis): QuerySql {
  const scope = usageScope(filter, groupBy, timezone, by);
  return {
    sql: `SELECT COUNT(*) AS count FROM (
      SELECT ${scope.period} AS period
      FROM ${usageTurns(false, by)} AS turn_summary
      WHERE ${scope.where}
      GROUP BY ${scope.groups.join(', ')}
    )`,
    values: scope.values,
  };
}

export function buildTurnsQuery(where: QuerySql, includeCosts: boolean | undefined, by: UsageBasis, unknownLast = false, tableSort?: UsageSort): QuerySql {
  const order = unknownLast ? unknownOrder(by, 'started_at_ms IS NULL') : '';
  return {
    sql: `SELECT *, ${RECORDED_USAGE} AS has_recorded_usage
      FROM ${namedTurns(includeCosts, by)} AS turn_summary
      WHERE ${where.sql} AND id > ?
      ORDER BY ${tableSort ? usageTableOrder(tableSort, 'turn', by === 'model', includeCosts) : `${order}id${by === 'model' ? ', model' : ''}`}
      LIMIT ? OFFSET ?`,
    values: where.values,
  };
}

export function buildTurnsCountQuery(filter: SummaryFilter, by: UsageBasis): QuerySql {
  const where = buildQueryFilter(filter);
  return {
    sql: `SELECT COUNT(*) AS count
      FROM ${usageTurns(false, by)} AS turn_summary
      WHERE ${where.sql}`,
    values: where.values,
  };
}

/**
 * 책임: 현재 표 페이지나 날짜와 독립적인 이름 선택 목록을 만든다.
 * 알고리즘: 제공자·프로젝트 범위의 저장 요청에서 ID로 그룹화하고 이름·고정 키로 정렬한 행과 전체 개수 SQL을 함께 생성한다.
 */
export function buildNameQueries(query: NameQuery): { count: QuerySql; rows: QuerySql } {
  if (!['project', 'session'].includes(query.kind)) throw new RangeError('Unknown name kind');
  const session = query.kind === 'session';
  const where = buildQueryFilter({ provider: query.provider, providers: query.providers,
    projectKey: session ? query.projectKey : undefined });
  const groups = session ? 'provider, project_key, session_id' : 'project_key';
  return {
    count: {
      sql: `SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM turn_summary WHERE ${where.sql} GROUP BY ${groups}
      )`,
      values: where.values,
    },
    rows: {
      sql: `SELECT
        project_key,
        (SELECT project_name FROM projects p WHERE p.project_key = turn_summary.project_key) AS project_name,
        ${session ? 'provider' : 'NULL'} AS provider,
        ${session ? 'session_id' : 'NULL'} AS session_id,
        ${session ? '(SELECT session_name FROM sessions s WHERE s.provider = turn_summary.provider AND s.session_id = turn_summary.session_id)' : 'NULL'} AS session_name,
        ${session ? 'MIN(started_at_ms)' : 'NULL'} AS session_started_at_ms
      FROM turn_summary
      WHERE ${where.sql}
      GROUP BY ${groups}
      ORDER BY ${session ? "COALESCE(session_name, '이름 없는 세션') COLLATE NOCASE, provider," : ''}
        project_name COLLATE NOCASE, project_key${session ? ', session_started_at_ms, session_id' : ''}
      LIMIT ? OFFSET ?`,
      values: where.values,
    },
  };
}

/**
 * 책임: 도구 분류별 순위와 전체 비율 계산용 SQL을 만든다.
 * 알고리즘: 동일한 필터·category 조건으로 제공자·이름별 횟수를 합산하고 전체 합계·최댓값과 페이지 순위를 각각 조회한다.
 */
export function buildCapabilityQueries(filter: SummaryFilter, category: string): { counts: QuerySql; ranking: QuerySql } {
  if (!['skill', 'subagent', 'plugin', 'model'].includes(category)) throw new RangeError('Unknown capability category');
  const where = buildQueryFilter(filter);
  const source = `(SELECT t.*, u.category, u.name, u.usage_count
    FROM turn_summary t JOIN turn_capability_usage u ON u.turn_id = t.id) AS turn_summary`;
  const scope = `${where.sql} AND category = ?`;
  const values = [...where.values, category];
  return {
    counts: {
      sql: `SELECT count(*) AS total, coalesce(sum(uses), 0) AS totalUses, coalesce(max(uses), 0) AS maxUses
        FROM (
          SELECT sum(usage_count) AS uses
          FROM ${source}
          WHERE ${scope}
          GROUP BY provider, name
        )`,
      values,
    },
    ranking: {
      sql: `SELECT provider, category, name, sum(usage_count) AS usage_count
        FROM ${source}
        WHERE ${scope}
        GROUP BY provider, name
        ORDER BY name = '', usage_count DESC, provider, name
        LIMIT ? OFFSET ?`,
      values,
    },
  };
}

/**
 * 책임: 원본을 다시 스캔하지 않고 저장된 진단과 처리 범위를 조회한다.
 * 알고리즘: 같은 필터로 manifest 페이지·오류 또는 품질 플래그가 있는 요청 페이지·상태별 개수를 각각 만들고 ID 기반 페이지 조건을 붙인다.
 */
export function buildDiagnosticQueries(filter: SummaryFilter): { files: QuerySql; summaries: QuerySql; counts: QuerySql } {
  const where = buildQueryFilter(filter);
  return {
    files: {
      sql: `SELECT * FROM manifest
        WHERE ${where.sql} AND id > ?
        ORDER BY id LIMIT ? OFFSET ?`,
      values: where.values,
    },
    summaries: {
      sql: `SELECT * FROM ${namedTurns()} AS turn_summary
        WHERE ${where.sql} AND id > ? AND (
          last_error IS NOT NULL OR (quality_flags IS NOT NULL AND quality_flags <> '[]' AND quality_flags <> '')
        )
        ORDER BY id LIMIT ? OFFSET ?`,
      values: where.values,
    },
    counts: {
      sql: `SELECT
        COUNT(*) AS files,
        COALESCE(SUM(processing_status = 'processing'), 0) AS processing,
        COALESCE(SUM(processing_status = 'done'), 0) AS done,
        COALESCE(SUM(processing_status = 'error'), 0) AS error,
        COALESCE(SUM(processing_status = 'interrupted'), 0) AS interrupted,
        (SELECT COUNT(*) FROM turn_summary WHERE ${where.sql} AND last_error IS NOT NULL) AS stale_summaries
      FROM manifest WHERE ${where.sql}`,
      values: [...where.values, ...where.values],
    },
  };
}
