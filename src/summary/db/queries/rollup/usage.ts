// 일별 소스와 병합 지표를 조합해 통계 행·개수 조회 SQL을 생성한다.
import type { ChartMetric, SummaryFilter, UsageGrouping, UsageSort } from '../../types';
import { buildQueryFilter } from '../common/filters';
import type { QuerySql, UsageBasis } from '../common/types';
import { usageTableOrder } from '../common/sorting';
import { mergeRollupMetrics } from './metrics';
import { buildDailyUsageSource } from './source';
import { ROLLUP_TABLES } from '../../rollup-state';
import { calendarPeriod } from '../../timezone';

export interface RollupUsageQueries {
  mode: 'rollup' | 'rollup-plus-raw-boundaries';
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

// #region 최종 행·개수 조회

/**
 * 책임: 사용 가능한 조건에서 일별 사전 집계 기반의 행·개수 SQL을 만든다.
 * 알고리즘: 입력 검증 후 일별 소스·차원·병합 지표를 조합하고 미지원 조건은 원본 조회에 돌린다.
 */
export function buildRollupUsageQueries(
  filter: SummaryFilter, grouping: UsageGrouping, timezone: string,
  by: UsageBasis, sortBy?: ChartMetric, tableSort?: UsageSort,
): RollupUsageQueries | undefined {
  if (!['total', 'project', 'session', 'day', 'month'].includes(grouping)) throw new RangeError('Unknown usage grouping');
  if (by !== 'provider' && by !== 'model') throw new RangeError('Unknown usage grouping basis');
  buildQueryFilter(filter); // 원본 대체 경로에서도 epoch 정수 검증을 먼저 수행한다.

  const calendar = grouping === 'day' || grouping === 'month';
  try {
    calendarPeriod(0, timezone, 'day');
  } catch (error) {
    if (calendar) throw error;
    return undefined;
  }

  const emptyRange = filter.fromMs !== undefined && filter.toMs !== undefined && filter.fromMs >= filter.toMs;
  if (filter.includeCosts || emptyRange) return undefined;
  if (!supportsCalendarBounds(filter, timezone)) return undefined;

  const source = buildDailyUsageSource(filter, grouping, timezone, by);
  const dimensions = rollupDimensions(grouping, by);
  const groupColumns = dimensions.groups.join(', ');
  const groupedRows = `SELECT
      ${dimensions.columns.join(',\n      ')},
      ${mergeRollupMetrics(filter.excludeEmptyUsage)}
    FROM (
      ${source.sql}
    ) AS turn_summary
    GROUP BY ${groupColumns}`;

  const metricOrder = sortBy ? `${METRIC_COLUMNS[sortBy]} DESC, ${groupColumns}` : groupColumns;
  const orderedSource = tableSort
    ? `SELECT * FROM (
        ${groupedRows}
      )`
    : groupedRows;
  const order = tableSort
    ? usageTableOrder(tableSort, grouping, by === 'model')
    : rollupUnknownOrder(dimensions.calendar, by) + metricOrder;
  const rowsSql = `${orderedSource}
    ORDER BY ${order}
    LIMIT ?
    OFFSET ?`;

  return {
    mode: source.boundary ? 'rollup-plus-raw-boundaries' : 'rollup',
    rows: { sql: rowsSql, values: source.values },
    count: {
      sql: `SELECT COUNT(*) AS count
        FROM (
          SELECT ${dimensions.period} AS period
          FROM (
            ${source.sql}
          ) AS turn_summary
          GROUP BY ${groupColumns}
        )`,
      values: source.values,
    },
  };
}

// #endregion

// #region 조회 차원·기간·정렬

function rollupDimensions(grouping: UsageGrouping, by: UsageBasis): RollupDimensions {
  const calendar = grouping === 'day' || grouping === 'month';
  const project = grouping === 'project' || grouping === 'session';
  const session = grouping === 'session';
  const period = rollupPeriod(grouping);
  const groups = ['provider'];
  if (by === 'model') groups.push('model');
  if (project) groups.push('project_key');
  if (session) groups.push('session_id');
  if (calendar) groups.push('period');

  const projectName = project
    ? `(SELECT project_name
        FROM projects p
        WHERE p.project_key = turn_summary.project_key) AS project_name`
    : 'NULL AS project_name';
  const sessionName = session
    ? `(SELECT session_name
        FROM sessions s
        WHERE s.provider = turn_summary.provider AND s.session_id = turn_summary.session_id) AS session_name`
    : 'NULL AS session_name';
  const sessionStartedAt = session
    ? `(SELECT MIN(d.min_started_at_ms)
        FROM ${ROLLUP_TABLES.provider} d
        WHERE d.provider = turn_summary.provider AND d.session_id = turn_summary.session_id) AS session_started_at_ms`
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
  switch (grouping) {
    case 'day':
      return "NULLIF(local_day, '')";
    case 'month':
      return "substr(NULLIF(local_day, ''), 1, length(local_day) - 3)";
    default:
      return 'NULL';
  }
}

function rollupUnknownOrder(calendar: boolean, by: UsageBasis): string {
  const unknown: string[] = [];
  if (calendar) unknown.push('period IS NULL');
  if (by === 'model') unknown.push("coalesce(model, '') = ''");

  if (unknown.length > 1) return `(${unknown.join(' OR ')}), ${unknown.join(', ')}, `;
  if (unknown.length) return `${unknown[0]}, `;
  return '';
}

// #endregion

// #region 원본 조회로 대체할 달력 범위

function supportsCalendarBounds(filter: SummaryFilter, timezone: string): boolean {
  // periodBounds는 네 자리 서기 연도만 지원한다. 그 밖의 범위는 원본 조회의 의미를 유지한다.
  for (const timestampMs of [filter.fromMs, filter.toMs]) {
    if (timestampMs === undefined) continue;
    if (!Number.isFinite(new Date(timestampMs).getTime())) return false;

    const date = calendarPeriod(timestampMs, timezone, 'day');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
    const year = Number(date.slice(0, 4));
    if (year < 2 || year > 9998) return false;
  }
  return true;
}

// #endregion
