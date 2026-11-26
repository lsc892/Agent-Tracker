// 통계 DB의 파일 관리·세션 저장·결제·조회 기능을 공통 API로 묶는다.
import type { DatabaseSync } from 'node:sqlite';
import type { NameQuery, NameResult } from '../types';
import type {
  BillingMode, CapabilityCategory, CapabilityPage, ChartMetric, DiagnosticsPage, FileMetadata,
  KeysetPage, SourceFileRow, OffsetPage, ProcessingStatus, Provider, SummaryFilter,
  TurnSummaryRow, UsagePage, UsageGrouping, UsageRow, UsageSort, StoredSourceRelation, SessionRef,
} from './types';
import { SqliteSession, type SqliteSessionOptions } from './connection';
import { SourceFileStore } from './sourceFiles';
import { SessionBillingStore } from './billing';
import { SummaryReader } from './reader';
import { MemoryStore, type MemoryReplacement, type SavedSessionNames } from './memoryStore';
import type { AppliedResponse } from './appliedResponses';
import type { StageProfiler, StorageStage } from '../profiling';
import { buildDailyUsageFilter } from './queries/rollup/source';
import { ROLLUP_TABLES } from './rollup-state';

export * from './types';
export type { AppliedResponse } from './appliedResponses';
export { usageChartFromPage } from './chart';
export { periodBounds } from './timezone';

/** 하나의 DB 연결을 공유하는 저장소들을 구성하고 통계 작업을 위임한다. */
export class SummaryDatabase {
  readonly connection: DatabaseSync;
  /** @deprecated 일별 스키마에는 개별 응답 행이 없다. */
  readonly appliedResponses = { loadSessions: (_sessions: readonly SessionRef[]): Iterable<AppliedResponse> => [] };
  private readonly sqlite: SqliteSession;
  private readonly sources: SourceFileStore;
  private readonly billing: SessionBillingStore;
  private readonly reader: SummaryReader;

  constructor(options: SqliteSessionOptions) {
    this.sqlite = new SqliteSession(options);
    this.connection = this.sqlite.connection;
    this.sources = new SourceFileStore(this.sqlite);
    this.billing = new SessionBillingStore(this.sqlite);
    this.reader = new SummaryReader(this.sqlite);
  }

  close(): void {
    return this.sqlite.close();
  }

  optimize(): void {
    return this.sqlite.optimize();
  }

  transaction<T>(action: () => T): T {
    return this.sqlite.transaction(action);
  }

  setDailyTimezone(timezone: string): void {
    this.sqlite.rollups.setDailyTimezone(timezone);
  }

  clearData(): void {
    this.sqlite.transaction(() => {
      this.sqlite.rollups.clear();
      this.connection.exec('DELETE FROM source_file; DELETE FROM sessions; DELETE FROM projects;');
    });
  }

  findSourceFile(provider: Provider, path: string): SourceFileRow | undefined {
    return this.sources.findSourceFile(provider, path);
  }

  sourceRelations(fileId: number): StoredSourceRelation | undefined {
    return this.sources.loadRelations(fileId);
  }

  codexSourceThreadIds(): Map<number, string> {
    return this.sources.codexThreadIds();
  }

  observeFile(metadata: FileMetadata): SourceFileRow {
    return this.sources.observeFile(metadata);
  }

  setSourceDiagnostic(id: number, status: ProcessingStatus, position: string | null, error: string | null, _offset?: number | null): void {
    this.sources.setSourceDiagnostic(id, status, position, error);
  }

  sessionFiles(provider: Provider, sessionId: string, limit = 100): IterableIterator<SourceFileRow> {
    return this.sources.sessionFiles(provider, sessionId, limit);
  }

  replaceMemory(replacement: MemoryReplacement, profile?: StageProfiler<StorageStage>): SavedSessionNames {
    return new MemoryStore(this.sqlite, profile).replace(replacement);
  }

  replaceMemoryBatch(replacements: readonly MemoryReplacement[], profile?: StageProfiler<StorageStage>): SavedSessionNames {
    return new MemoryStore(this.sqlite, profile).replaceBatch(replacements);
  }

  queryNames(query: NameQuery): NameResult {
    return this.reader.queryNames(query);
  }

  /** @deprecated 일별 스키마에는 개별 스레드 행이 없다. */
  queryTurns(_filter?: SummaryFilter, _page?: KeysetPage & { offset?: number; unknownLast?: boolean; tableSort?: UsageSort }, _by?: 'provider' | 'model'): TurnSummaryRow[] {
    return [];
  }

  setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode): void {
    return this.billing.setSessionBilling(provider, sessionId, mode);
  }

  sessionBilling(provider: Provider, sessionId: string): BillingMode {
    return this.billing.sessionBilling(provider, sessionId);
  }

  /** @deprecated 일별 집계에 저장된 표본 수를 반환한다. */
  queryTurnsCount(filter: SummaryFilter = {}, by: 'provider' | 'model' = 'provider'): number {
    const where = buildDailyUsageFilter(filter, this.sqlite.rollups.dailyTimezone());
    const row = this.connection.prepare(`SELECT COALESCE(SUM(turn_count), 0) AS count
      FROM ${ROLLUP_TABLES[by]} AS usage WHERE ${where.sql}`).get(...where.values);
    return Number(row?.count);
  }

  queryCapabilities(filter: SummaryFilter, category: CapabilityCategory, offset = 0, limit = 100): CapabilityPage {
    return this.reader.queryCapabilities(filter, category, offset, limit);
  }

  queryUsageCount(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', by: 'provider' | 'model' = 'provider'): number {
    return this.reader.queryUsageCount(filter, groupBy, timezone, by);
  }

  queryUsage(filter: SummaryFilter = {}, groupBy: UsageGrouping = 'total', timezone = 'UTC', page: OffsetPage & { sortBy?: ChartMetric; tableSort?: UsageSort } = {}, by: 'provider' | 'model' = 'provider'): UsageRow[] {
    return this.reader.queryUsage(filter, groupBy, timezone, page, by);
  }

  queryUsagePage(filter: SummaryFilter = {}, groupBy: UsageGrouping | 'all' | 'turn' = 'total', timezone = 'UTC',
    page: OffsetPage & { afterId?: number; sortBy?: ChartMetric; tableSort?: UsageSort } = {},
    by: 'provider' | 'model' = 'provider'): UsagePage {
    return this.reader.queryUsagePage(filter, groupBy, timezone, page, by);
  }

  diagnostics(page: KeysetPage & { afterSummaryId?: number; offset?: number; providers?: Provider[] } = {}): DiagnosticsPage {
    return this.reader.diagnostics(page);
  }

  diagnosticCounts(providers?: Provider[]): DiagnosticsPage['counts'] {
    return this.reader.diagnosticCounts(providers);
  }
}
