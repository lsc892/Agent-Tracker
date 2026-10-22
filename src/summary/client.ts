import { WorkerTransport } from './transport';
import { RefreshController, type RefreshOptions } from './refresh';
import type { SummaryOptions, SummaryProgress, RefreshResult, UsageQuery, UsageResult, DiagnosticsResult, SourceRoot, NameQuery, NameResult } from './types';
import type { BillingMode, Provider } from './db/types';
export * from './types';

/** Public summary API; worker RPC and refresh lifetimes have separate owners. */
export class SummaryClient {
  private readonly options: SummaryOptions;
  private readonly transport: WorkerTransport;
  private readonly refreshController: RefreshController;

  constructor(options: SummaryOptions) {
    this.options = { ...options };
    this.transport = new WorkerTransport(this.options);
    this.refreshController = new RefreshController(this.transport);
  }

  initialize(): Promise<void> {
    return this.transport.request('initialize');
  }

  async setCapabilityCollectionEnabled(enabled: boolean): Promise<void> {
    this.options.collectCapabilities = enabled;
    await this.refreshController.cancelRefresh();
    await this.refreshController.waitForClear();
    if (this.transport.started) await this.transport.request('configureCapabilities', { enabled });
  }

  async setDeletedSourceRetentionEnabled(enabled: boolean): Promise<void> {
    this.options.retainDeletedSourceUsage = enabled;
    await this.refreshController.cancelRefresh();
    await this.refreshController.waitForClear();
    if (this.transport.started) await this.transport.request('configureRetention', { enabled });
  }

  refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
    return this.refreshController.refresh(options);
  }

  async query(query: UsageQuery = {}): Promise<UsageResult> {
    await this.refreshController.waitForClear();
    return this.transport.request('query', query);
  }

  async queryNames(query: NameQuery): Promise<NameResult> {
    await this.refreshController.waitForClear();
    return this.transport.request('names', query);
  }

  async setSessionBilling(provider: Provider, sessionId: string, mode: BillingMode): Promise<void> {
    await this.refreshController.waitForClear();
    return this.transport.request('setBilling', { provider, sessionId, mode });
  }

  async diagnostics(page: { limit?: number; offset?: number; afterId?: number; providers?: SourceRoot['provider'][] } = {}): Promise<DiagnosticsResult> {
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
