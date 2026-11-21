// 갱신 단계의 실행 순서와 잠금·진행·취소·Worker 종료 수명을 조율한다.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SummaryDatabase } from '../../db';
import { SummaryError } from '../../jsonl';
import { StageProfiler, type ScanStage, type StorageStage } from '../../profiling';
import type { RefreshResult, SourceRoot, SummaryOptions, SummaryProgress } from '../../types';
import { acquireRefreshLock } from '../lock';
import { readNames } from '../names';
import { SourceReaderPool } from '../sourcePool';
import { collectWinners } from './aggregation';
import type { RefreshContext } from './context';
import { discoverSources } from './discovery';
import { commitComponents, finishScan, recordFailure } from './persistence';
import { prepareChanged } from './preparation';
import { expandRelatedSources, reconnectSources, resolveParentRequests } from './relations';
import { PARSER_VERSION, ScanState } from './state';

export { PARSER_VERSION } from './state';

// NTFS write timestamps can lag Date.now() by a few milliseconds.
const WINDOWS_MTIME_OVERLAP_MS = 8;
const PROGRESS_INTERVAL_MS = 100;
type PublishProgress = (phase?: SummaryProgress['phase']) => void;

/** 갱신 잠금과 파일 Worker의 수명을 관리한다. */
export async function refreshSummary(
  database: SummaryDatabase, options: SummaryOptions, signal?: AbortSignal,
  progress?: (value: SummaryProgress) => void,
): Promise<RefreshResult> {
  const started = performance.now();
  const scan = new StageProfiler<ScanStage>();
  const storage = new StageProfiler<StorageStage>();
  const timings = { totalMs: 0, scan: scan.timings, storage: storage.timings };
  const result: RefreshResult = { discovered: 0, parsed: 0, reused: 0, failed: 0,
    bodyBytes: 0, interrupted: false, completedAt: '', timings };
  const publish = progressReporter(result, progress);
  const onBytes = (bytes: number): void => {
    result.bodyBytes += bytes;
    publish();
  };
  const cancellation = options.cancellation ? new Int32Array(options.cancellation) : undefined;
  const cancelled = (): boolean => Boolean(signal?.aborted || cancellation && Atomics.load(cancellation, 0));
  const check = (): void => {
    if (cancelled()) throw new SummaryError('interrupted');
  };
  const collect = options.collectCapabilities !== false, retain = options.retainDeletedSourceUsage !== false;
  const sourcePool = new SourceReaderPool({ workers: options.sourceWorkers, collectCapabilities: collect,
    maxLineBytes: options.maxLineBytes, signal, cancelled, externalCancellation: options.cancellation, onBytes });
  const state = new ScanState(result);
  const roots = options.roots.map(root => ({ ...root, path: resolve(root.path) }));
  const scope = refreshScope(roots, collect, options.maxLineBytes);
  const context: RefreshContext = { database, result, scan, storage, state, sourcePool,
    roots, collect, retain, cancelled, check, report: publish, onBytes };

  let release: (() => void) | undefined;
  try {
    check();
    release = await scan.measureAsync('lock', () => acquireRefreshLock(options.dbPath, signal, cancelled));
    await scanUnderLock(context, scope, publish);
  } catch (error) {
    recordInterruptedScan(context, error);
  } finally {
    await scan.measureAsync('sourcePoolClose', () => sourcePool.dispose());
    release?.();
    result.completedAt = new Date().toISOString();
    publish('complete');
    timings.totalMs = performance.now() - started;
  }
  return result;
}

async function scanUnderLock(context: RefreshContext, scope: string, publish: PublishProgress): Promise<void> {
  const { database, scan, roots, check, cancelled } = context;
  const startedMs = Date.now();
  const cutoff = readRefreshCutoff(database, scope, startedMs);
  publish('scanning');
  await scan.measureAsync('discover', () => discoverSources(context, cutoff));
  check();
  const names = await scan.measureAsync('names', () => readNames(roots, cancelled));

  publish('parsing');
  await scan.measureAsync('parseChanged', () => prepareChanged(context));
  await scan.measureAsync('expandRelated', () => expandRelatedSources(context));
  scan.measure('resolveParents', () => resolveParentRequests(context));
  await scan.measureAsync('reconnect', () => reconnectSources(context));
  check();
  const aggregated = scan.measure('aggregate', () => collectWinners(context, names));

  publish('committing');
  check();
  await scan.measureAsync('commitComponents', () => commitComponents(context, aggregated));
  check();
  scan.measure('finishScan', () => finishScan(context, names, scope, startedMs));
  scan.measure('optimize', () => database.optimize());
}

function refreshScope(roots: readonly SourceRoot[], collect: boolean, maxLineBytes: number | undefined): string {
  const rootKeys = roots.map(root => [root.provider, root.path, root.dataHome]);
  return createHash('sha256').update(JSON.stringify([PARSER_VERSION, collect, maxLineBytes, rootKeys])).digest('hex');
}

function readRefreshCutoff(database: SummaryDatabase, scope: string, startedMs: number): number | undefined {
  const previous = database.connection.prepare('SELECT started_ms FROM summary_refresh WHERE id=1 AND scope=? AND started_ms<=?')
    .get(scope, startedMs)?.started_ms;
  if (typeof previous !== 'number') return undefined;
  return process.platform === 'win32' ? previous - WINDOWS_MTIME_OVERLAP_MS : previous;
}

function progressReporter(result: RefreshResult, progress?: (value: SummaryProgress) => void): PublishProgress {
  if (!progress) return () => {};
  let phase: SummaryProgress['phase'] = 'scanning';
  let lastReportMs = 0;
  return nextPhase => {
    if (nextPhase === undefined && Date.now() - lastReportMs <= PROGRESS_INTERVAL_MS) return;
    phase = nextPhase ?? phase;
    const { discovered, parsed, failed, bodyBytes } = result;
    progress({ phase, discovered, parsed, failed, bodyBytes });
    lastReportMs = Date.now();
  };
}

function recordInterruptedScan(context: RefreshContext, error: unknown): void {
  const { cancelled, result, state } = context;
  const wasCancelled = cancelled();
  const errorCode = wasCancelled ? 'interrupted' : error instanceof SummaryError ? error.code : 'source-discovery-error';
  result.interrupted = true;
  result.error = errorCode;
  if (!wasCancelled) result.failed++;
  for (const file of state.files.values()) {
    if (file.settled || file.removed || !file.changed && !file.prepared) continue;
    file.error = new SummaryError(errorCode);
    recordFailure(context, file);
  }
}
