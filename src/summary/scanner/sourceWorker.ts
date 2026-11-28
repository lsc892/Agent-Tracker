// 부모 스레드의 파일 준비 요청을 처리하고 읽기 진행량과 결과를 돌려준다.
import { parentPort, workerData } from 'node:worker_threads';
import { prepareSource } from './sourcePreparation';
import type { SourceReadFile } from './sourceReader';

const PROGRESS_INTERVAL_MS = 100;

if (!parentPort) throw new Error('Source worker requires a parent');
const port = parentPort;
const options = workerData as { maxLineBytes?: number; collectCapabilities: boolean;
  cancellation: SharedArrayBuffer; externalCancellation?: SharedArrayBuffer };
const cancellation = new Int32Array(options.cancellation);
const externalCancellation = options.externalCancellation ? new Int32Array(options.externalCancellation) : undefined;

/** 풀 종료와 갱신 전체의 취소 신호를 공유 버퍼에서 확인한다. */
const cancelled = (): boolean => Boolean(Atomics.load(cancellation, 0)
  || externalCancellation && Atomics.load(externalCancellation, 0));

// 받은 파일 하나를 파싱해 집계에 필요한 응답과 관계 근거를 반환한다.
port.on('message', (file: SourceReadFile) => {
  // [진행 정책] 읽은 바이트를 100ms 단위로 모아 보고하고 마지막 잔여량은 파일 결과와 함께 보낸다.
  let pendingBytes = 0, lastReportAtMs = performance.now();
  void prepareSource(file, { maxLineBytes: options.maxLineBytes, collectCapabilities: options.collectCapabilities, cancelled,
    onBytes: count => {
      pendingBytes += count;
      if (performance.now() - lastReportAtMs < PROGRESS_INTERVAL_MS) return;
      port.postMessage({ id: file.id, bytes: pendingBytes });
      pendingBytes = 0;
      lastReportAtMs = performance.now();
    },
  }).then(result => {
    port.postMessage({ id: file.id, result, bytes: pendingBytes });
  });
});
