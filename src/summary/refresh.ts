import { WorkerTransport } from './transport';
import type { RefreshResult, SourceRoot } from './types';

export interface RefreshOptions {
  roots?: SourceRoot[];
  timezone?: string;
}

/** Serializes data clearing and coalesces refreshes independently of worker RPC. */
export class RefreshController {
  private refreshPending: Promise<RefreshResult> | undefined;
  private clearPending: Promise<void> | undefined;
  private cancellation: Int32Array | undefined;

  constructor(private readonly transport: WorkerTransport) {}

  refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
    if (this.clearPending) return this.clearPending.then(() => this.refresh(options));
    if (!this.refreshPending) {
      this.cancellation = new Int32Array(new SharedArrayBuffer(4));
      this.refreshPending = this.transport.request<RefreshResult>('refresh', {
        ...options,
        cancellation: this.cancellation.buffer,
      }).finally(() => {
        this.refreshPending = undefined;
        this.cancellation = undefined;
      });
    }
    return this.refreshPending;
  }

  cancel(): void {
    if (this.cancellation) Atomics.store(this.cancellation, 0, 1);
    this.transport.notify('cancel');
  }

  async cancelRefresh(): Promise<void> {
    this.cancel();
    await this.refreshPending?.catch(() => undefined);
  }

  clearData(): Promise<void> {
    this.clearPending ??= (async () => {
      await this.cancelRefresh();
      await this.transport.request('clearData');
    })().finally(() => { this.clearPending = undefined; });
    return this.clearPending;
  }

  async waitForClear(): Promise<void> {
    await this.clearPending;
  }
}
