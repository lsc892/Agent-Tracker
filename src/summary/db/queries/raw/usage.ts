// 요청 원본을 기간·프로젝트·세션별로 집계하고 페이지·개수 SQL을 만든다.
import type { SQLInputValue } from 'node:sqlite';
import type { ChartMetric, SummaryFilter, UsageGrouping, UsageSort } from '../../types';
import { calendarPeriod } from '../../timezone';
import { buildQueryFilter } from '../common/filters';
import { unknownOrder, usageTableOrder } from '../common/sorting';
import type { QuerySql, UsageBasis } from '../common/types';
import { RECORDED_USAGE, usageTurns } from './source';

interface UsageScope {
  where: string;
  values: SQLInputValue[];
  groups: string[];
  period: string;
  calendar: boolean;
  project: boolean;
  session: boolean;
}

// #region 집계 범위·지표·차원

const COST_SUMS = `
  SUM(cost_usd) AS cost_usd,
  SUM(unknown_costs) AS unknown_costs,
  CASE
    WHEN min(billing_mode) = max(billing_mode) THEN min(billing_mode)
    ELSE 'unknown'
  END AS billing_mode`;

/**
 * 책임: 행·개수 조회가 공유할 집계 차원과 바인딩 순서를 정한다.
 * 알고리즘: 그룹·시간대를 검증하고 일·월 조회의 미상 시간 포함 규칙을 적용한 뒤 제공자·모델·프로젝트·세션·기간 차원을 조립한다.
 */
function usageScope(filter: SummaryFilter, groupBy: UsageGrouping, timezone: string, by: UsageBasis): UsageScope {
  // [기간 정책] 허용된 그룹만 받고 일·월 집계에는 요청한 시간대를 검증한다.
  if (!['total', 'project', 'session', 'day', 'month'].includes(groupBy)) throw new RangeError('Unknown usage grouping');
  const calendar = groupBy === 'day' || groupBy === 'month';
  if (calendar) calendarPeriod(0, timezone, groupBy);

  // [기간 정책] 일·월 조회는 별도 옵션이 없으면 날짜가 없는 요청을 미상 그룹으로 유지한다.
  const effectiveFilter: SummaryFilter = calendar && filter.unknownTime === undefined
    ? { ...filter, unknownTime: 'include' } : filter;
  const where = buildQueryFilter(effectiveFilter);
  // [집계 정책] 제공자를 기본으로 모델·프로젝트·세션·기간 키를 활성 그룹에 맞춰 더한다.
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
    groups,
    calendar,
    project,
    session,
  };
}

/**
 * 책임: 요청 총량·완료 표본 평균·미상 캐시를 일관되게 집계한다.
 * 알고리즘: 완료 표본의 평균과 캐시 미상 규칙을 적용하고, 도표에 필요한 경우에만 토큰 구성별 평균을 계산한다.
 */
function usageSums(excludeEmptyUsage = false, includeComponentAverages = true): string {
  // [집계 정책] 총합은 모든 요청을 포함하고 평균 표본은 완료 요청 또는 기록이 있는 완료 요청으로 제한한다.
  const completed = `status = 'completed'${excludeEmptyUsage ? ` AND ${RECORDED_USAGE}` : ''}`;
  // [집계 정책] 구성별 평균은 필요한 경우만 계산하고 캐시 값이 빠진 표본이 있으면 해당 평균을 비운다.
  const averageCache = (column: string): string => `CASE
    WHEN COUNT(CASE WHEN ${completed} THEN ${column} END) = SUM(${completed})
    THEN AVG(CASE WHEN ${completed} THEN ${column} END)
  END AS avg_${column}`;
  const componentAverages = includeComponentAverages
    ? `AVG(CASE WHEN ${completed} THEN input_tokens END) AS avg_input_tokens,
    AVG(CASE WHEN ${completed} THEN output_tokens END) AS avg_output_tokens,
    ${averageCache('cache_write_input_tokens')},
    ${averageCache('cache_read_input_tokens')}`
    : `NULL AS avg_input_tokens,
    NULL AS avg_output_tokens,
    NULL AS avg_cache_write_input_tokens,
    NULL AS avg_cache_read_input_tokens`;
  return `
    SUM(input_tokens) AS input_tokens,
    SUM(output_tokens) AS output_tokens,
    CASE
      WHEN COUNT(cache_write_input_tokens) = COUNT(*) THEN SUM(cache_write_input_tokens)
    END AS cache_write_input_tokens,
    CASE
      WHEN COUNT(cache_read_input_tokens) = COUNT(*) THEN SUM(cache_read_input_tokens)
    END AS cache_read_input_tokens,
    SUM(total_tokens) AS total_tokens,
    COUNT(*) AS turn_count,
    SUM(status = 'completed') AS completed_turns,
    SUM(${RECORDED_USAGE}) AS recorded_turns,
    SUM(status = 'completed' AND ${RECORDED_USAGE}) AS recorded_completed_turns,
    AVG(CASE WHEN ${completed} THEN total_tokens END) AS avg_tokens_per_turn,
    ${componentAverages},
    AVG(CASE WHEN ${completed} THEN duration_ms END) AS avg_duration_ms,
    SUM(${completed} AND duration_ms IS NOT NULL) AS turns_with_duration,
    SUM(${completed} AND duration_quality = 'exact') AS exact_duration_turns,
    SUM(${completed} AND duration_quality = 'derived') AS derived_duration_turns,
    SUM(${completed} AND duration_quality = 'approximate') AS approximate_duration_turns,
    SUM(${completed} AND duration_ms IS NULL) AS missing_duration_turns`;
}

