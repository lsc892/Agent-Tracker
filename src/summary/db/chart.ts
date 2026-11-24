// 선택한 통계 표 페이지를 동일한 항목·순서의 도표 데이터로 변환한다.
import type { ChartMetric, TurnSummaryRow, UsageChart, UsageGrouping, UsageRow } from './types';

function chartRows(pageRows: UsageRow[], excludeEmptyUsage: boolean): UsageRow[] {
  if (!excludeEmptyUsage) return pageRows;
  return pageRows.filter(row => (row.recorded_turns ?? 0) > 0).map(row => ({
    ...row, turn_count: row.recorded_turns ?? 0, completed_turns: row.recorded_completed_turns ?? 0,
  }));
}

function chartMode(groupBy: UsageGrouping | 'all'): UsageChart['mode'] {
  switch (groupBy) {
    case 'day':
    case 'month': return 'calendar';
    case 'project':
    case 'session': return 'ranking';
    default: return 'total';
  }
}

/**
 * 책임: 도표의 항목과 순서를 선택한 표 페이지와 일치시킨다.
 * 알고리즘: 페이지 행에 빈 사용량 제외 정책을 적용하고 기간·순위별 모드와 지표를 정해 같은 순서로 반환한다.
 */
export function usageChartFromPage(
  pageRows: UsageRow[] | TurnSummaryRow[], total: number, groupBy: UsageGrouping | 'all' | 'turn',
  metric: ChartMetric, by: 'provider' | 'model' = 'provider', excludeEmptyUsage = false,
): UsageChart {
  if (!['tokens', 'requests', 'averageTokens', 'averageDuration'].includes(metric)) throw new RangeError('Unknown chart metric');
  if (!['provider', 'model'].includes(by)) throw new RangeError('Unknown chart grouping');
  const grouping = groupBy === 'turn' ? 'day' : groupBy;
  if (!['total', 'all', 'day', 'month', 'project', 'session'].includes(grouping)) throw new RangeError('Unknown usage grouping');
  const rows = chartRows(pageRows as UsageRow[], excludeEmptyUsage);
  return { rows, total, by, metric, mode: chartMode(grouping) };
}
