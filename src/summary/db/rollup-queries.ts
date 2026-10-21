import type { SQLInputValue } from 'node:sqlite';
import type { ChartMetric, SummaryFilter, UsageGrouping, UsageSort } from './types';
import { usageTableOrder } from './sorting';
import { buildQueryFilter, usageTurns, type QuerySql, type UsageBasis } from './queries';
import { ROLLUP_STATES, ROLLUP_TABLES } from './rollup-state';
import { calendarPeriod, periodBounds } from './timezone';

export interface RollupUsageQueries {
  mode: 'rollup' | 'rollup-plus-raw-boundaries';
  rows: QuerySql;
  count: QuerySql;
}

/** The timezone is always a binding; session/date values never become SQL text. */
export function aggregateUsageSource(by: UsageBasis, where = '1 = 1'): string {
  const model = by === 'model' ? ", model, CASE WHEN model IS NULL THEN 'N' ELSE 'V' || model END AS model_key" : '';
  const groups = `provider, project_key, session_id, local_day${by === 'model' ? ', model_key' : ''}`;
  return `SELECT provider, project_key, session_id,
    coalesce(agent_tracker_period(started_at_ms, ?, 'day'), '') AS local_day${model},
    ${ROLLUP_STATES.map(state => `${state.expression} AS ${state.name}`).join(',\n    ')}
    FROM ${usageTurns(false, by)} AS turn_summary WHERE ${where} GROUP BY ${groups}`;
}

function effectiveFilter(filter: SummaryFilter, grouping: UsageGrouping): SummaryFilter {
  return (grouping === 'day' || grouping === 'month') && filter.unknownTime === undefined
    ? { ...filter, unknownTime: 'include' } : filter;
}

function dailySources(filter: SummaryFilter, grouping: UsageGrouping, timezone: string, by: UsageBasis): QuerySql & { boundary: boolean } {
  const f = effectiveFilter(filter, grouping);
  const dimensions = buildQueryFilter({ ...f, fromMs: undefined, toMs: undefined, unknownTime: undefined });
  const knownAllowed = f.unknownTime !== 'only';
  const unknownAllowed = f.unknownTime === 'only' || f.unknownTime === 'include'
    || f.unknownTime !== 'exclude' && f.fromMs === undefined && f.toMs === undefined;
  let start: number | undefined, end: number | undefined;
  if (f.fromMs !== undefined) {
    const bounds = periodBounds(calendarPeriod(f.fromMs, timezone, 'day'), timezone);
    start = f.fromMs === bounds.fromMs ? bounds.fromMs : bounds.toMs;
  }
  if (f.toMs !== undefined) end = periodBounds(calendarPeriod(f.toMs, timezone, 'day'), timezone).fromMs;
  const full = ["local_day <> ''"];
  const fullValues: SQLInputValue[] = [];
  if (!knownAllowed || start !== undefined && end !== undefined && start >= end) full.push('0 = 1');
  else {
    if (start !== undefined) { full.push('local_day >= ?'); fullValues.push(calendarPeriod(start, timezone, 'day')); }
    if (end !== undefined) { full.push('local_day < ?'); fullValues.push(calendarPeriod(end, timezone, 'day')); }
  }
  const columns = `provider,project_key,session_id,local_day${by === 'model' ? ',model,model_key' : ''},${ROLLUP_STATES.map(state => state.name).join(',')}`;
  let sql = `SELECT ${columns} FROM ${ROLLUP_TABLES[by]} AS turn_summary
    WHERE ${dimensions.sql} AND ((${full.join(' AND ')})${unknownAllowed ? " OR local_day = ''" : ''})`;
  const values = [...dimensions.values, ...fullValues];
  // Full local days and raw boundary ranges are disjoint; unknown timestamps only use the rollup.
  const boundary = knownAllowed && (f.fromMs !== undefined && start !== f.fromMs || f.toMs !== undefined && end !== f.toMs);
  if (boundary) {
    const raw = buildQueryFilter({ ...f, unknownTime: 'exclude' });
    const outside: string[] = [];
    const outsideValues: SQLInputValue[] = [];
    if (start !== undefined) { outside.push('started_at_ms < ?'); outsideValues.push(start); }
    if (end !== undefined) { outside.push('started_at_ms >= ?'); outsideValues.push(end); }
    sql += ` UNION ALL ${aggregateUsageSource(by, `${raw.sql} AND (${outside.join(' OR ')})`)}`;
    values.push(timezone, ...raw.values, ...outsideValues);
  }
  return { sql, values, boundary };
}

