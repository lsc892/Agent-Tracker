import type { DatabaseSync } from 'node:sqlite';
import type { NameQuery, NameResult } from '../types';
import type {
  BillingMode, CapabilityCategory, CapabilityPage, ChartMetric, DiagnosticsPage, FileMetadata,
  KeysetPage, ManifestRow, OffsetPage, ProcessingStatus, Provider, SessionReplacement, SummaryFilter,
  TurnSummaryRow, UsagePage, UsageGrouping, UsageRow, UsageSort,
} from './types';
import { SqliteSession, type SqliteSessionOptions } from './connection';
import { ManifestStore } from './manifest';
import { SessionStore } from './sessions';
import { SessionBillingStore } from './billing';
import { SummaryReader } from './reader';

export * from './types';
export { usageChartFromPage } from './chart';
export { periodBounds } from './timezone';

/**
 * 책임: Worker와 스캐너가 사용하는 통계 DB의 공통 진입점을 제공한다.
 * 알고리즘: 하나의 연결·트랜잭션 소유자를 생성하고 manifest·세션 저장·비용·조회 책임에 같은 연결을 주입해 위임한다.
 */
export class SummaryDatabase {
  readonly connection: DatabaseSync;
  private readonly sqlite: SqliteSession;
  private readonly manifest: ManifestStore;
  private readonly sessions: SessionStore;
  private readonly billing: SessionBillingStore;
  private readonly reader: SummaryReader;

  constructor(options: SqliteSessionOptions) {
    this.sqlite = new SqliteSession(options);
    this.connection = this.sqlite.connection;
    this.manifest = new ManifestStore(this.sqlite);
    this.billing = new SessionBillingStore(this.sqlite);
    this.sessions = new SessionStore(this.sqlite, this.billing);
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
    return this.sessions.clearData();
  }

  findManifest(provider: Provider, path: string): ManifestRow | undefined {
    return this.manifest.findManifest(provider, path);
  }

  findIdentity(provider: Provider, dev: string | null, inode: string | null): ManifestRow[] {
    return this.manifest.findIdentity(provider, dev, inode);
  }

  observeFile(metadata: FileMetadata, scanId: string): ManifestRow {
    return this.manifest.observeFile(metadata, scanId);
  }

  markSeen(id: number, scanId: string): void {
    return this.manifest.markSeen(id, scanId);
  }

  setManifestDiagnostic(id: number, status: ProcessingStatus, position: string | null, error: string | null, offset: number | null = null): void {
    return this.manifest.setManifestDiagnostic(id, status, position, error, offset);
  }

  sessionFiles(provider: Provider, sessionId: string, limit = 100): IterableIterator<ManifestRow> {
    return this.manifest.sessionFiles(provider, sessionId, limit);
  }

  unseenFiles(provider: Provider, sourceRoot: string, scanId: string, limit = 100): IterableIterator<ManifestRow> {
    return this.manifest.unseenFiles(provider, sourceRoot, scanId, limit);
  }

  replaceSessions(replacement: SessionReplacement): void {
    return this.sessions.replaceSessions(replacement);
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
}
