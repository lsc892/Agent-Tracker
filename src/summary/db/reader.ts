import type { NameQuery, NameResult } from '../types';
import type {
  CapabilityCategory, CapabilityPage, CapabilityRow, ChartMetric, CumulativeRow, DiagnosticsPage,
  KeysetPage, ManifestRow, OffsetPage, Provider, SummaryFilter, TurnSummaryRow, UsageChart, UsageGrouping, UsageRow,
} from './types';
import { SqliteSession } from './connection';
import { usageChartFromPage } from './chart';
import {
  buildCapabilityQueries, buildDiagnosticQueries, buildModelCumulativeQueries, buildNameQueries, buildQueryFilter,
  buildTurnsCountQuery, buildTurnsQuery, buildUsageCountQuery, buildUsageQuery,
} from './queries';
import { nonnegative, pageLimit } from './validation';

/** Executes read queries and maps their results; it never owns a connection or writes usage. */
export class SummaryReader {
  constructor(private readonly database: SqliteSession) {}

  /** Name choices cover all stored usage, independently of dates and the table page. */
  queryNames(query: NameQuery): NameResult {
    const queries = buildNameQueries(query);
    const total = (this.database.connection.prepare(queries.count.sql)
      .get(...queries.count.values) as { count: number }).count;
    const rows = this.database.connection.prepare(queries.rows.sql)
      .all(...queries.rows.values, pageLimit(query.limit), nonnegative(query.offset ?? 0, 'offset')) as unknown as NameResult['rows'];
    return { rows, total };
  }

  queryTurns(filter: SummaryFilter = {}, page: KeysetPage & { offset?: number; unknownLast?: boolean } = {}, by: 'provider' | 'model' = 'provider'): TurnSummaryRow[] {
    if (page.unknownLast && page.afterId !== undefined) throw new RangeError('Unknown-last request pages require offsets');
    const where = buildQueryFilter(filter);
    const after = nonnegative(page.afterId ?? 0, 'afterId');
    const offset = nonnegative(page.offset ?? 0, 'offset');
    const query = buildTurnsQuery(where, filter.includeCosts, by, page.unknownLast);
    const rows = this.database.connection.prepare(query.sql)
      .all(...query.values, after, pageLimit(page.limit), offset);
    for (const row of rows) delete row.has_model;
    return rows as unknown as TurnSummaryRow[];
  }

  queryTurnsCount(filter: SummaryFilter = {}, by: 'provider' | 'model' = 'provider'): number {
    const query = buildTurnsCountQuery(filter, by);
    return (this.database.connection.prepare(query.sql).get(...query.values) as { count: number }).count;
  }

  queryCapabilities(filter: SummaryFilter, category: CapabilityCategory, offset = 0): CapabilityPage {
    const queries = buildCapabilityQueries(filter, category);
    const counts = this.database.connection.prepare(queries.counts.sql)
      .get(...queries.counts.values) as { total: number; totalUses: number; maxUses: number };
    const ranking = this.database.connection.prepare(queries.ranking.sql);
    const pageOffset = nonnegative(offset, 'offset');
    const rows = ranking.all(...queries.ranking.values, 100, pageOffset) as unknown as CapabilityRow[];
    const chartRows = pageOffset === 0 ? rows.slice(0, 20)
      : ranking.all(...queries.ranking.values, 20, 0) as unknown as CapabilityRow[];
    const withPercentage = (row: CapabilityRow): CapabilityRow => ({
      ...row, percentage: counts.totalUses ? row.usage_count / counts.totalUses * 100 : 0,
    });
    return { ...counts, rows: rows.map(withPercentage), chartRows: chartRows.map(withPercentage) };
  }

  queryCumulative(filter: SummaryFilter, by: 'provider' | 'model', offset = 0): { rows: CumulativeRow[]; total: number; by: 'provider' | 'model' } {
    if (by !== 'provider' && by !== 'model') throw new RangeError('Unknown cumulative grouping');
    if (by === 'provider') {
      return { rows: this.queryUsage(filter).map(row => ({ ...row, model: '' })), total: this.queryUsageCount(filter), by };
    }
    const queries = buildModelCumulativeQueries(filter);
    const total = (this.database.connection.prepare(queries.count.sql)
      .get(...queries.count.values) as { count: number }).count;
    const rows = this.database.connection.prepare(queries.rows.sql)
      .all(...queries.rows.values, nonnegative(offset, 'offset')) as unknown as CumulativeRow[];
    return { rows, total, by };
  }

  queryUsageCount(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', by: 'provider' | 'model' = 'provider'): number {
    const query = buildUsageCountQuery(filter, groupBy, timezone, by);
    return (this.database.connection.prepare(query.sql).get(...query.values) as { count: number }).count;
  }

  queryUsage(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', page: OffsetPage & { sortBy?: ChartMetric } = {}, by: 'provider' | 'model' = 'provider'): UsageRow[] {
    const query = buildUsageQuery(filter, groupBy, timezone, by, page.sortBy);
    return this.database.connection.prepare(query.sql)
      .all(...query.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[];
  }

  /** Charts use the same page, grouping and order as the table. */
  queryUsageChart(filter: SummaryFilter, groupBy: UsageGrouping | 'all' | 'turn', timezone: string, metric: ChartMetric,
    by: 'provider' | 'model' = 'provider', page: OffsetPage & { afterId?: number } = {}): UsageChart {
    const grouping = groupBy === 'all' ? 'total' : groupBy;
    const rows = grouping === 'turn' ? this.queryTurns(filter, { ...page, unknownLast: page.afterId === undefined }, by) : this.queryUsage(filter, grouping, timezone, page, by);
    const total = grouping === 'turn' ? this.queryTurnsCount(filter, by) : this.queryUsageCount(filter, grouping, timezone, by);
    return usageChartFromPage(rows, total, groupBy, metric, by, filter.excludeEmptyUsage);
  }

  diagnostics(page: KeysetPage & { afterSummaryId?: number; offset?: number; providers?: Provider[] } = {}): DiagnosticsPage {
    const limit = pageLimit(page.limit);
    const offset = nonnegative(page.offset ?? 0, 'offset');
    const queries = buildDiagnosticQueries({ providers: page.providers });
    const files = this.database.connection.prepare(queries.files.sql)
      .all(...queries.files.values, nonnegative(page.afterId ?? 0, 'afterId'), limit, offset) as unknown as ManifestRow[];
    const summaries = this.database.connection.prepare(queries.summaries.sql)
      .all(...queries.summaries.values, nonnegative(page.afterSummaryId ?? 0, 'afterSummaryId'), limit, offset) as unknown as TurnSummaryRow[];
    const counts = this.database.connection.prepare(queries.counts.sql)
      .get(...queries.counts.values) as unknown as DiagnosticsPage['counts'];
    return {
      files, summaries, counts,
      nextFileId: files.length === limit ? files[files.length - 1].id : null,
      nextSummaryId: summaries.length === limit ? summaries[summaries.length - 1].id : null,
    };
  }
}
