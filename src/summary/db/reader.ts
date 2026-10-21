import type { NameQuery, NameResult } from '../types';
import type {
  CapabilityCategory, CapabilityPage, CapabilityRow, ChartMetric, CumulativeRow, DiagnosticsPage,
  KeysetPage, ManifestRow, OffsetPage, Provider, SummaryFilter, TurnSummaryRow, UsageChart, UsageGrouping, UsageRow, UsageSort,
} from './types';
import { SqliteSession } from './connection';
import { usageChartFromPage } from './chart';
import {
  buildCapabilityQueries, buildDiagnosticQueries, buildModelCumulativeQueries, buildNameQueries, buildQueryFilter,
  buildTurnsCountQuery, buildTurnsQuery, buildUsageCountQuery, buildUsageQuery,
} from './queries';
import { nonnegative, pageLimit } from './validation';
import { buildRollupUsageQueries } from './rollup-queries';
import type { QuerySql, UsageBasis } from './queries';

/** Executes read queries on the shared connection, including maintained daily usage projections. */
export class SummaryReader {
  constructor(private readonly database: SqliteSession) {}

  private usageQueries<T>(filter: SummaryFilter, groupBy: UsageGrouping, timezone: string | undefined,
    by: UsageBasis, sortBy: ChartMetric | undefined, action: (queries: { rows: QuerySql; count: QuerySql }) => T, tableSort?: UsageSort): T {
    const raw = (zone: string): { rows: QuerySql; count: QuerySql } => ({
      rows: buildUsageQuery(filter, groupBy, zone, by, sortBy, tableSort),
      count: buildUsageCountQuery(filter, groupBy, zone, by),
    });
    const candidate = timezone === undefined ? undefined : buildRollupUsageQueries(filter, groupBy, timezone, by, sortBy, tableSort);
    if (filter.includeCosts || timezone !== undefined && !candidate) return action(raw(timezone ?? 'UTC'));
    return this.database.rollups.read(timezone, (ready, selected) => {
      const queries = candidate ?? buildRollupUsageQueries(filter, groupBy, selected, by, sortBy, tableSort);
      return action(ready && queries ? queries : raw(selected));
    });
  }

  /** Name choices cover all stored usage, independently of dates and the table page. */
  queryNames(query: NameQuery): NameResult {
    const queries = buildNameQueries(query);
    const total = (this.database.connection.prepare(queries.count.sql)
      .get(...queries.count.values) as { count: number }).count;
    const rows = this.database.connection.prepare(queries.rows.sql)
      .all(...queries.rows.values, pageLimit(query.limit), nonnegative(query.offset ?? 0, 'offset')) as unknown as NameResult['rows'];
    return { rows, total };
  }

  queryTurns(filter: SummaryFilter = {}, page: KeysetPage & { offset?: number; unknownLast?: boolean; tableSort?: UsageSort } = {}, by: 'provider' | 'model' = 'provider'): TurnSummaryRow[] {
    if ((page.unknownLast || page.tableSort) && page.afterId !== undefined) throw new RangeError('Sorted request pages require offsets');
    const where = buildQueryFilter(filter);
    const after = nonnegative(page.afterId ?? 0, 'afterId');
    const offset = nonnegative(page.offset ?? 0, 'offset');
    const query = buildTurnsQuery(where, filter.includeCosts, by, page.unknownLast, page.tableSort);
    const rows = this.database.connection.prepare(query.sql)
      .all(...query.values, after, pageLimit(page.limit), offset);
    for (const row of rows) delete row.has_model;
    return rows as unknown as TurnSummaryRow[];
  }

  queryTurnsCount(filter: SummaryFilter = {}, by: 'provider' | 'model' = 'provider'): number {
    const query = buildTurnsCountQuery(filter, by);
    return (this.database.connection.prepare(query.sql).get(...query.values) as { count: number }).count;
  }

