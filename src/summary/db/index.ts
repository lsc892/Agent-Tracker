// 통계 DB의 파일 관리·세션 저장·결제·조회 기능을 공통 API로 묶는다.
import type { DatabaseSync } from 'node:sqlite';
import type { NameQuery, NameResult } from '../types';
import type {
  BillingMode, CapabilityCategory, CapabilityPage, ChartMetric, DiagnosticsPage, FileMetadata,
  KeysetPage, SourceFileRow, OffsetPage, ProcessingStatus, Provider, SummaryFilter,
  TurnSummaryRow, UsagePage, UsageGrouping, UsageRow, UsageSort, SourceRelationMetadata,
} from './types';
import { SqliteSession, type SqliteSessionOptions } from './connection';
import { SourceFileStore } from './sourceFiles';
import { SessionBillingStore } from './billing';
import { SummaryReader } from './reader';
import { MemoryStore, type MemoryReplacement, type SavedSessionNames } from './memoryStore';
import { AppliedResponseStore } from './appliedResponses';
import type { StageProfiler, StorageStage } from '../profiling';

export * from './types';
export type { AppliedRequestTotals, AppliedResponse } from './appliedResponses';
export { usageChartFromPage } from './chart';
export { periodBounds } from './timezone';

/** 하나의 DB 연결을 공유하는 저장소들을 구성하고 통계 작업을 위임한다. */
export class SummaryDatabase {
  readonly connection: DatabaseSync;
  readonly appliedResponses: AppliedResponseStore;
  private readonly sqlite: SqliteSession;
  private readonly sources: SourceFileStore;
  private readonly billing: SessionBillingStore;
  private readonly reader: SummaryReader;

  constructor(options: SqliteSessionOptions) {
    this.sqlite = new SqliteSession(options);
    this.connection = this.sqlite.connection;
    this.appliedResponses = new AppliedResponseStore(this.sqlite);
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

  clearData(): void {
    this.sqlite.transaction(() => {
      this.sqlite.rollups.clear();
      this.connection.exec('DELETE FROM turn_summary; DELETE FROM source_file; DELETE FROM sessions; DELETE FROM projects;');
    });
  }

  findSourceFile(provider: Provider, path: string): SourceFileRow | undefined {
    return this.sources.findSourceFile(provider, path);
  }

  sourceRelations(fileId: number): SourceRelationMetadata | undefined {
    return this.sources.loadRelations(fileId);
  }

  observeFile(metadata: FileMetadata): SourceFileRow {
    return this.sources.observeFile(metadata);
  }

  setSourceDiagnostic(id: number, status: ProcessingStatus, position: string | null, error: string | null, offset: number | null = null): void {
    return this.sources.setSourceDiagnostic(id, status, position, error, offset);
  }

  sessionFiles(provider: Provider, sessionId: string, limit = 100): IterableIterator<SourceFileRow> {
    return this.sources.sessionFiles(provider, sessionId, limit);
  }

  replaceMemory(replacement: MemoryReplacement, profile?: StageProfiler<StorageStage>): SavedSessionNames {
    return new MemoryStore(this.sqlite, this.billing, this.appliedResponses, profile).replace(replacement);
  }

  replaceMemoryBatch(replacements: readonly MemoryReplacement[], profile?: StageProfiler<StorageStage>): SavedSessionNames {
    return new MemoryStore(this.sqlite, this.billing, this.appliedResponses, profile).replaceBatch(replacements);
  }

  queryNames(query: NameQuery): NameResult {
    return this.reader.queryNames(query);
  }

  queryTurns(filter: SummaryFilter = {}, page: KeysetPage & { offset?: number; unknownLast?: boolean; tableSort?: UsageSort } = {}, by: 'provider' | 'model' = 'provider'): TurnSummaryRow[] {
    return this.reader.queryTurns(filter, page, by);
  }

  setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode): void {
    return this.billing.setSessionBilling(provider, sessionId, mode);
  }

  sessionBilling(provider: Provider, sessionId: string): BillingMode {
    return this.billing.sessionBilling(provider, sessionId);
  }

  queryTurnsCount(filter: SummaryFilter = {}, by: 'provider' | 'model' = 'provider'): number {
    return this.reader.queryTurnsCount(filter, by);
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
