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

/** 파일 준비 Worker를 재사용하고 완료된 결과를 파일 ID로 보관한다. */
export class SourceReaderPool {
  readonly lookahead: number;
  private readonly concurrency: number;
  private readonly cancellation = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  private readonly jobs = new Map<number, SourceJob>();
  private readonly pending: SourceJob[] = [];
  private readonly slots = new Set<WorkerSlot>();
  private closed = false;

  /** 공유 버퍼에 취소를 표시해 모든 Worker에 중단을 알린다. */
  private readonly abort = (): void => { Atomics.store(this.cancellation, 0, 1); };

  /** 동시 실행 수와 선행 작업 한도를 정하고 취소 신호를 연결한다. */
  constructor(private readonly options: PoolOptions) {
    // [병렬 처리 정책] Worker를 최대 4개로 제한하고 선행 파일 수는 동시 Worker 수의 두 배로 정한다.
    const requestedWorkers = Math.trunc(options.workers ?? availableParallelism() - 1) || 1;
    this.concurrency = Math.max(1, Math.min(MAX_SOURCE_WORKERS, requestedWorkers));
    this.lookahead = this.concurrency * PREFETCH_PER_WORKER;
    options.signal?.addEventListener('abort', this.abort, { once: true });
  }

  /** 준비 결과까지 무제한 쌓지 않도록 최대 2×Worker 수의 파일만 선행한다. */
  prefetch(files: readonly SourceReadFile[]): void {
    // [병렬 처리 정책] 취소 여부와 미소비 작업 한도를 확인해 아직 준비하지 않은 파일만 예약한다.
    if (this.closed || this.options.cancelled() || this.concurrency === 1) return;
    if (files.length < 2 && !this.slots.size) return;
    // [병렬 처리 정책] 풀이 비어 있고 후보 전체 크기가 1MiB 미만이면 Worker를 시작하지 않는다.
    if (!this.slots.size && files.reduce((bytes, file) => bytes + file.size_bytes, 0) < MIN_PREFETCH_BYTES) return;
    for (const file of files) {
      if (this.jobs.size >= this.lookahead) break;
      if (!this.jobs.has(file.id)) this.enqueue(file);
    }
  }

  /** 파일의 선행 준비 결과를 가져오거나 필요한 경우 직접 준비한다. */
  async read(file: SourceReadFile): Promise<SourcePreparation> {
    if (this.closed || this.options.cancelled()) return this.failure('interrupted');
    const job = this.jobs.get(file.id);
    try {
      // [병렬 처리 정책] 기존 작업이나 Worker가 없으면 현재 스레드에서 파일을 준비한다.
      return await (job || this.slots.size
        ? (job ?? this.enqueue(file, true)).promise : prepareSource(file, this.options));
    }
    finally { this.jobs.delete(file.id); }
  }

  /** 남은 파일 작업을 취소하고 풀의 Worker를 모두 종료한다. */
  async dispose(): Promise<void> {
    // [종료 정책] 공유 취소를 알린 뒤 남은 작업을 중단 결과로 풀고 Worker를 모두 종료한다.
    this.closed = true;
    this.abort();
    this.options.signal?.removeEventListener('abort', this.abort);
    for (const job of this.jobs.values()) job.resolve(this.failure('interrupted'));
    this.jobs.clear(); this.pending.length = 0;
    const workers = [...this.slots].map(slot => slot.worker);
    this.slots.clear();
    await Promise.all(workers.map(worker => worker.terminate().catch(() => undefined)));
  }

  /** 풀에서 발생한 오류를 파일 준비 실패 형식으로 반환한다. */
  private failure(code: string): SourcePreparation {
    return { ok: false, error: { code, offset: 0 } };
  }

  /** 요청한 파일의 작업과 결과 Promise를 만들고 대기열에 등록한다. */
  private enqueue(file: SourceReadFile, priority = false): SourceJob {
    let resolve!: SourceJob['resolve'];
    const promise = new Promise<SourcePreparation>(done => { resolve = done; });
    // [DTO 정책] Worker에는 원본 식별과 관측 시점의 읽기 범위 검증에 필요한 필드만 보낸다.
    const metadata: SourceReadFile = { id: file.id, provider: file.provider, path: file.path, source_root: file.source_root,
      size_bytes: file.size_bytes, mtime_ms: file.mtime_ms };
    // [큐 정책] 즉시 필요한 파일을 대기열 앞에 두고 선행 읽기는 뒤에 붙인다.
    const job: SourceJob = { file: metadata, promise, resolve };
    this.jobs.set(file.id, job);
    if (priority) this.pending.unshift(job); else this.pending.push(job);
    this.dispatch();
    return job;
  }

  /** 대기 중인 파일 준비 작업을 처리할 Worker를 확보한다. */
  private dispatch(): void {
    // [병렬 처리 정책] 유휴 Worker를 먼저 재사용하고 할 일이 남으면 동시 실행 한도까지 추가한다.
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

  /** 새 Worker를 시작하고 결과·오류·종료 메시지를 연결한다. */
  private startWorker(): void {
    // [취소 정책] 정리용 취소 버퍼와 갱신 전체의 취소 버퍼를 새 Worker에 공유한다.
    const worker = new Worker(join(__dirname, 'sourceWorker.js'), { workerData: {
      maxLineBytes: this.options.maxLineBytes, collectCapabilities: this.options.collectCapabilities,
      cancellation: this.cancellation.buffer, externalCancellation: this.options.externalCancellation,
    } });
    const slot: WorkerSlot = { worker };
    this.slots.add(slot);
    worker.on('message', (message: SourceWorkerMessage) => this.receive(slot, message));
    worker.on('error', () => this.workerFailed(slot));
    worker.on('exit', () => this.workerFailed(slot));
    this.assign(slot);
  }

  /** Worker가 보낸 읽기 진행량과 파일의 최종 결과를 반영한다. */
  private receive(slot: WorkerSlot, message: SourceWorkerMessage): void {
    // [병렬 처리 정책] 현재 파일 메시지만 받아 진행량을 누적하고 최종 결과가 오면 슬롯을 재사용한다.
    if (slot.job?.file.id !== message.id) return;
    this.options.onBytes?.(message.bytes);
    if (!message.result) return;
    slot.job.resolve(message.result);
    slot.job = undefined;
    this.dispatch();
  }

  /** 대기열의 첫 작업을 슬롯에 기록하고 Worker에 전달한다. */
  private assign(slot: WorkerSlot): void {
    const job = this.pending.shift();
    if (!job) return;
    slot.job = job;
    try { slot.worker.postMessage(job.file); }
    catch { this.workerFailed(slot); }
  }

  /** 종료되거나 실패한 Worker의 작업을 실패 처리하고 남은 작업을 이어간다. */
  private workerFailed(slot: WorkerSlot): void {
    // [오류 정책] 오류와 종료가 연달아 와도 슬롯을 한 번만 폐기하고 대기 작업을 다시 배정한다.
    if (!this.slots.delete(slot)) return;
    slot.job?.resolve(this.failure(this.options.cancelled() ? 'interrupted' : 'source-worker-error'));
    void slot.worker.terminate().catch(() => undefined);
    this.dispatch();
  }
}
