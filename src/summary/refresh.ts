import { WorkerTransport } from './transport';
import type { RefreshResult, SourceRoot } from './types';

export interface RefreshOptions {
  roots?: SourceRoot[];
  timezone?: string;
}

/**
 * 책임: 통계 갱신의 중복 병합과 데이터 삭제의 실행 순서를 관리한다.
 * 알고리즘: 진행 중 갱신·삭제 Promise를 공유하고 삭제 전 갱신을 취소하며, 공유 메모리의 원자적 플래그로 Worker에 취소를 전달한다.
 */
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
