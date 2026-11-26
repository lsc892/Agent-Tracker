// 일별 소스와 병합 지표를 조합해 통계 행·개수 조회 SQL을 생성한다.
import type { ChartMetric, SummaryFilter, UsageGrouping, UsageSort } from '../../types';
import type { QuerySql, UsageBasis } from '../common/types';
import { unknownOrder, usageTableOrder } from '../common/sorting';
import { mergeRollupMetrics } from './metrics';
import { buildDailyUsageSource } from './source';
import { ROLLUP_TABLES } from '../../rollup-state';
import { calendarPeriod } from '../../timezone';

export interface RollupUsageQueries {
  rows: QuerySql;
  count: QuerySql;
}

interface RollupDimensions {
  calendar: boolean;
  period: string;
  groups: string[];
  columns: string[];
}

const METRIC_COLUMNS: Record<ChartMetric, string> = {
  tokens: 'total_tokens',
  requests: 'turn_count',
  averageTokens: 'avg_tokens_per_turn',
  averageDuration: 'avg_duration_ms',
};

// [결제 정책] 세션 결제 재분류가 있으면 구독·API·미상 기준으로 보존된 일별 비용 상태를 다시 해석한다.
const DAILY_COSTS = `,
  SUM(CASE billing_override WHEN 'subscription' THEN 0 WHEN 'api' THEN api_cost_usd
    WHEN 'unknown' THEN NULL ELSE recorded_cost_usd END) AS cost_usd,
  SUM(CASE billing_override WHEN 'subscription' THEN 0 WHEN 'api' THEN api_unknown_costs
    WHEN 'unknown' THEN cost_components ELSE recorded_unknown_costs END) AS unknown_costs,
  CASE WHEN MIN(coalesce(billing_override, default_billing_mode)) = MAX(coalesce(billing_override, default_billing_mode))
    THEN MIN(coalesce(billing_override, default_billing_mode)) ELSE 'unknown' END AS billing_mode`;

// #region 최종 행·개수 조회

/**
 * 일별 합계의 조회 차원·지표·정렬을 조합해 행·개수 SQL을 만든다.
 */
export function buildRollupUsageQueries(
  filter: SummaryFilter, grouping: UsageGrouping, timezone: string,
  by: UsageBasis, sortBy?: ChartMetric, tableSort?: UsageSort, withTotal = false,
): RollupUsageQueries {
  // [SQL 조회 정책] 그룹·집계 기준과 통계 시간대를 검증한 뒤 일별 테이블을 선택한다.
  if (!['total', 'project', 'session', 'day', 'month'].includes(grouping)) throw new RangeError('Unknown usage grouping');
  if (by !== 'provider' && by !== 'model') throw new RangeError('Unknown usage grouping basis');
  calendarPeriod(0, timezone, 'day');

  const source = buildDailyUsageSource(filter, grouping, timezone, by);

  // [집계 정책] 요청한 차원으로 일별 상태를 병합하고 필요한 평균·비용·전체 개수 열만 추가한다.
  const dimensions = rollupDimensions(grouping, by);
  const groupColumns = dimensions.groups.join(', ');
  const includeComponentAverages = filter.chartMetric === undefined || filter.chartMetric === 'averageTokens';
  const groupedRows = `SELECT
      ${dimensions.columns.join(',\n      ')},
      ${mergeRollupMetrics(filter.excludeEmptyUsage, includeComponentAverages)}${filter.includeCosts ? DAILY_COSTS : ''}${withTotal ? ', COUNT(*) OVER() AS _total' : ''}
    FROM (
      ${source.sql}
    ) AS usage
    GROUP BY ${groupColumns}`;

  // [페이지 정책] 표 정렬 또는 지표 순서를 전체 그룹에 적용한 뒤 페이지를 자른다.
  const metricOrder = sortBy ? `${METRIC_COLUMNS[sortBy]} DESC, ${groupColumns}` : groupColumns;
  const orderedSource = tableSort
    ? `SELECT * FROM (
        ${groupedRows}
      )`
    : groupedRows;
  const order = tableSort
    ? usageTableOrder(tableSort, grouping, by === 'model', filter.includeCosts)
    : unknownOrder(by, dimensions.calendar ? 'period IS NULL' : undefined) + metricOrder;
  const rowsSql = `${orderedSource}
    ORDER BY ${order}
    LIMIT ?
    OFFSET ?`;

  // [페이지 정책] 전체 개수도 같은 일별 범위와 그룹 키를 사용한다.
  return {
    rows: { sql: rowsSql, values: source.values },
    count: {
      sql: `SELECT COUNT(*) AS count
        FROM (
          SELECT ${dimensions.period} AS period
          FROM (
            ${source.sql}
          ) AS usage
          GROUP BY ${groupColumns}
        )`,
      values: source.values,
    },
  };
}

// #endregion
// #region 조회 차원·기간·정렬

function rollupDimensions(grouping: UsageGrouping, by: UsageBasis): RollupDimensions {
  // [집계 정책] 제공자는 항상 그룹에 두고 선택된 모델·프로젝트·세션·기간 차원만 더한다.
  const calendar = grouping === 'day' || grouping === 'month';
  const project = grouping === 'project' || grouping === 'session';
  const session = grouping === 'session';
  const period = rollupPeriod(grouping);
  const groups = ['provider'];
  if (by === 'model') groups.push('model');
  if (project) groups.push('project_key');
  if (session) groups.push('session_id');
  if (calendar) groups.push('period');

  // [DTO 정책] 이름은 저장 메타데이터를 읽고 세션 시작 시각은 기간과 무관한 일별 최솟값으로 구한다.
  const projectName = project
    ? `(SELECT project_name
        FROM projects p
        WHERE p.project_key = usage.project_key) AS project_name`
    : 'NULL AS project_name';
  const sessionName = session
    ? `(SELECT session_name
        FROM sessions s
        WHERE s.provider = usage.provider AND s.session_id = usage.session_id) AS session_name`
    : 'NULL AS session_name';
  const sessionStartedAt = session
    ? `(SELECT MIN(d.min_started_at_ms)
        FROM ${ROLLUP_TABLES.provider} d
        WHERE d.provider = usage.provider AND d.session_id = usage.session_id) AS session_started_at_ms`
    : 'NULL AS session_started_at_ms';

  return {
    calendar,
    period,
    groups,
    columns: [
      'provider',
      ...(by === 'model' ? ['model'] : []),
      project ? 'project_key' : 'NULL AS project_key',
      projectName,
      session ? 'session_id' : 'NULL AS session_id',
      sessionName,
      sessionStartedAt,
      `${period} AS period`,
    ],
  };
}

function rollupPeriod(grouping: UsageGrouping): string {
  // [기간 정책] 일자 키로 일·월 값을 만들고 빈 키는 기간 미상으로 유지한다.
  switch (grouping) {
    case 'day':
      return "NULLIF(local_day, '')";
    case 'month':
      return "substr(NULLIF(local_day, ''), 1, length(local_day) - 3)";
    default:
      return 'NULL';
  }
}

// #endregion
