// 확장 호스트와 통계 Worker 사이의 요청·응답 및 진행 알림을 전달한다.
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { t, type TranslationKey } from '../../localization';
import type { SummaryOptions, SummaryProgress } from '../types';

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
    // [종료 정책] 종료가 시작된 통신에서는 Worker 종료 요청만 허용한다.
    if (this.disposed && method !== 'dispose') return Promise.reject(new Error('Summary client disposed'));
    const worker = this.ensureWorker();
    return this.sendRequest(worker, method, payload);
  }

  notify(method: string): void {
    // [통신 정책] 이미 실행 중인 Worker에만 응답 ID 없이 알림을 보낸다.
    this.worker?.postMessage({ method });
  }

  subscribe(listener: (progress: SummaryProgress) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  dispose(waitForRefresh: () => Promise<void>): Promise<void> {
    // [종료 정책] 중복 종료 호출은 같은 종료 작업을 기다린다.
    this.closing ??= this.close(waitForRefresh);
    return this.closing;
  }

  /** 필요한 첫 통계 작업에서 Worker를 생성한다. */
  private ensureWorker(): Worker {
    // [실행 정책] 현재 Worker를 재사용하고 없으면 그 시점의 설정을 복사해 시작한다.
    if (this.worker) return this.worker;
    const worker = new Worker(this.options.workerPath ?? join(__dirname, 'worker.js'), { workerData: this.options });
    this.worker = worker;

    // [통신 정책] 진행·응답을 분배하고 실행 오류나 현재 Worker 종료 시 미완료 요청을 거절한다.
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
    // [통신 정책] 요청 ID로 대기 중인 Promise를 등록한 뒤 보내고 전송 실패 시 등록을 지운다.
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

  /** Worker의 진행 알림과 RPC 응답을 전달한다. */
  private receive(message: WorkerMessage): void {
    // [통신 정책] 진행 알림은 모든 리스너에 전달하며 리스너 하나가 실패해도 분배를 계속한다.
    if (message.progress) {
      for (const listener of this.listeners) {
        try { listener(message.progress); } catch { /* Observers cannot break the worker. */ }
      }
      return;
    }

    // [통신 정책] 응답 ID의 대기 항목을 지우고 요청을 결과 또는 번역한 오류로 완료한다.
    if (message.id === undefined) return;
    const pending = this.pending.get(message.id);
    this.pending.delete(message.id);
    if (message.errorKey || message.error) {
      pending?.reject(new Error(message.errorKey ? t(message.errorKey) : message.error));
    } else {
      pending?.resolve(message.result);
    }
  }

  /** 통계 작업을 취소하고 Worker를 종료한다. */
  private async close(waitForRefresh: () => Promise<void>): Promise<void> {
    this.disposed = true;
    // [종료 정책] Worker 생성 여부와 관계없이 갱신 취소를 시작한다.
    const refreshSettled = waitForRefresh();
    const worker = this.worker;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!worker) return;
      // [종료 정책] 갱신 취소와 Worker의 DB 정리 응답을 최대 5초 기다린 뒤 Worker를 종료한다.
      await Promise.race([
        (async () => {
          await refreshSettled;
          if (this.worker === worker) await this.request('dispose').catch(() => undefined);
        })(),
        new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); }),
      ]);
      await worker.terminate();
    } finally {
      // [종료 정책] 타이머와 리스너를 정리하고 남아 있는 요청은 종료 오류로 거절한다.
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
