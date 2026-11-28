// 확장 호스트에서 통계 Worker를 사용하는 공개 API를 제공한다.
import { WorkerTransport } from './transport';
import { RefreshController, type RefreshOptions } from './refresh';
import type { SummaryOptions, SummaryProgress, RefreshResult, UsageQuery, UsageResult, DiagnosticsResult, SourceRoot, NameQuery, NameResult } from '../types';
import type { BillingMode, Provider } from '../db/types';
export * from '../types';

/** 통계 조회·갱신·설정 API를 제공하고 작업 순서를 조율한다. */
export class SummaryClient {
  private readonly options: SummaryOptions;
  private readonly transport: WorkerTransport;
  private readonly refreshController: RefreshController;

  constructor(options: SummaryOptions) {
    // [설정 정책] 호출자의 설정을 복사하고 Worker를 생성할 때 그 사본을 사용한다.
    this.options = { ...options };
    this.transport = new WorkerTransport(this.options);
    this.refreshController = new RefreshController(this.transport);
  }

  initialize(): Promise<void> {
    return this.transport.request('initialize');
  }

  async setCapabilityCollectionEnabled(enabled: boolean): Promise<void> {
    // [설정 정책] 갱신 취소와 삭제가 끝나면 이미 실행 중인 Worker에도 도구 수집 설정을 전한다.
    this.options.collectCapabilities = enabled;
    await this.refreshController.cancelRefresh();
    await this.refreshController.waitForClear();
    if (this.transport.started) await this.transport.request('configureCapabilities', { enabled });
  }

  async setDeletedSourceRetentionEnabled(enabled: boolean): Promise<void> {
    // [설정 정책] 갱신 취소와 삭제가 끝나면 이미 실행 중인 Worker에도 원본 소실 보존 설정을 전한다.
    this.options.retainDeletedSourceUsage = enabled;
    await this.refreshController.cancelRefresh();
    await this.refreshController.waitForClear();
    if (this.transport.started) await this.transport.request('configureRetention', { enabled });
  }

  refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
    return this.refreshController.refresh(options);
  }

  async query(query: UsageQuery = {}): Promise<UsageResult> {
    // [조회 정책] 진행 중인 삭제가 끝난 뒤 사용량 조회를 요청한다.
    await this.refreshController.waitForClear();
    return this.transport.request('query', query);
  }

  async queryNames(query: NameQuery): Promise<NameResult> {
    // [조회 정책] 진행 중인 삭제가 끝난 뒤 그 시점의 세션·프로젝트 이름을 조회한다.
    await this.refreshController.waitForClear();
    return this.transport.request('names', query);
  }

  async setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode | null): Promise<void> {
    // [설정 정책] 삭제와 결제 유형 변경이 겹치면 삭제 완료 후 변경을 요청한다.
    await this.refreshController.waitForClear();
    return this.transport.request('setBilling', { provider, sessionId, mode });
  }

  async diagnostics(page: { limit?: number; offset?: number; afterId?: number; providers?: SourceRoot['provider'][] } = {}): Promise<DiagnosticsResult> {
    // [조회 정책] 진행 중인 삭제가 끝난 뒤 원본 진단 페이지를 요청한다.
    await this.refreshController.waitForClear();
    return this.transport.request('diagnostics', page);
  }

  cancelRefresh(): Promise<void> {
    return this.refreshController.cancelRefresh();
  }

  clearData(): Promise<void> {
    return this.refreshController.clearData();
  }

  subscribe(listener: (progress: SummaryProgress) => void): () => void {
    return this.transport.subscribe(listener);
  }

  cancel(): void {
    this.refreshController.cancel();
  }

  dispose(): Promise<void> {
    return this.transport.dispose(() => this.refreshController.cancelRefresh());
  }
}
