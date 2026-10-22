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

/** Owns lazy worker creation, request routing and bounded worker shutdown. */
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

  private ensureWorker(): Worker {
    if (!this.worker) {
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
    }
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

  private async close(waitForRefresh: () => Promise<void>): Promise<void> {
    this.disposed = true;
    // Cancellation still runs when no worker has been created.
    const refreshSettled = waitForRefresh();
    const worker = this.worker;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (worker) {
        await Promise.race([
          (async () => {
            await refreshSettled;
            if (this.worker === worker) await this.request('dispose').catch(() => undefined);
          })(),
          new Promise<void>(resolve => { timeout = setTimeout(resolve, 5000); }),
        ]);
        await worker.terminate();
      }
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
