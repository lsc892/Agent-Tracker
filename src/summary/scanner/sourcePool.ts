// 파일 준비 Worker를 재사용하고 읽기 선행 개수와 갱신 종료 시 자원 수명을 제한한다.
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { prepareSource, type SourceFile, type SourcePreparation, type SourcePreparationOptions } from './sourcePreparation';

const MAX_SOURCE_WORKERS = 4;
const PREFETCH_PER_WORKER = 2;
const MIN_PREFETCH_BYTES = 1024 * 1024;

interface SourceJob {
  file: SourceFile;
  promise: Promise<SourcePreparation>;
  resolve: (value: SourcePreparation) => void;
}
interface WorkerSlot { worker: Worker; job?: SourceJob }
interface PoolOptions extends SourcePreparationOptions { workers?: number; externalCancellation?: SharedArrayBuffer }
interface SourceWorkerMessage { id: number; result?: SourcePreparation; bytes: number }

/** 완료 순서와 무관하게 호출자가 원래 논리 순서로 파일 준비 결과를 소비한다. */
export class SourceReaderPool {
  readonly concurrency: number;
  readonly lookahead: number;
  private readonly cancellation = new SharedArrayBuffer(4);
  private readonly jobs = new Map<number, SourceJob>();
  private readonly pending: SourceJob[] = [];
  private readonly slots = new Set<WorkerSlot>();
  private closed = false;
  private readonly abort = (): void => { Atomics.store(new Int32Array(this.cancellation), 0, 1); };

  constructor(private readonly options: PoolOptions) {
    const requestedWorkers = Math.trunc(options.workers ?? availableParallelism() - 1) || 1;
    this.concurrency = Math.max(1, Math.min(MAX_SOURCE_WORKERS, requestedWorkers));
    this.lookahead = this.concurrency * PREFETCH_PER_WORKER;
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }

  /** 준비 결과까지 무제한 쌓지 않도록 최대 2×Worker 수의 파일만 선행한다. */
  prefetch(files: readonly SourceFile[]): void {
    if (this.closed || this.options.cancelled() || this.concurrency === 1) return;
    if (files.length < 2 && !this.slots.size) return;
    // 작은 파일들만 남은 경우에는 시작·메시지 비용보다 순차 준비가 저렴하다.
    if (!this.slots.size && files.reduce((bytes, file) => bytes + file.size_bytes, 0) < MIN_PREFETCH_BYTES) return;
    for (const file of files) {
      if (this.jobs.size >= this.lookahead) break;
      if (!this.jobs.has(file.id)) this.enqueue(file);
    }
  }

  async read(file: SourceFile): Promise<SourcePreparation> {
    if (this.closed || this.options.cancelled()) return this.failure('interrupted');
    let job = this.jobs.get(file.id);
    // 파일 하나만 필요한 갱신에는 Worker 시작 비용을 추가하지 않는다.
    if (!job && !this.slots.size) return prepareSource(file, this.options);
    job ??= this.enqueue(file, true);
    try { return await job.promise; }
    finally { this.jobs.delete(file.id); }
  }

  async dispose(): Promise<void> {
    this.closed = true;
    this.abort();
    this.options.signal?.removeEventListener('abort', this.abort);
    for (const job of this.jobs.values()) job.resolve(this.failure('interrupted'));
    this.jobs.clear(); this.pending.length = 0;
    const workers = [...this.slots].map(slot => slot.worker);
    this.slots.clear();
    await Promise.all(workers.map(worker => worker.terminate().catch(() => undefined)));
  }

  private failure(code: string): SourcePreparation {
    return { ok: false, error: { code, offset: 0 }, bytes: 0, elapsedMs: 0 };
  }

  private enqueue(file: SourceFile, priority = false): SourceJob {
    let resolve!: SourceJob['resolve'];
    const promise = new Promise<SourcePreparation>(done => { resolve = done; });
    // FileState의 prepared/previous를 Worker로 복사하지 않는다.
    const metadata: SourceFile = { id: file.id, provider: file.provider, path: file.path, source_root: file.source_root,
      session_id: file.session_id, size_bytes: file.size_bytes, mtime_ms: file.mtime_ms,
      dev: file.dev, inode: file.inode, parser_version: file.parser_version,
      capabilities_collected: file.capabilities_collected };
    const job = { file: metadata, promise, resolve };
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
      collectCapabilities: this.options.collectCapabilities, maxLineBytes: this.options.maxLineBytes,
      cancellation: this.cancellation, externalCancellation: this.options.externalCancellation,
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
    try { slot.worker.postMessage({ id: job.file.id, file: job.file }); }
    catch { this.workerFailed(slot); }
  }

  private workerFailed(slot: WorkerSlot): void {
    if (!this.slots.delete(slot)) return;
    slot.job?.resolve(this.failure(this.options.cancelled() ? 'interrupted' : 'source-worker-error'));
    void slot.worker.terminate().catch(() => undefined);
    this.dispatch();
  }
}
