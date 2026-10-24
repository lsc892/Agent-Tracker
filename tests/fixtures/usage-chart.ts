import { SummaryDatabase, usageChartFromPage } from '../../src/summary/db';
import type { ChartMetric, OffsetPage, SummaryFilter, UsageGrouping, UsageSort } from '../../src/summary/db';

/** Tests build charts from the same public table page used by the Worker. */
export function queryChart(db: SummaryDatabase, filter: SummaryFilter, groupBy: UsageGrouping | 'all' | 'turn',
  timezone: string, metric: ChartMetric, by: 'provider' | 'model' = 'provider',
  page: OffsetPage & { afterId?: number; sortBy?: ChartMetric; tableSort?: UsageSort } = {}) {
  const { rows, total } = db.queryUsagePage(filter, groupBy, timezone, page, by);
  return usageChartFromPage(rows, total, groupBy, metric, by, filter.excludeEmptyUsage);
}
