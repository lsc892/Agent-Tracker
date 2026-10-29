// 완전한 현지 일의 사전 집계와 양끝의 원본 요청을 중복 없이 결합한다.
import type { SQLInputValue } from 'node:sqlite';
import type { SummaryFilter, UsageGrouping } from '../../types';
import { buildQueryFilter } from '../common/filters';
import type { QuerySql, UsageBasis } from '../common/types';
import { usageTurns } from '../raw/source';
import { ROLLUP_STATES, ROLLUP_TABLES } from '../../rollup-state';
import { calendarPeriod, periodBounds } from '../../timezone';

interface FullDayBounds {
  startMs?: number;
  endMs?: number;
}

// #region 조회 소스: 완전한 날짜 + 원본 경계

/**
 * 책임: 기간 필터의 완전한 현지 일과 부분 경계를 중복 없이 결합한다.
 * 알고리즘: 일별 집계에 날짜·미상 정책을 적용하고 필요한 원본 경계만 UNION ALL한다.
 */
export function buildDailyUsageSource(
  filter: SummaryFilter, grouping: UsageGrouping, timezone: string, by: UsageBasis,
): QuerySql & { boundary: boolean } {
  const calendar = grouping === 'day' || grouping === 'month';
  const usageFilter = calendar && filter.unknownTime === undefined
    ? { ...filter, unknownTime: 'include' as const }
    : filter;
  const dimensions = buildQueryFilter({
    ...usageFilter, fromMs: undefined, toMs: undefined, unknownTime: undefined,
  });
  const knownAllowed = usageFilter.unknownTime !== 'only';
  const unknownAllowed = usageFilter.unknownTime === 'only'
    || usageFilter.unknownTime === 'include'
    || usageFilter.unknownTime !== 'exclude' && usageFilter.fromMs === undefined && usageFilter.toMs === undefined;

  const bounds = fullDayBounds(usageFilter, timezone);
  const fullDays = fullDayFilter(bounds, knownAllowed, timezone);
  const columns = [
    'provider', 'project_key', 'session_id', 'local_day',
    ...(by === 'model' ? ['model', 'model_key'] : []),
    ...ROLLUP_STATES.map(state => state.name),
  ];
  const unknownDay = unknownAllowed ? " OR local_day = ''" : '';
  const sql = `SELECT
      ${columns.join(',\n      ')}
    FROM ${ROLLUP_TABLES[by]} AS turn_summary
    WHERE ${dimensions.sql}
      AND ((${fullDays.sql})${unknownDay})`;
  const values = [...dimensions.values, ...fullDays.values];

  // 완전한 날짜와 양끝의 부분 날짜는 겹치지 않으며, 미상 시각은 일별 집계에서만 읽는다.
  const partialStart = usageFilter.fromMs !== undefined && bounds.startMs !== usageFilter.fromMs;
  const partialEnd = usageFilter.toMs !== undefined && bounds.endMs !== usageFilter.toMs;
  const boundary = knownAllowed && (partialStart || partialEnd);
  if (!boundary) return { sql, values, boundary };

  const raw = rawBoundarySource(usageFilter, bounds, timezone, by);
  return {
    sql: `${sql}
      UNION ALL
      ${raw.sql}`,
    values: [...values, ...raw.values],
    boundary,
  };
}

function fullDayBounds(filter: SummaryFilter, timezone: string): FullDayBounds {
  let startMs: number | undefined;
  if (filter.fromMs !== undefined) {
    const day = calendarPeriod(filter.fromMs, timezone, 'day');
    const bounds = periodBounds(day, timezone);
    startMs = filter.fromMs === bounds.fromMs ? bounds.fromMs : bounds.toMs;
  }

  let endMs: number | undefined;
  if (filter.toMs !== undefined) {
    const day = calendarPeriod(filter.toMs, timezone, 'day');
    endMs = periodBounds(day, timezone).fromMs;
  }
  return { startMs, endMs };
}

function fullDayFilter(bounds: FullDayBounds, knownAllowed: boolean, timezone: string): QuerySql {
  const { startMs, endMs } = bounds;
  const clauses = ["local_day <> ''"];
  const values: SQLInputValue[] = [];
  const emptyRange = startMs !== undefined && endMs !== undefined && startMs >= endMs;
  if (!knownAllowed || emptyRange) {
    clauses.push('0 = 1');
    return { sql: clauses.join(' AND '), values };
  }

  if (startMs !== undefined) {
    clauses.push('local_day >= ?');
    values.push(calendarPeriod(startMs, timezone, 'day'));
  }
  if (endMs !== undefined) {
    clauses.push('local_day < ?');
    values.push(calendarPeriod(endMs, timezone, 'day'));
  }
  return { sql: clauses.join(' AND '), values };
}

function rawBoundarySource(filter: SummaryFilter, bounds: FullDayBounds, timezone: string, by: UsageBasis): QuerySql {
  const raw = buildQueryFilter({ ...filter, unknownTime: 'exclude' });
  const outsideDays: string[] = [];
  const values: SQLInputValue[] = [];
  if (bounds.startMs !== undefined) {
    outsideDays.push('started_at_ms < ?');
    values.push(bounds.startMs);
  }
  if (bounds.endMs !== undefined) {
    outsideDays.push('started_at_ms >= ?');
    values.push(bounds.endMs);
  }
  const where = `${raw.sql} AND (${outsideDays.join(' OR ')})`;
  return {
    sql: aggregateUsageSource(by, where),
    values: [timezone, ...raw.values, ...values],
  };
}

// #endregion

// #region 원본 요청의 일별 집계: 저장과 경계 조회가 공유

/**
 * 책임: 원본 요청을 다시 병합할 수 있는 일별 상태로 변환한다.
 * 알고리즘: 시간대 바인딩과 제공자·프로젝트·세션·현지 일·모델 키로 공통 합계·표본 수를 집계한다.
 */
export function aggregateUsageSource(by: UsageBasis, where = '1 = 1'): string {
  const columns = [
    'provider', 'project_key', 'session_id',
    "coalesce(agent_tracker_period(started_at_ms, ?, 'day'), '') AS local_day",
  ];
  const groups = ['provider', 'project_key', 'session_id', 'local_day'];
  if (by === 'model') {
    columns.push('model', `CASE
        WHEN model IS NULL THEN 'N'
        ELSE 'V' || model
      END AS model_key`);
    groups.push('model_key');
  }
  columns.push(...ROLLUP_STATES.map(state => `${state.expression} AS ${state.name}`));

  return `SELECT
      ${columns.join(',\n      ')}
    FROM ${usageTurns(false, by)} AS turn_summary
    WHERE ${where}
    GROUP BY ${groups.join(', ')}`;
}

// #endregion
