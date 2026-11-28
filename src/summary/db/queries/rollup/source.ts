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
  // [기간 정책] 달력 조회는 별도 지정이 없으면 날짜 미상 행을 포함하도록 필터를 보정한다.
  const calendar = grouping === 'day' || grouping === 'month';
  const usageFilter = calendar && filter.unknownTime === undefined
    ? { ...filter, unknownTime: 'include' as const }
    : filter;
  const { sql: where, values } = buildDailyUsageFilter(usageFilter, timezone);

  // [SQL 조회 정책] 활성 집계 열만 읽고 비용 요청에 한해 비용 상태와 세션별 결제 재분류를 읽는다.
  const columns = [
    'provider', 'project_key', 'session_id', 'local_day',
    ...(by === 'model' ? ['model'] : []),
    ...rollupStates(by).map(state => state.name),
  ];
  if (filter.includeCosts) columns.push(...DAILY_COST_STATES.map(state => state.name),
    `(SELECT billing_mode FROM sessions b
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
  // [SQL 필터 정책] 공통 식별자·이름 조건에 현지 일자 조건을 덧붙인다.
  const { fromMs, toMs, unknownTime, ...dimensions } = filter;
  const { sql, values } = buildQueryFilter(dimensions, 'usage');
  const dateConditions = ["local_day <> ''"];

  // [기간 정책] 경계가 유효한 밀리초 정수와 일자인지 검증하고 날짜 범위를 적용할 때만 현지 자정을 요구한다.
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

  // [기간 정책] 날짜 미상은 빈 날짜 키로 찾아 포함·제외·미상만 보기 옵션을 적용한다.
  if (unknownTime === 'only') return { sql: `${sql} AND local_day = ''`, values };
  if (dateConditions.length === 1 && unknownTime !== 'exclude') return { sql, values };
  const dates = dateConditions.join(' AND ');
  return { sql: `${sql} AND ((${dates})${unknownTime === 'include' ? " OR local_day = ''" : ''})`, values };
}

/** 소실된 행을 정리할 때 새 집계와 같은 날짜·모델 키를 사용한다. */
export function dailyKeySource(by: UsageBasis): string {
  // [SQL 조회 정책] 미리 계산한 일자와 원래 모델명을 받고 모델 키는 삽입과 같은 식으로 계산한다.
  const columns = dailyKeyColumns(by);
  const extract = columns.map((key, index) =>
    `json_extract(value, '$[${index}]') AS ${key === 'model_key' ? 'model' : key}`);
  const keys = columns.map(key => key === 'model_key' ? MODEL_KEY : key);
  return `SELECT ${keys.join(', ')} FROM (SELECT ${extract.join(', ')} FROM json_each(?))`;
}

/** 스레드 합계를 현지 날짜와 모델별로 묶어 합계와 평균 표본 수를 계산한다. */
export function aggregateUsageSource(by: UsageBasis, source: string, localDay = LOCAL_DAY): string {
  // [집계 정책] 현지 날짜와 활성 모델 차원으로 투영하고 양수 토큰이나 모델 기록을 사용량 표본으로 표시한다.
  const input = [
    'provider', 'project_key', 'session_id',
    `${localDay} AS local_day`,
    ...(by === 'model' ? ['model'] : ['started_at_ms']),
    'input_tokens', 'output_tokens', 'total_tokens',
    'cache_write_input_tokens', 'cache_read_input_tokens',
    'status', 'duration_ms', 'duration_quality',
    'CASE WHEN total_tokens > 0 THEN 1 ELSE has_model END AS has_recorded_usage',
    'api_cost_usd', 'api_unknown_costs', 'cost_components', 'default_billing_mode',
  ];

  // [집계 정책] 일별 그룹 키와 합계·평균에 필요한 상태 열을 조합한다.
  const columns = ['provider', 'project_key', 'session_id', 'local_day'];
  if (by === 'model') {
    columns.push('model', `${MODEL_KEY} AS model_key`);
  }
  columns.push(...[...rollupStates(by), ...DAILY_COST_STATES].map(state => `${state.expression} AS ${state.name}`));

  // [SQL 조회 정책] MATERIALIZED CTE에서 일자와 사용량 표본을 먼저 계산한 뒤 일별 키로 묶는다.
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
