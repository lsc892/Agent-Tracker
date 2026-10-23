import type { ChartMetric, TurnSummaryRow, UsageChart, UsageGrouping, UsageRow } from './types';

/**
 * 책임: 도표의 항목과 순서를 선택한 표 페이지와 일치시킨다.
 * 알고리즘: 페이지 행에 빈 사용량 제외 정책만 적용하고 요청·기간·순위별 도표 모드와 지표를 정해 같은 순서로 반환한다.
 */
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
