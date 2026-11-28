// 선택한 통계 표 페이지를 동일한 항목·순서의 도표 데이터로 변환한다.
import type { ChartMetric, TurnSummaryRow, UsageChart, UsageGrouping, UsageRow } from './types';

function chartRows(pageRows: UsageRow[], excludeEmptyUsage: boolean): UsageRow[] {
  // [차트 정책] 빈 사용량을 제외할 때는 기록된 요청이 있는 행만 남기고 요청 수도 기록 기준으로 바꾼다.
  if (!excludeEmptyUsage) return pageRows;
  return pageRows.filter(row => (row.recorded_turns ?? 0) > 0).map(row => ({
    ...row, turn_count: row.recorded_turns ?? 0, completed_turns: row.recorded_completed_turns ?? 0,
  }));
}

function chartMode(groupBy: UsageGrouping | 'all'): UsageChart['mode'] {
  // [차트 정책] 일·월은 달력, 프로젝트·세션은 순위, 나머지는 전체 합계를 표시한다.
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
  // [차트 정책] 지표와 집계 기준을 검증하고 요청 단위 조회는 일별 차트로 매핑한다.
  if (!['tokens', 'requests', 'averageTokens', 'averageDuration'].includes(metric)) throw new RangeError('Unknown chart metric');
  if (!['provider', 'model'].includes(by)) throw new RangeError('Unknown chart grouping');
  const grouping = groupBy === 'turn' ? 'day' : groupBy;
  if (!['total', 'all', 'day', 'month', 'project', 'session'].includes(grouping)) throw new RangeError('Unknown usage grouping');

  // [DTO 정책] 표의 행 순서와 전체 개수를 사용해 차트에 필요한 모드와 지표를 묶는다.
  const rows = chartRows(pageRows as UsageRow[], excludeEmptyUsage);
  return { rows, total, by, metric, mode: chartMode(grouping) };
}
