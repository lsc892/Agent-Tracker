// 통계 갱신·취소·삭제 요청의 중복과 실행 순서를 관리한다.
import { WorkerTransport } from './transport';
import type { RecentWindow } from '../db/recentSnapshot';
import type { RefreshResult, SourceRoot, UsageQuery } from '../types';

export interface RefreshOptions {
  roots?: SourceRoot[];
  timezone?: string;
  recentUsage?: RecentWindow & Pick<UsageQuery, 'providers' | 'includeCosts' | 'excludeEmptyUsage'>;
}

/** 진행 중 갱신·삭제를 공유하고 Worker에 갱신 취소를 전달한다. */
export class RefreshController {
  private refreshPending: Promise<RefreshResult> | undefined;
  private clearPending: Promise<void> | undefined;
  private cancellation: Int32Array | undefined;

  constructor(private readonly transport: WorkerTransport) {}

  refresh(options: RefreshOptions = {}): Promise<RefreshResult> {
    // [갱신 정책] 삭제 중이면 완료 후 다시 갱신을 요청하고 이미 진행 중인 갱신은 Promise를 공유한다.
    if (this.clearPending) return this.clearPending.then(() => this.refresh(options));
    if (!this.refreshPending) {
      // [취소 정책] 갱신마다 취소용 공유 버퍼를 넘기고 요청이 끝나면 Promise와 버퍼를 비운다.
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
    // [취소 정책] 공유 플래그를 원자적으로 설정하고 Worker에도 취소 메시지를 보낸다.
    if (this.cancellation) Atomics.store(this.cancellation, 0, 1);
    this.transport.notify('cancel');
  }

  async cancelRefresh(): Promise<void> {
    // [취소 정책] 갱신이 끝날 때까지 기다리되 갱신 실패로 후속 작업을 막지 않는다.
    this.cancel();
    await this.refreshPending?.catch(() => undefined);
  }

  clearData(): Promise<void> {
    // [삭제 정책] 중복 삭제는 하나로 합치고 갱신이 끝난 뒤 Worker에 삭제를 요청한다.
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
