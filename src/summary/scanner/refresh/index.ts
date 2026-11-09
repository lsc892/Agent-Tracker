// 갱신 단계의 실행 순서와 잠금·진행·취소·Worker 종료 수명을 조율한다.
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SummaryDatabase } from '../../db';
import { SummaryError } from '../../jsonl';
import { StageProfiler, type ScanStage, type StorageStage } from '../../profiling';
import type { RefreshResult, SummaryOptions, SummaryProgress } from '../../types';
import { acquireRefreshLock } from '../lock';
import { readNames } from '../names';
import { SourceReaderPool } from '../sourcePool';
import { collectWinners } from './aggregation';
import type { RefreshContext } from './context';
import { discoverSources } from './discovery';
import { commitComponents, finishScan, recordFailure } from './persistence';
import { prepareChanged } from './preparation';
import { expandRelatedSources, reconnectSources, resolveParentRequests } from './relations';
import { ScanState } from './state';

export { PARSER_VERSION } from './state';

/** 같은 스캔 상태를 각 단계에 전달하고 준비부터 성분별 저장까지의 순서를 보존한다. */
export async function refreshSummary(
  database: SummaryDatabase, options: SummaryOptions, signal?: AbortSignal,
  progress?: (value: SummaryProgress) => void,
): Promise<RefreshResult> {
  const started = performance.now();
  const scan = new StageProfiler<ScanStage>(), storage = new StageProfiler<StorageStage>();
  const result: RefreshResult = { scanId: randomUUID(), discovered: 0, parsed: 0, reused: 0, failed: 0,
    bodyBytes: 0, interrupted: false, completedAt: '', timings: { totalMs: 0, scan: scan.timings, storage: storage.timings } };
  const cancellation = options.cancellation ? new Int32Array(options.cancellation) : undefined;
  const cancelled = (): boolean => Boolean(signal?.aborted || cancellation && Atomics.load(cancellation, 0));
  const check = (): void => {
    if (cancelled()) throw new SummaryError('interrupted');
  };
  const sourcePool = new SourceReaderPool({ workers: options.sourceWorkers, collectCapabilities: options.collectCapabilities !== false,
    maxLineBytes: options.maxLineBytes, signal, cancelled, externalCancellation: options.cancellation,
    onBytes: bytes => { result.bodyBytes += bytes; report(); } });
  let phase: SummaryProgress['phase'] = 'scanning', lastProgress = 0, release: (() => void) | undefined;
  const report = (force = false): void => {
    if (force || Date.now() - lastProgress > 100) {
      progress?.({ phase, discovered: result.discovered, parsed: result.parsed, failed: result.failed, bodyBytes: result.bodyBytes });
      lastProgress = Date.now();
    }
  };
  const state = new ScanState(result);
  const collect = options.collectCapabilities !== false, retain = options.retainDeletedSourceUsage !== false;
  const roots = options.roots.map(root => ({ ...root, path: resolve(root.path) }));
  const context: RefreshContext = { database, result, scan, storage, state, sourcePool,
    roots, collect, retain, cancelled, check, report };

  try {
    check();
    release = await scan.measureAsync('lock', () => acquireRefreshLock(options.dbPath, signal, cancelled));
    report(true);
    await scan.measureAsync('discover', () => discoverSources(context));
    check();
    const names = await scan.measureAsync('names', () => readNames(roots, cancelled));
    phase = 'parsing';
    report(true);
    await scan.measureAsync('parseChanged', () => prepareChanged(context));
    await scan.measureAsync('expandRelated', () => expandRelatedSources(context));
    scan.measure('resolveParents', () => resolveParentRequests(context));
    await scan.measureAsync('reconnect', () => reconnectSources(context));
    check();
    const aggregated = await scan.measureAsync('aggregate', () => collectWinners(context, names));
    phase = 'committing';
    report(true);
    check();
    await scan.measureAsync('commitComponents', () => commitComponents(context, aggregated));
    scan.measure('finishScan', () => finishScan(context, names));
    scan.measure('optimize', () => database.optimize());
  } catch (error) {
    result.interrupted = true;
    result.error = cancelled() ? 'interrupted' : error instanceof SummaryError ? error.code : 'source-discovery-error';
    if (!cancelled()) result.failed++;
    for (const file of state.files.values())
      if (!file.settled && (file.changed || file.prepared) && !file.removed) {
        file.error = new SummaryError(result.error);
        recordFailure(context, file);
      }
  } finally {
    await scan.measureAsync('sourcePoolClose', () => sourcePool.dispose());
    release?.();
    result.completedAt = new Date().toISOString();
    phase = 'complete';
    report(true);
    result.timings!.totalMs = performance.now() - started;
  }
  return result;
}