function mergeMetrics(excludeEmptyUsage = false): string {
  const sum = (field: string): string => `SUM(${field})`;
  const average = (field: string, denominator: string): string => `1.0 * SUM(${field}) / NULLIF(SUM(${denominator}),0)`;
  const prefix = excludeEmptyUsage ? 'r' : 'c';
  const denominator = excludeEmptyUsage ? 'recorded_completed_turns' : 'completed_turns';
  return [
    ...['input_tokens', 'output_tokens'].map(field => `${sum(field)} AS ${field}`),
    ...['cache_write_input_tokens', 'cache_read_input_tokens'].map(field => `CASE WHEN ${sum(`${field}_known`)} = ${sum('turn_count')} THEN ${sum(field)} END AS ${field}`),
    ...['total_tokens', 'turn_count', 'completed_turns', 'recorded_turns', 'recorded_completed_turns'].map(field => `${sum(field)} AS ${field}`),
    ...[['total_tokens', 'avg_tokens_per_turn'], ['input_tokens', 'avg_input_tokens'], ['output_tokens', 'avg_output_tokens']]
      .map(([field, alias]) => `${average(`${prefix}_${field}`, denominator)} AS ${alias}`),
    ...['cache_write_input_tokens', 'cache_read_input_tokens'].map(field => `CASE WHEN ${sum(`${prefix}_${field}_known`)} = ${sum(denominator)} THEN ${average(`${prefix}_${field}`, denominator)} END AS avg_${field}`),
    `${average(`${prefix}_duration_ms`, `${prefix}_duration_ms_known`)} AS avg_duration_ms`,
    `${sum(`${prefix}_duration_ms_known`)} AS turns_with_duration`,
    ...['exact', 'derived', 'approximate'].map(quality => `${sum(`${prefix}_${quality}`)} AS ${quality}_duration_turns`),
    `${sum(`${prefix}_duration_missing`)} AS missing_duration_turns`,
    ...['unknown_time_turns', 'stale_turns'].map(field => `${sum(field)} AS ${field}`),
    'MAX(last_successful_update) AS last_successful_update',
  ].join(',\n      ');
}

/** Undefined selects the unchanged raw builder for unsupported costs/calendar ranges. */
export function buildRollupUsageQueries(filter: SummaryFilter, grouping: UsageGrouping, timezone: string,
  by: UsageBasis, sortBy?: ChartMetric, tableSort?: UsageSort): RollupUsageQueries | undefined {
  if (!['total', 'project', 'session', 'day', 'month'].includes(grouping)) throw new RangeError('Unknown usage grouping');
  if (by !== 'provider' && by !== 'model') throw new RangeError('Unknown usage grouping basis');
  buildQueryFilter(filter); // Preserve epoch-integer validation even on fallback paths.
  const calendar = grouping === 'day' || grouping === 'month';
  try { calendarPeriod(0, timezone, 'day'); }
  catch (error) { if (calendar) throw error; return undefined; }
  if (filter.includeCosts || filter.fromMs !== undefined && filter.toMs !== undefined && filter.fromMs >= filter.toMs) return undefined;
  // periodBounds intentionally supports four-digit AD calendar years. Other ranges keep raw semantics.
  for (const ms of [filter.fromMs, filter.toMs]) {
    if (ms === undefined) continue;
    if (!Number.isFinite(new Date(ms).getTime())) return undefined;
    const date = calendarPeriod(ms, timezone, 'day');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
    const year = Number(date.slice(0, 4));
    if (year < 2 || year > 9998) return undefined;
  }
  const source = dailySources(filter, grouping, timezone, by);
  const project = grouping === 'project' || grouping === 'session', session = grouping === 'session';
  const period = grouping === 'day' ? "NULLIF(local_day,'')" : grouping === 'month'
    ? "substr(NULLIF(local_day,''),1,length(local_day)-3)" : 'NULL';
  const groups = ['provider', ...(by === 'model' ? ['model'] : []), ...(project ? ['project_key'] : []), ...(session ? ['session_id'] : []), ...(calendar ? ['period'] : [])];
  const dimensions = [
    'provider', ...(by === 'model' ? ['model'] : []), project ? 'project_key' : 'NULL AS project_key',
    project ? '(SELECT project_name FROM projects p WHERE p.project_key = turn_summary.project_key) AS project_name' : 'NULL AS project_name',
    session ? 'session_id' : 'NULL AS session_id',
    session ? '(SELECT session_name FROM sessions s WHERE s.provider = turn_summary.provider AND s.session_id = turn_summary.session_id) AS session_name' : 'NULL AS session_name',
    session ? `(SELECT MIN(d.min_started_at_ms) FROM ${ROLLUP_TABLES.provider} d WHERE d.provider = turn_summary.provider AND d.session_id = turn_summary.session_id) AS session_started_at_ms` : 'NULL AS session_started_at_ms',
    `${period} AS period`,
  ];
  const unknown = [...(calendar ? ['period IS NULL'] : []), ...(by === 'model' ? ["coalesce(model,'') = ''"] : [])];
  const unknownOrder = unknown.length > 1 ? `(${unknown.join(' OR ')}), ${unknown.join(', ')}, ` : unknown.length ? `${unknown[0]}, ` : '';
  const metrics = { tokens: 'total_tokens', requests: 'turn_count', averageTokens: 'avg_tokens_per_turn', averageDuration: 'avg_duration_ms' };
  const order = sortBy ? `${metrics[sortBy]} DESC, ${groups.join(',')}` : groups.join(',');
  return {
    mode: source.boundary ? 'rollup-plus-raw-boundaries' : 'rollup',
    rows: {
      sql: `${tableSort ? 'SELECT * FROM (' : ''}SELECT ${dimensions.join(',\n      ')}, ${mergeMetrics(filter.excludeEmptyUsage)}
        FROM (${source.sql}) AS turn_summary
        GROUP BY ${groups.join(',')} ${tableSort ? `) ORDER BY ${usageTableOrder(tableSort, grouping, by === 'model')}`
          : `ORDER BY ${unknownOrder}${order}`} LIMIT ? OFFSET ?`,
      values: source.values,
    },
    count: {
      sql: `SELECT COUNT(*) AS count FROM (SELECT ${period} AS period FROM (${source.sql}) AS turn_summary GROUP BY ${groups.join(',')})`,
      values: source.values,
    },
  };
}
