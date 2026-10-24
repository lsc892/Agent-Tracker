import type { NameQuery, NameResult } from '../types';
import type {
  CapabilityCategory, CapabilityPage, CapabilityRow, ChartMetric, DiagnosticsPage,
  KeysetPage, ManifestRow, OffsetPage, Provider, SummaryFilter, TurnSummaryRow, UsagePage, UsageGrouping, UsageRow, UsageSort,
} from './types';
import { SqliteSession } from './connection';
import {
  buildCapabilityQueries, buildDiagnosticQueries, buildNameQueries, buildQueryFilter,
  buildTurnsCountQuery, buildTurnsQuery, buildUsageCountQuery, buildUsageQuery,
} from './queries';
import { nonnegative, pageLimit } from './validation';
import { buildRollupUsageQueries } from './rollup-queries';
import type { QuerySql, UsageBasis } from './queries';

/**
 * 책임: 공유 연결에서 필터·페이지가 적용된 통계와 진단을 조회한다.
 * 알고리즘: 검증된 SQL builder에 바인딩을 전달하고 일별 사전 집계를 사용할 수 있으면 같은 snapshot에서 읽으며 그 외에는 raw SQL을 사용한다.
 */
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

  /**
   * 책임: 조회 조건에 맞는 raw 또는 사전 집계 SQL을 선택한다.
   * 알고리즘: 비용·미지원 기간은 raw로 보내고 그 외에는 rollup의 시간대·형식 준비 여부를 확인한 같은 트랜잭션에서 쿼리를 실행한다.
   */
  private usageQueries<T>(filter: SummaryFilter, groupBy: UsageGrouping, timezone: string,
    by: UsageBasis, sortBy: ChartMetric | undefined, action: (queries: { rows: QuerySql; count: QuerySql }) => T, tableSort?: UsageSort): T {
    const raw = (): { rows: QuerySql; count: QuerySql } => ({
      rows: buildUsageQuery(filter, groupBy, timezone, by, sortBy, tableSort),
      count: buildUsageCountQuery(filter, groupBy, timezone, by),
    });
    const candidate = buildRollupUsageQueries(filter, groupBy, timezone, by, sortBy, tableSort);
    if (!candidate) return action(raw());
    return this.database.rollups.read(timezone, ready => action(ready ? candidate : raw()));
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

  /**
   * 책임: 분류별 사용 횟수와 페이지에 독립적인 비율을 반환한다.
   * 알고리즘: 전체 필터 범위의 합계·최댓값을 먼저 구하고 순위 페이지·상위 20개를 조회해 같은 전체 합계를 비율 분모로 사용한다.
   */
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

  queryUsageCount(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', by: 'provider' | 'model' = 'provider'): number {
    return this.usageQueries(filter, groupBy, timezone, by, undefined, ({ count }) =>
      (this.database.connection.prepare(count.sql).get(...count.values) as { count: number }).count);
  }

  queryUsage(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', page: OffsetPage & { sortBy?: ChartMetric; tableSort?: UsageSort } = {}, by: 'provider' | 'model' = 'provider'): UsageRow[] {
    return this.usageQueries(filter, groupBy, timezone, by, page.sortBy, ({ rows }) => this.database.connection.prepare(rows.sql)
      .all(...rows.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[], page.tableSort);
  }

  /** Read table rows and their total from one snapshot; charts reuse these rows. */
  queryUsagePage(filter: SummaryFilter = {}, groupBy: UsageGrouping | 'all' | 'turn' = 'total', timezone = 'UTC',
    page: OffsetPage & { afterId?: number; sortBy?: ChartMetric; tableSort?: UsageSort } = {},
    by: 'provider' | 'model' = 'provider'): UsagePage {
    const grouping = groupBy === 'all' ? 'total' : groupBy;
    if (grouping === 'turn') {
      return this.readPage(() => ({
        rows: this.queryTurns(filter, { ...page, unknownLast: page.afterId === undefined }, by),
        total: this.queryTurnsCount(filter, by),
      }));
    }
    return this.usageQueries(filter, grouping, timezone, by, page.sortBy, queries => this.readPage(() => ({
      rows: this.database.connection.prepare(queries.rows.sql)
        .all(...queries.rows.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[],
      total: (this.database.connection.prepare(queries.count.sql).get(...queries.count.values) as { count: number }).count,
    })), page.tableSort);
  }

  /**
   * 책임: 진단 파일·요약과 처리 개수를 제한된 페이지로 반환한다.
   * 알고리즘: limit·offset·cursor를 검증해 각각 조회하고 페이지가 가득 찼을 때 마지막 ID를 다음 cursor로 제공한다.
   */
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
