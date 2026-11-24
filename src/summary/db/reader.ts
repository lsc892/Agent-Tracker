// 필터와 페이지 조건에 맞는 통계·이름·도구 사용량·진단을 조회한다.
import type { NameQuery, NameResult } from '../types';
import type {
  CapabilityCategory, CapabilityPage, CapabilityRow, ChartMetric, DiagnosticsPage,
  KeysetPage, SourceFileRow, OffsetPage, Provider, SummaryFilter, UsagePage, UsageGrouping, UsageRow, UsageSort,
} from './types';
import type { SqliteSession } from './connection';
import type { QuerySql, UsageBasis } from './queries/common/types';
import { buildCapabilityQueries } from './queries/rollup/capabilities';
import { buildDiagnosticCountsQuery, buildDiagnosticQueries } from './queries/rollup/diagnostics';
import { buildNameQueries } from './queries/rollup/names';
import { buildRollupUsageQueries } from './queries/rollup/usage';
import { nonnegative, pageLimit } from './validation';

/** 일별 합계에서 통계 페이지를 읽는다. */
export class SummaryReader {
  constructor(private readonly database: SqliteSession) {}

  /** SAVEPOINT also nests safely in caller-owned transactions on Node 22.15. */
  private readPage<T>(action: () => T): T {
    const connection = this.database.connection;
    if (connection.isTransaction) return action();
    connection.exec('SAVEPOINT usage_page');
    try {
      const result = action();
      connection.exec('RELEASE usage_page');
      return result;
    } catch (error) {
      connection.exec('ROLLBACK TO usage_page; RELEASE usage_page');
      throw error;
    }
  }

  /** Name choices cover all stored usage, independently of dates and the table page. */
  queryNames(query: NameQuery): NameResult {
    return this.countedPage<NameResult['rows'][number]>(buildNameQueries(query, true), query);
  }

  /** A returned group carries the total; an empty later page needs its full-range count. */
  private countedPage<T>(queries: { rows: QuerySql; count: QuerySql }, page: OffsetPage): { rows: T[]; total: number } {
    const limit = pageLimit(page.limit);
    const offset = nonnegative(page.offset ?? 0, 'offset');
    const rows = this.database.connection.prepare(queries.rows.sql)
      .all(...queries.rows.values, limit, offset) as unknown as (T & { _total: number })[];
    let total = rows[0]?._total ?? 0;
    if (!rows.length && offset) {
      total = (this.database.connection.prepare(queries.count.sql).get(...queries.count.values) as { count: number }).count;
    }
    for (const row of rows) delete (row as { _total?: number })._total;
    return { rows, total };
  }

  /**
   * 책임: 분류별 사용 횟수와 페이지에 독립적인 비율을 반환한다.
   * 알고리즘: 순위의 window 지표로 전체 합계·최댓값을 함께 읽고 빈 후속 페이지만 별도 집계하며 전체 합계를 비율 분모로 사용한다.
   */
  queryCapabilities(filter: SummaryFilter, category: CapabilityCategory, offset = 0, limit = 100): CapabilityPage {
    pageLimit(limit);
    const queries = buildCapabilityQueries(filter, category, true, this.database.rollups.dailyTimezone());
    const ranking = this.database.connection.prepare(queries.ranking.sql);
    const pageOffset = nonnegative(offset, 'offset');
    const rows = ranking.all(...queries.ranking.values, limit, pageOffset) as unknown as
      (CapabilityRow & { _total: number; _totalUses: number; _maxUses: number })[];
    let counts = { total: 0, totalUses: 0, maxUses: 0 };
    if (rows.length) {
      counts = { total: rows[0]._total, totalUses: rows[0]._totalUses, maxUses: rows[0]._maxUses };
    } else if (pageOffset) {
      counts = this.database.connection.prepare(queries.counts.sql).get(...queries.counts.values) as typeof counts;
    }
    return { ...counts, rows: rows.map(({ _total, _totalUses, _maxUses, ...row }) => ({
      ...row, percentage: counts.totalUses ? row.usage_count / counts.totalUses * 100 : 0,
    })) };
  }

  queryUsageCount(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', by: UsageBasis = 'provider'): number {
    const { count } = buildRollupUsageQueries(filter, groupBy, timezone, by);
    return (this.database.connection.prepare(count.sql).get(...count.values) as { count: number }).count;
  }

  queryUsage(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', page: OffsetPage & { sortBy?: ChartMetric; tableSort?: UsageSort } = {}, by: UsageBasis = 'provider'): UsageRow[] {
    const { rows } = buildRollupUsageQueries(filter, groupBy, timezone, by, page.sortBy, page.tableSort);
    return this.database.connection.prepare(rows.sql)
      .all(...rows.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[];
  }

  /** Read table rows and their total from one snapshot; charts reuse these rows. */
  queryUsagePage(filter: SummaryFilter = {}, groupBy: UsageGrouping | 'all' | 'turn' = 'total', timezone = 'UTC',
    page: OffsetPage & { afterId?: number; sortBy?: ChartMetric; tableSort?: UsageSort } = {},
    by: UsageBasis = 'provider'): UsagePage {
    const grouping = groupBy === 'all' ? 'total' : groupBy === 'turn' ? 'day' : groupBy;
    const queries = buildRollupUsageQueries(filter, grouping, timezone, by, page.sortBy, page.tableSort, true);
    return this.readPage(() => this.countedPage<UsageRow>(queries, page));
  }

  diagnosticCounts(providers?: Provider[]): DiagnosticsPage['counts'] {
    const query = buildDiagnosticCountsQuery(providers);
    return this.database.connection.prepare(query.sql).get(...query.values) as unknown as DiagnosticsPage['counts'];
  }

  /**
   * 파일 진단과 상태별 개수를 조회하고 페이지의 마지막 파일 ID를 반환한다.
   */
  diagnostics(page: KeysetPage & { afterSummaryId?: number; offset?: number; providers?: Provider[] } = {}): DiagnosticsPage {
    const limit = pageLimit(page.limit);
    const offset = nonnegative(page.offset ?? 0, 'offset');
    const queries = buildDiagnosticQueries({ providers: page.providers });
    const files = this.database.connection.prepare(queries.files.sql)
      .all(...queries.files.values, nonnegative(page.afterId ?? 0, 'afterId'), limit, offset) as unknown as SourceFileRow[];
    const counts = this.database.connection.prepare(queries.counts.sql)
      .get(...queries.counts.values) as unknown as DiagnosticsPage['counts'];
    return {
      files, summaries: [], counts,
      nextFileId: files.length === limit ? files[files.length - 1].id : null,
      nextSummaryId: null,
    };
  }
}
