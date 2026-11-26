// DB에 접근하지 않고 전달받은 스레드 로그 하나의 사용량을 집계한다.
import { parentPort, workerData } from 'node:worker_threads';
import { prepareSource } from './sourcePreparation';
import type { SourceReadFile } from './sourceReader';

const PROGRESS_INTERVAL_MS = 100;

if (!parentPort) throw new Error('Source worker requires a parent');
const port = parentPort;
const options = workerData as { maxLineBytes?: number;
  cancellation: SharedArrayBuffer; externalCancellation?: SharedArrayBuffer };
const cancellation = new Int32Array(options.cancellation);
const externalCancellation = options.externalCancellation ? new Int32Array(options.externalCancellation) : undefined;
const cancelled = (): boolean => Boolean(Atomics.load(cancellation, 0)
  || externalCancellation && Atomics.load(externalCancellation, 0));

port.on('message', (file: SourceReadFile) => {
  // [진행 정책] 읽은 바이트를 100ms 단위로 모아 보고하고 마지막 잔여량은 파일 결과와 함께 보낸다.
  let pendingBytes = 0, lastReportAtMs = performance.now();
  void prepareSource(file, { maxLineBytes: options.maxLineBytes, cancelled,
    onBytes: count => {
      pendingBytes += count;
      if (performance.now() - lastReportAtMs < PROGRESS_INTERVAL_MS) return;
      port.postMessage({ id: file.id, bytes: pendingBytes });
      pendingBytes = 0;
      lastReportAtMs = performance.now();
    },
  }).then(result => {
    const thread = result.ok ? result.read.thread : undefined;
    // 수집기가 토큰과 비교 서명 버퍼의 소유권을 넘겨받는다.
    const transfer: ArrayBuffer[] = [];
    if (thread?.responses.tokens.length) transfer.push(thread.responses.tokens.buffer);
    if (thread?.legacy) {
      const { tokens, signatures: { bytes, offsets, rowIds } } = thread.legacy;
      transfer.push(tokens.buffer, bytes.buffer, offsets.buffer, rowIds.buffer);
    }
    port.postMessage({ id: file.id, result, bytes: pendingBytes }, transfer);
  });
});
