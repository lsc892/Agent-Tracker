import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import type { SummaryOptions, SummaryProgress, RefreshResult, UsageQuery, UsageResult, DiagnosticsResult, SourceRoot } from './types';
export * from './types';

interface Pending { resolve(value: unknown): void; reject(error: Error): void }
export class SummaryClient {
  private worker: Worker | undefined;
  private sequence = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<(progress: SummaryProgress) => void>();
  private refreshPending: Promise<RefreshResult> | undefined;
  private clearPending: Promise<void> | undefined;
  private disposed = false;
  private closing: Promise<void> | undefined;
  private cancellation: Int32Array | undefined;
  constructor(private readonly options: SummaryOptions) {}

  initialize(): Promise<void> { return this.request('initialize'); }
  refresh(options: { roots?: SourceRoot[]; timezone?: string } = {}): Promise<RefreshResult> {
    if (this.clearPending) return this.clearPending.then(() => this.refresh(options));
    if (!this.refreshPending) {
      this.cancellation = new Int32Array(new SharedArrayBuffer(4));
      this.refreshPending = this.request<RefreshResult>('refresh',{...options,cancellation:this.cancellation.buffer}).finally(() => {
        this.refreshPending = undefined;this.cancellation = undefined;
      });
    }
    return this.refreshPending;
  }
  async query(query: UsageQuery = {}): Promise<UsageResult> { await this.clearPending; return this.request('query',query); }
  async diagnostics(page: {limit?:number;offset?:number;afterId?:number} = {}): Promise<DiagnosticsResult> { await this.clearPending; return this.request('diagnostics',page); }
  async cancelRefresh(): Promise<void> {
    this.cancel();
    await this.refreshPending?.catch(() => undefined);
  }
  clearData(): Promise<void> {
    this.clearPending ??= (async () => {
      await this.cancelRefresh();
      await this.request('clearData');
    })().finally(() => { this.clearPending = undefined; });
    return this.clearPending;
  }
  subscribe(listener: (progress: SummaryProgress) => void): () => void {
    this.listeners.add(listener); return () => { this.listeners.delete(listener); };
  }
  cancel(): void {
    if (this.cancellation) Atomics.store(this.cancellation,0,1);
    this.worker?.postMessage({method:'cancel'});
  }
  dispose(): Promise<void> {
    this.closing ??= this.close();
    return this.closing;
  }
  private async close(): Promise<void> {
    this.disposed = true;
    this.cancel();
    const worker = this.worker;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (worker) {
        await Promise.race([
          (async () => {
            await this.refreshPending?.catch(() => undefined);
            if (this.worker === worker) await this.request('dispose').catch(() => undefined);
          })(),
          new Promise<void>(resolve => { timeout=setTimeout(resolve,5000); }),
        ]);
        await worker.terminate();
      }
    } finally {
      if (timeout) clearTimeout(timeout);
      this.worker = undefined;this.listeners.clear();
      this.rejectAll(new Error('Summary client disposed'));
    }
  }
  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
  private request<T>(method: string, payload?: unknown): Promise<T> {
    if (this.disposed && method !== 'dispose') return Promise.reject(new Error('Summary client disposed'));
    if (!this.worker) {
      const worker = new Worker(this.options.workerPath ?? join(__dirname,'worker.js'),{workerData:this.options});
      this.worker = worker;
      worker.on('message',(message: {id?:number;result?:unknown;error?:string;progress?:SummaryProgress}) => {
        if (message.progress) { for (const listener of this.listeners) { try { listener(message.progress); } catch { /* Observers cannot break the worker. */ } } return; }
        if (message.id === undefined) return;
        const pending = this.pending.get(message.id);this.pending.delete(message.id);
        if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve(message.result);
      });
      worker.on('error',() => { this.rejectAll(new Error('Summary worker failed. Node.js 22.15+ with node:sqlite is required.')); });
      worker.on('exit',() => {
        if (this.worker === worker) { this.worker = undefined;this.rejectAll(new Error('Summary worker stopped')); }
      });
    }
    const id = ++this.sequence;
    return new Promise<T>((resolve,reject) => {
      this.pending.set(id,{resolve:value => resolve(value as T),reject});
      try { this.worker!.postMessage({id,method,payload}); }
      catch (error) { this.pending.delete(id);reject(error); }
    });
  }
}