  queryCapabilities(filter: SummaryFilter, category: CapabilityCategory, offset = 0, limit = 100): CapabilityPage {
    pageLimit(limit);
    const queries = buildCapabilityQueries(filter, category);
    const counts = this.database.connection.prepare(queries.counts.sql)
      .get(...queries.counts.values) as { total: number; totalUses: number; maxUses: number };
    const ranking = this.database.connection.prepare(queries.ranking.sql);
    const pageOffset = nonnegative(offset, 'offset');
    const rows = ranking.all(...queries.ranking.values, limit, pageOffset) as unknown as CapabilityRow[];
    const chartRows = pageOffset === 0 && limit >= 20 ? rows.slice(0, 20)
      : ranking.all(...queries.ranking.values, 20, 0) as unknown as CapabilityRow[];
    const withPercentage = (row: CapabilityRow): CapabilityRow => ({
      ...row, percentage: counts.totalUses ? row.usage_count / counts.totalUses * 100 : 0,
    });
    return { ...counts, rows: rows.map(withPercentage), chartRows: chartRows.map(withPercentage) };
  }

  queryCumulative(filter: SummaryFilter, by: 'provider' | 'model', offset = 0): { rows: CumulativeRow[]; total: number; by: 'provider' | 'model' } {
    if (by !== 'provider' && by !== 'model') throw new RangeError('Unknown cumulative grouping');
    if (!filter.includeCosts) {
      // Non-calendar cumulative totals reuse the active timezone, avoiding a UTC/local rebuild cycle.
      return this.usageQueries(filter, 'total', undefined, by, by === 'model' ? 'tokens' : undefined, queries => {
        const total = (this.database.connection.prepare(queries.count.sql).get(...queries.count.values) as { count: number }).count;
        const usage = this.database.connection.prepare(queries.rows.sql)
          .all(...queries.rows.values, 100, by === 'model' ? nonnegative(offset, 'offset') : 0) as unknown as UsageRow[];
        const rows: CumulativeRow[] = by === 'provider' ? usage.map(row => ({ ...row, model: '' }))
          : usage.map(row => ({ provider: row.provider, model: row.model ?? null,
            input_tokens: row.input_tokens, output_tokens: row.output_tokens,
            cache_write_input_tokens: row.cache_write_input_tokens, cache_read_input_tokens: row.cache_read_input_tokens,
            total_tokens: row.total_tokens }));
        return { rows, total, by };
      });
    }
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
    return this.usageQueries(filter, groupBy, timezone, by, undefined, ({ count }) =>
      (this.database.connection.prepare(count.sql).get(...count.values) as { count: number }).count);
  }

  queryUsage(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', page: OffsetPage & { sortBy?: ChartMetric; tableSort?: UsageSort } = {}, by: 'provider' | 'model' = 'provider'): UsageRow[] {
    return this.usageQueries(filter, groupBy, timezone, by, page.sortBy, ({ rows }) => this.database.connection.prepare(rows.sql)
      .all(...rows.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[], page.tableSort);
  }

  /** Charts use the same page, grouping and order as the table. */
  queryUsageChart(filter: SummaryFilter, groupBy: UsageGrouping | 'all' | 'turn', timezone: string, metric: ChartMetric,
    by: 'provider' | 'model' = 'provider', page: OffsetPage & { afterId?: number; sortBy?: ChartMetric; tableSort?: UsageSort } = {}): UsageChart {
    const grouping = groupBy === 'all' ? 'total' : groupBy;
    if (grouping !== 'turn') {
      return this.usageQueries(filter, grouping, timezone, by, page.sortBy, queries => {
        const rows = this.database.connection.prepare(queries.rows.sql)
          .all(...queries.rows.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[];
        const total = (this.database.connection.prepare(queries.count.sql).get(...queries.count.values) as { count: number }).count;
        return usageChartFromPage(rows, total, groupBy, metric, by, filter.excludeEmptyUsage);
      }, page.tableSort);
    }
    const rows = this.queryTurns(filter, { ...page, unknownLast: page.afterId === undefined }, by);
    const total = this.queryTurnsCount(filter, by);
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