/**
 * 책임: 집계 결과에 필요한 이름·기간·세션 시작 열을 구성한다.
 * 알고리즘: 활성 차원만 projection에 포함하고 이름은 저장 metadata로 조회하며 세션 시작은 현재 날짜 필터와 독립적인 최소 요청 시각으로 구한다.
 */
function usageDimensions(scope: UsageScope, by: UsageBasis): string[] {
  // [DTO 정책] 활성 차원의 이름을 저장 메타데이터로 조회하고 비활성 차원은 NULL 열로 둔다.
  const dimensions = ['provider'];
  if (by === 'model') dimensions.push('model');
  dimensions.push(scope.project ? 'project_key' : 'NULL AS project_key');
  dimensions.push(scope.project
    ? `(
        SELECT project_name
        FROM projects p
        WHERE p.project_key = turn_summary.project_key
      ) AS project_name`
    : 'NULL AS project_name');
  dimensions.push(scope.session ? 'session_id' : 'NULL AS session_id');
  dimensions.push(scope.session
    ? `(
        SELECT session_name
        FROM sessions s
        WHERE s.provider = turn_summary.provider AND s.session_id = turn_summary.session_id
      ) AS session_name`
    : 'NULL AS session_name');
  // [기간 정책] 세션 시작 시각은 현재 조회 범위와 무관하게 전체 세션의 가장 이른 요청에서 찾는다.
  dimensions.push(scope.session
    ? `(
        SELECT MIN(t.started_at_ms)
        FROM turn_summary t
        WHERE t.provider = turn_summary.provider AND t.session_id = turn_summary.session_id
      ) AS session_started_at_ms`
    : 'NULL AS session_started_at_ms');
  dimensions.push(`${scope.period} AS period`);
  return dimensions;
}

// #endregion

// #region 통계 페이지와 전체 개수

/**
 * 책임: 기간·프로젝트·세션별 원본 통계 SQL을 생성한다.
 * 알고리즘: 공통 scope와 지표 식을 조합해 GROUP BY하고 미상 우선순위·전체 결과 정렬을 적용한 뒤 LIMIT·OFFSET을 붙인다.
 */
export function buildUsageQuery(filter: SummaryFilter, groupBy: UsageGrouping, timezone: string,
  by: UsageBasis, sortBy?: ChartMetric, tableSort?: UsageSort, withTotal = false): QuerySql {
  // [집계 정책] 원본을 공통 차원으로 묶고 옵션에 따라 구성별 평균·비용·전체 개수를 함께 계산한다.
  const scope = usageScope(filter, groupBy, timezone, by);
  const groups = scope.groups.join(', ');
  const metrics = {
    tokens: 'total_tokens',
    requests: 'turn_count',
    averageTokens: 'avg_tokens_per_turn',
    averageDuration: 'avg_duration_ms',
  };
  const metricOrder = sortBy ? `${metrics[sortBy]} DESC, ${groups}` : groups;
  const dimensions = usageDimensions(scope, by).join(',\n      ');
  const includeComponentAverages = filter.chartMetric === undefined || filter.chartMetric === 'averageTokens';
  const sums = usageSums(filter.excludeEmptyUsage, includeComponentAverages);
  const costs = filter.includeCosts ? `, ${COST_SUMS}` : '';
  const aggregateSql = `SELECT
      ${dimensions},
      ${sums}${costs}${withTotal ? ', COUNT(*) OVER() AS _total' : ''}
    FROM ${usageTurns(filter.includeCosts, by)} AS turn_summary
    WHERE ${scope.where}
    GROUP BY ${groups}`;

  // [페이지 정책] 표 정렬 또는 차트 지표 순서를 전체 그룹에 적용한 뒤 페이지를 자른다.
  const orderedSource = tableSort ? `SELECT * FROM (\n${aggregateSql}\n    )` : aggregateSql;
  const order = tableSort
    ? usageTableOrder(tableSort, groupBy, by === 'model', filter.includeCosts)
    : `${unknownOrder(by, scope.calendar ? 'period IS NULL' : undefined)}${metricOrder}`;
  return {
    sql: `${orderedSource}
    ORDER BY ${order}
    LIMIT ?
    OFFSET ?`,
    values: scope.values,
  };
}

export function buildUsageCountQuery(filter: SummaryFilter, groupBy: UsageGrouping, timezone: string, by: UsageBasis): QuerySql {
  // [페이지 정책] 행 조회와 같은 필터와 그룹 키를 사용해 페이지 적용 전 그룹 수를 센다.
  const scope = usageScope(filter, groupBy, timezone, by);
  return {
    sql: `SELECT COUNT(*) AS count
    FROM (
        SELECT ${scope.period} AS period
        FROM ${usageTurns(false, by)} AS turn_summary
        WHERE ${scope.where}
        GROUP BY ${scope.groups.join(', ')}
    )`,
    values: scope.values,
  };
}

// #endregion
