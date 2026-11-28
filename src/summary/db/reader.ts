// 필터와 페이지 조건에 맞는 통계·이름·도구 사용량·진단을 조회한다.
import type { NameQuery, NameResult, UsageQuery } from '../types';
import type {
  CapabilityCategory, CapabilityPage, CapabilityRow, ChartMetric, DiagnosticsPage,
  KeysetPage, SourceFileRow, OffsetPage, Provider, SummaryFilter, UsagePage, UsageGrouping, UsageRow, UsageSort,
} from './types';
import type { SqliteSession } from './connection';
import type { QuerySql, UsageBasis } from './queries/common/types';
import { buildCapabilityPagesQuery, buildCapabilityQueries, CAPABILITY_CATEGORIES } from './queries/rollup/capabilities';
import { buildDiagnosticCountsQuery, buildDiagnosticQueries } from './queries/rollup/diagnostics';
import { buildNameQueries } from './queries/rollup/names';
import { buildRollupUsageQueries } from './queries/rollup/usage';
import { nonnegative, pageLimit } from './validation';

/** 일별 합계에서 통계 페이지를 읽는다. */
export class SummaryReader {
  constructor(private readonly database: SqliteSession) {}

  /** SAVEPOINT also nests safely in caller-owned transactions on Node 22.15. */
  private readPage<T>(action: () => T): T {
    // [SQL 트랜잭션 정책] 호출자가 연 트랜잭션을 재사용하고 독립 조회에서는 SAVEPOINT로 같은 스냅샷을 읽는다.
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
    // [페이지 정책] 행에서 전체 건수를 읽고 오프셋 이후 결과가 비어 있을 때만 별도 COUNT를 실행한다.
    const limit = pageLimit(page.limit);
    const offset = nonnegative(page.offset ?? 0, 'offset');
    const rows = this.database.connection.prepare(queries.rows.sql)
      .all(...queries.rows.values, limit, offset) as unknown as (T & { _total: number })[];
    let total = rows[0]?._total ?? 0;
    if (!rows.length && offset) {
      total = (this.database.connection.prepare(queries.count.sql).get(...queries.count.values) as { count: number }).count;
    }
    // [DTO 정책] 내부 집계용 전체 건수를 행에서 떼어 페이지 메타데이터로 반환한다.
    for (const row of rows) delete (row as { _total?: number })._total;
    return { rows, total };
  }

  /**
   * 책임: 분류별 사용 횟수와 페이지에 독립적인 비율을 반환한다.
   * 알고리즘: 순위의 window 지표로 전체 합계·최댓값을 함께 읽고 빈 후속 페이지만 별도 집계하며 전체 합계를 비율 분모로 사용한다.
   */
  queryCapabilities(filter: SummaryFilter, category: CapabilityCategory, offset = 0, limit = 100): CapabilityPage {
    // [페이지 정책] 순위 SQL의 윈도 함수로 페이지 행과 전 범위 합계·최댓값을 함께 읽는다.
    pageLimit(limit);
    const queries = buildCapabilityQueries(filter, category, true, this.database.rollups.dailyTimezone());
    const ranking = this.database.connection.prepare(queries.ranking.sql);
    const pageOffset = nonnegative(offset, 'offset');
    const rows = ranking.all(...queries.ranking.values, limit, pageOffset) as unknown as
      (CapabilityRow & { _total: number; _totalUses: number; _maxUses: number })[];

    // [집계 정책] 빈 후속 페이지만 전체 집계를 다시 읽고 전체 사용 횟수를 비율 분모로 사용한다.
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

  queryCapabilityPages(query: UsageQuery): Record<CapabilityCategory, CapabilityPage> {
    const pages = CAPABILITY_CATEGORIES.map(category => [category,
      nonnegative(query.capabilityOffsets?.[category] ?? 0, 'offset'),
      pageLimit(query.capabilityLimits?.[category] ?? query.limit),
    ] as const);
    const { sql, values } = buildCapabilityPagesQuery(query, pages, this.database.rollups.dailyTimezone());
    const rows = this.database.connection.prepare(sql).all(...values) as unknown as
      (Omit<CapabilityRow, 'percentage'> & { _total: number; _totalUses: number; _maxUses: number; in_page: number })[];
    const result = Object.fromEntries(CAPABILITY_CATEGORIES.map((category): [CapabilityCategory, CapabilityPage] => [category,
      { rows: [], total: 0, totalUses: 0, maxUses: 0 },
    ])) as Record<CapabilityCategory, CapabilityPage>;

    // 페이지 끝을 넘은 분류는 전체 통계만 있는 행을 받는다.
    for (const { _total, _totalUses, _maxUses, in_page, ...row } of rows) {
      const page = result[row.category];
      page.total = _total;
      page.totalUses = _totalUses;
      page.maxUses = _maxUses;
      if (in_page) page.rows.push({ ...row, percentage: _totalUses ? row.usage_count / _totalUses * 100 : 0 });
    }
    return result;
  }

  queryUsageCount(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', by: UsageBasis = 'provider'): number {
    // [조회 정책] 같은 필터와 그룹 키를 사용하는 COUNT SQL로 전체 그룹 수를 읽는다.
    const { count } = buildRollupUsageQueries(filter, groupBy, timezone, by);
    return (this.database.connection.prepare(count.sql).get(...count.values) as { count: number }).count;
  }

  queryUsage(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', page: OffsetPage & { sortBy?: ChartMetric; tableSort?: UsageSort } = {}, by: UsageBasis = 'provider'): UsageRow[] {
    // [페이지 정책] 정렬을 포함한 집계 조회에 검증한 페이지 크기와 오프셋을 바인딩한다.
    const { rows } = buildRollupUsageQueries(filter, groupBy, timezone, by, page.sortBy, page.tableSort);
    return this.database.connection.prepare(rows.sql)
      .all(...rows.values, pageLimit(page.limit), nonnegative(page.offset ?? 0, 'offset')) as unknown as UsageRow[];
  }

  /** Read table rows and their total from one snapshot; charts reuse these rows. */
  queryUsagePage(filter: SummaryFilter = {}, groupBy: UsageGrouping | 'all' | 'turn' = 'total', timezone = 'UTC',
    page: OffsetPage & { afterId?: number; sortBy?: ChartMetric; tableSort?: UsageSort } = {},
    by: UsageBasis = 'provider'): UsagePage {
    // [조회 정책] 이전 호출의 all은 전체, turn은 일별 그룹으로 해석하고 행과 건수를 같은 스냅샷에서 읽는다.
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
    // [진단 정책] 제공자 필터로 파일 진단과 상태별 건수를 읽고 페이지가 찼을 때만 마지막 파일 ID를 넘긴다.
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
