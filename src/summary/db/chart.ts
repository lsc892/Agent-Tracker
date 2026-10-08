import type { ChartMetric, TurnSummaryRow, UsageChart, UsageGrouping, UsageRow } from './types';

/** Keep chart membership and ordering within the selected table page. */
export function usageChartFromPage(
  pageRows: UsageRow[] | TurnSummaryRow[], total: number, groupBy: UsageGrouping | 'all' | 'turn',
  metric: ChartMetric, by: 'provider' | 'model' = 'provider', excludeEmptyUsage = false,
): UsageChart {
  if (!['tokens', 'requests', 'averageTokens', 'averageDuration'].includes(metric)) throw new RangeError('Unknown chart metric');
  if (!['provider', 'model'].includes(by)) throw new RangeError('Unknown chart grouping');
  if (!['total', 'all', 'day', 'month', 'project', 'session', 'turn'].includes(groupBy)) throw new RangeError('Unknown usage grouping');
  const turn = groupBy === 'turn';
  const rows = !excludeEmptyUsage ? pageRows : turn
    ? (pageRows as TurnSummaryRow[]).filter(row => row.has_recorded_usage)
    : (pageRows as UsageRow[]).filter(row => (row.recorded_turns ?? 0) > 0).map(row => ({
      ...row, turn_count: row.recorded_turns ?? 0, completed_turns: row.recorded_completed_turns ?? 0,
    }));
  return {
    rows, total, by, metric: turn && metric !== 'averageDuration' ? 'tokens' : metric,
    mode: turn ? 'turn' : groupBy === 'day' || groupBy === 'month' ? 'calendar'
      : groupBy === 'project' || groupBy === 'session' ? 'ranking' : 'total',
  };
}
