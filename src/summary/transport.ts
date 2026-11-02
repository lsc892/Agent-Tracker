// 확장 호스트와 통계 Worker 사이의 요청·응답 및 진행 알림을 전달한다.
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { t, type TranslationKey } from '../localization';
import type { SummaryOptions, SummaryProgress } from './types';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
}

interface WorkerMessage {
  id?: number;
  result?: unknown;
  error?: string;
  errorKey?: TranslationKey;
  progress?: SummaryProgress;
}

/** Worker의 수명과 요청별 응답·진행 알림 분배를 관리한다. */
export class WorkerTransport {
  private worker: Worker | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly listeners = new Set<(progress: SummaryProgress) => void>();
  private disposed = false;
  private closing: Promise<void> | undefined;

  constructor(private readonly options: SummaryOptions) {}

  get started(): boolean {
    return this.worker !== undefined;
  }

  request<T>(method: string, payload?: unknown): Promise<T> {
    if (this.disposed && method !== 'dispose') return Promise.reject(new Error('Summary client disposed'));
    const worker = this.ensureWorker();
    return this.sendRequest(worker, method, payload);
  }

  notify(method: string): void {
    this.worker?.postMessage({ method });
  }

  subscribe(listener: (progress: SummaryProgress) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(waitForRefresh: () => Promise<void>): Promise<void> {
    this.closing ??= this.close(waitForRefresh);
    return this.closing;
  }

  /**
   * 책임: 필요한 첫 통계 작업에서만 Worker를 생성한다.
   * 알고리즘: 설정 스냅샷으로 Worker를 한 번 만들고 메시지·오류·종료 핸들러를 연결하며 해당 인스턴스 종료 시 대기 요청을 거절한다.
   */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(this.options.workerPath ?? join(__dirname, 'worker.js'), { workerData: this.options });
    this.worker = worker;
    worker.on('message', (message: WorkerMessage) => this.receive(message));
    worker.on('error', () => {
      this.rejectAll(new Error('Summary worker failed. Node.js 22.15+ with node:sqlite is required.'));
    });
    worker.on('exit', () => {
      if (this.worker === worker) {
        this.worker = undefined;
        this.rejectAll(new Error('Summary worker stopped'));
      }
    });
    return this.worker;
  }

  private sendRequest<T>(worker: Worker, method: string, payload?: unknown): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      try {
        worker.postMessage({ id, method, payload });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  /**
   * 책임: Worker의 진행 알림과 RPC 완료를 각각의 소비자에게 전달한다.
   * 알고리즘: 진행률은 관찰자에 분배하고 나머지는 ID로 pending을 제거한 뒤 번역된 오류 또는 결과로 Promise를 완료한다.
   */
  private receive(message: WorkerMessage): void {
    if (message.progress) {
      for (const listener of this.listeners) {
        try { listener(message.progress); } catch { /* Observers cannot break the worker. */ }
      }
      return;
    }
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.errorKey || message.error) {
      pending?.reject(new Error(message.errorKey ? t(message.errorKey) : message.error));
    } else {
      pending?.resolve(message.result);
    }
  }

  /**
   * 책임: 통계 작업 취소 후 제한된 시간 안에 Worker를 종료한다.
   * 알고리즘: 갱신 취소와 dispose 요청을 최대 5초 기다린 뒤 terminate하고 리스너·타이머·미완료 요청을 정리한다.
   */
  private async close(waitForRefresh: () => Promise<void>): Promise<void> {
    this.disposed = true;
    // Cancellation still runs when no worker has been created.
    const refreshSettled = waitForRefresh();
    const worker = this.worker;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!worker) return;
      await Promise.race([
        (async () => {
          await refreshSettled;
          if (this.worker === worker) await this.request('dispose').catch(() => undefined);
        })(),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); }),
      ]);
      await worker.terminate();
    } finally {
      if (timeout) clearTimeout(timeout);
      this.worker = undefined;
      this.listeners.clear();
      this.rejectAll(new Error('Summary client disposed'));
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
