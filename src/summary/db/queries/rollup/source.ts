// 일별 결과의 조회 조건과 메모리 입력의 일별 집계 SQL을 만든다.
import type { SummaryFilter, UsageGrouping } from '../../types';
import { buildQueryFilter } from '../common/filters';
import type { QuerySql, UsageBasis } from '../common/types';
import { DAILY_COST_STATES, dailyKeyColumns, rollupStates, ROLLUP_TABLES } from '../../rollup-state';
import { calendarPeriod, periodBounds } from '../../timezone';

const LOCAL_DAY = "coalesce(agent_tracker_period(started_at_ms, ?, 'day'), '')";
const MODEL_KEY = "CASE WHEN model IS NULL THEN 'N' ELSE 'V' || model END";

export function buildDailyUsageSource(
  filter: SummaryFilter, grouping: UsageGrouping, timezone: string, by: UsageBasis,
): QuerySql {
  const calendar = grouping === 'day' || grouping === 'month';
  const usageFilter = calendar && filter.unknownTime === undefined
    ? { ...filter, unknownTime: 'include' as const }
    : filter;
  const { sql: where, values } = buildDailyUsageFilter(usageFilter, timezone);
  const columns = [
    'provider', 'project_key', 'session_id', 'local_day',
    ...(by === 'model' ? ['model'] : []),
    ...rollupStates(by).map(state => state.name),
  ];
  if (filter.includeCosts) columns.push(...DAILY_COST_STATES.map(state => state.name),
    `(SELECT billing_mode FROM session_billing b
      WHERE b.provider=usage.provider AND b.session_id=usage.session_id) AS billing_override`);
  return {
    sql: `SELECT
      ${columns.join(',\n      ')}
    FROM ${ROLLUP_TABLES[by]} AS usage
    WHERE ${where}`,
    values,
  };
}

/** 날짜 범위는 통계 시간대에서 각 날짜가 시작되는 시각으로 받는다. */
export function buildDailyUsageFilter(filter: SummaryFilter, timezone: string): QuerySql {
  const { fromMs, toMs, unknownTime, ...dimensions } = filter;
  const { sql, values } = buildQueryFilter(dimensions, 'usage');
  const dateConditions = ["local_day <> ''"];
  for (const [bound, operator, timestamp] of [['fromMs', '>=', fromMs], ['toMs', '<', toMs]] as const) {
    if (timestamp === undefined) continue;
    if (!Number.isSafeInteger(timestamp)) throw new RangeError(`${bound} must be an epoch millisecond integer`);
    const day = calendarPeriod(timestamp, timezone, 'day');
    const year = Number(day.slice(0, 4));
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || year < 2 || year > 9998) throw new RangeError('Unsupported usage date');
    if (unknownTime === 'only') continue;
    if (periodBounds(day, timezone).fromMs !== timestamp) throw new RangeError('Daily usage requires local midnight bounds');
    dateConditions.push(`local_day ${operator} ?`);
    values.push(day);
  }
  if (unknownTime === 'only') return { sql: `${sql} AND local_day = ''`, values };
  if (dateConditions.length === 1 && unknownTime !== 'exclude') return { sql, values };
  const dates = dateConditions.join(' AND ');
  return { sql: `${sql} AND ((${dates})${unknownTime === 'include' ? " OR local_day = ''" : ''})`, values };
}

/** 소실된 행을 정리할 때 새 집계와 같은 날짜·모델 키를 사용한다. */
export function dailyKeySource(by: UsageBasis, source: string): string {
  const keys = dailyKeyColumns(by).map(key => key === 'local_day' ? LOCAL_DAY : key === 'model_key' ? MODEL_KEY : key);
  return `SELECT ${keys.join(', ')} FROM ${source} AS usage`;
}

/** 스레드 합계를 현지 날짜와 모델별로 묶어 합계와 평균 표본 수를 계산한다. */
export function aggregateUsageSource(by: UsageBasis, source: string): string {
  const input = [
    'provider', 'project_key', 'session_id',
    `${LOCAL_DAY} AS local_day`,
    ...(by === 'model' ? ['model'] : ['started_at_ms']),
    'input_tokens', 'output_tokens', 'total_tokens',
    'cache_write_input_tokens', 'cache_read_input_tokens',
    'status', 'duration_ms', 'duration_quality',
    // Positive tokens already qualify; only zero-token requests need the model lookup.
    'CASE WHEN total_tokens > 0 THEN 1 ELSE has_model END AS has_recorded_usage',
    'api_cost_usd', 'api_unknown_costs', 'cost_components', 'default_billing_mode',
  ];
  const columns = ['provider', 'project_key', 'session_id', 'local_day'];
  if (by === 'model') {
    columns.push('model', `${MODEL_KEY} AS model_key`);
  }
  columns.push(...[...rollupStates(by), ...DAILY_COST_STATES].map(state => `${state.expression} AS ${state.name}`));

  return `WITH scoped AS MATERIALIZED (
      SELECT
        ${input.join(',\n        ')}
      FROM ${source} AS usage
    )
    SELECT
      ${columns.join(',\n      ')}
    FROM scoped
    GROUP BY ${dailyKeyColumns(by).join(', ')}`;
}
