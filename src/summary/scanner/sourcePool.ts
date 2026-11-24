// 파일 준비 Worker를 재사용하고 읽기 선행 개수와 갱신 종료 시 자원 수명을 제한한다.
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { prepareSource, type SourcePreparation, type SourcePreparationOptions } from './sourcePreparation';
import type { SourceReadFile } from './sourceReader';

const MAX_SOURCE_WORKERS = 4;
const PREFETCH_PER_WORKER = 2;
const MIN_PREFETCH_BYTES = 1024 * 1024;

interface SourceJob {
  file: SourceReadFile;
  promise: Promise<SourcePreparation>;
  resolve: (value: SourcePreparation) => void;
}
interface WorkerSlot { worker: Worker; job?: SourceJob }
interface PoolOptions extends SourcePreparationOptions { workers?: number; externalCancellation?: SharedArrayBuffer }
interface SourceWorkerMessage { id: number; result?: SourcePreparation; bytes: number }

/** 완료 순서와 무관하게 호출자가 원래 논리 순서로 파일 준비 결과를 소비한다. */
export class SourceReaderPool {
  readonly lookahead: number;
  private readonly concurrency: number;
  private readonly cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  private readonly jobs = new Map<number, SourceJob>();
  private readonly pending: SourceJob[] = [];
  private readonly slots = new Set<WorkerSlot>();
  private readonly prepared = new Map<number, SourcePreparation>();
  private capture = false;
  private closed = false;
  private readonly abort = (): void => { Atomics.store(this.cancellation, 0, 1); };

  constructor(private readonly options: PoolOptions) {
    const requestedWorkers = Math.trunc(options.workers ?? availableParallelism() - 1) || 1;
    this.concurrency = Math.max(1, Math.min(MAX_SOURCE_WORKERS, requestedWorkers));
    this.lookahead = this.concurrency * PREFETCH_PER_WORKER;
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }

  capturePreparations(enabled: boolean): void {
    this.capture = enabled;
  }

  /** 준비 결과까지 무제한 쌓지 않도록 최대 2×Worker 수의 파일만 선행한다. */
  prefetch(files: readonly SourceReadFile[]): void {
    if (this.closed || this.options.cancelled() || this.concurrency === 1) return;
    if (this.prepared.size) files = files.filter(file => !this.prepared.has(file.id));
    if (files.length < 2 && !this.slots.size) return;
    // 작은 파일들만 남은 경우에는 시작·메시지 비용보다 순차 준비가 저렴하다.
    if (!this.slots.size && files.reduce((bytes, file) => bytes + file.size_bytes, 0) < MIN_PREFETCH_BYTES) return;
    for (const file of files) {
      if (this.jobs.size >= this.lookahead) break;
      if (!this.jobs.has(file.id)) this.enqueue(file);
    }
  }

  async read(file: SourceReadFile, fixedObservation: boolean): Promise<SourcePreparation> {
    if (this.closed || this.options.cancelled()) return this.failure('interrupted');
    const prepared = this.prepared.get(file.id);
    if (prepared && !this.capture) {
      this.prepared.delete(file.id);
      return prepared;
    }
    const job = this.jobs.get(file.id);
    try {
      // 파일 하나만 필요한 갱신에는 Worker 시작 비용을 추가하지 않는다.
      const result = await (job || this.slots.size
        ? (job ?? this.enqueue(file, true)).promise : prepareSource(file, this.options));
      if (this.capture && fixedObservation && result.ok) this.prepared.set(file.id, result);
      return result;
    }
    finally { this.jobs.delete(file.id); }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.abort();
    this.options.signal?.removeEventListener('abort', this.abort);
    for (const job of this.jobs.values()) job.resolve(this.failure('interrupted'));
    this.jobs.clear(); this.pending.length = 0;
    this.prepared.clear();
    const workers = [...this.slots].map(slot => slot.worker);
    this.slots.clear();
    await Promise.all(workers.map(worker => worker.terminate().catch(() => undefined)));
  }

  private failure(code: string): SourcePreparation {
    return { ok: false, error: { code, offset: 0 } };
  }

  private enqueue(file: SourceReadFile, priority = false): SourceJob {
    let resolve!: SourceJob['resolve'];
    const promise = new Promise<SourcePreparation>(done => { resolve = done; });
    // Worker에는 읽기 경계와 원본을 확인할 필드만 보낸다.
    const metadata: SourceReadFile = { id: file.id, provider: file.provider, path: file.path, source_root: file.source_root,
      size_bytes: file.size_bytes, mtime_ms: file.mtime_ms };
    const job: SourceJob = { file: metadata, promise, resolve };
    this.jobs.set(file.id, job);
    if (priority) this.pending.unshift(job); else this.pending.push(job);
    this.dispatch();
    return job;
  }

  private dispatch(): void {
    if (this.closed) return;
    for (const slot of this.slots) if (!slot.job) this.assign(slot);
    while (this.pending.length && this.slots.size < this.concurrency) {
      try {
        this.startWorker();
      } catch {
        this.pending.shift()!.resolve(this.failure('source-worker-error'));
      }
    }
  }

  private startWorker(): void {
    const worker = new Worker(join(__dirname, 'sourceWorker.js'), { workerData: {
      maxLineBytes: this.options.maxLineBytes,
      cancellation: this.cancellation.buffer, externalCancellation: this.options.externalCancellation,
    } });
    const slot: WorkerSlot = { worker };
    this.slots.add(slot);
    worker.on('message', (message: SourceWorkerMessage) => this.receive(slot, message));
    worker.on('error', () => this.workerFailed(slot));
    worker.on('exit', () => this.workerFailed(slot));
    this.assign(slot);
  }

  private receive(slot: WorkerSlot, message: SourceWorkerMessage): void {
    if (slot.job?.file.id !== message.id) return;
    this.options.onBytes?.(message.bytes);
    if (!message.result) return;
    slot.job.resolve(message.result);
    slot.job = undefined;
    this.dispatch();
  }

  private assign(slot: WorkerSlot): void {
    const job = this.pending.shift();
    if (!job) return;
    slot.job = job;
    try { slot.worker.postMessage(job.file); }
    catch { this.workerFailed(slot); }
  }

  private workerFailed(slot: WorkerSlot): void {
    if (!this.slots.delete(slot)) return;
    slot.job?.resolve(this.failure(this.options.cancelled() ? 'interrupted' : 'source-worker-error'));
    void slot.worker.terminate().catch(() => undefined);
    this.dispatch();
  }
}
