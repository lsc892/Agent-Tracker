// DB에 접근하지 않고 전달받은 파일 하나의 읽기·파싱·winner 선택을 실행한다.
import { parentPort, workerData } from 'node:worker_threads';
import { prepareSource, type SourceFile } from './sourcePreparation';

const PROGRESS_INTERVAL_MS = 100;

if (!parentPort) throw new Error('Source worker requires a parent');
const port = parentPort;
const options = workerData as { collectCapabilities: boolean; maxLineBytes?: number;
  cancellation: SharedArrayBuffer; externalCancellation?: SharedArrayBuffer };
const cancellation = new Int32Array(options.cancellation);
const externalCancellation = options.externalCancellation ? new Int32Array(options.externalCancellation) : undefined;

port.on('message', (message: { id: number; file: SourceFile }) => {
  let readBytes = 0, reportedBytes = 0, lastReportAtMs = performance.now();
  void prepareSource(message.file, { ...options,
    cancelled: () => Boolean(Atomics.load(cancellation, 0)
      || externalCancellation && Atomics.load(externalCancellation, 0)),
    onBytes: count => {
      readBytes += count;
      if (performance.now() - lastReportAtMs < PROGRESS_INTERVAL_MS) return;
      port.postMessage({ id: message.id, bytes: readBytes - reportedBytes });
      reportedBytes = readBytes;
      lastReportAtMs = performance.now();
    },
  }).then(result => port.postMessage({ id: message.id, result, bytes: readBytes - reportedBytes }));
});
