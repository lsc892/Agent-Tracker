// 갱신 단계의 실행 순서와 잠금·진행·취소·Worker 종료 수명을 조율한다.
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import { SummaryDatabase } from '../../db';
import { copyRecentUsage, type RecentWindow } from '../../db/recentSnapshot';
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
import { expandRelatedSources, resolveParentRequests } from './relations';
import { ScanState, sessionKey } from './state';

export { PARSER_VERSION } from './state';

const PROGRESS_INTERVAL_MS = 100;
type PublishProgress = (phase?: SummaryProgress['phase']) => void;

interface RecentPreview extends RecentWindow {
  /** Query the in-memory snapshot synchronously before the complete scan resumes. */
  onReady(database: SummaryDatabase): void;
}

/** 갱신 잠금과 파일 Worker의 수명을 관리한다. */
export async function refreshSummary(
  database: SummaryDatabase, options: SummaryOptions, signal?: AbortSignal,
  progress?: (value: SummaryProgress) => void, preview?: RecentPreview,
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
  const context: RefreshContext = { database, result, scan, storage, state, sourcePool,
    persistAppliedResponses: true,
    roots, collect, retain, cancelled, check, report: publish };

  let release: (() => void) | undefined;
  try {
    check();
    release = await scan.measureAsync('lock', () => acquireRefreshLock(options.dbPath, signal, cancelled));
    await scanUnderLock(context, publish, preview);
  } catch (error) {
    recordInterruptedScan(context, error);
  } finally {
    try {
      await scan.measureAsync('sourcePoolClose', () => sourcePool.dispose());
    } finally {
      release?.();
    }
    result.completedAt = new Date().toISOString();
    publish('complete');
    timings.totalMs = performance.now() - started;
  }
  return result;
}

async function scanUnderLock(context: RefreshContext, publish: PublishProgress, preview?: RecentPreview): Promise<void> {
  const { database, scan, roots, check, cancelled } = context;
  publish('scanning');
  await scan.measureAsync('discover', () => discoverSources(context));
  check();
  const names = await scan.measureAsync('names', () => readNames(roots, cancelled));

  publish('parsing');
  if (preview) {
    await prepareRecentPreview(context, names, preview).catch(() => { check(); });
    publish('parsing');
    await yieldToWorker();
  }
  await prepareAndCommit(context, names, () => publish('committing'));
  check();
  scan.measure('finishScan', () => finishScan(context, names));
  scan.measure('optimize', () => database.optimize());
}

async function prepareRecentPreview(
  context: RefreshContext, names: Map<string, string>, preview: RecentPreview,
): Promise<void> {
  const database = new SummaryDatabase(':memory:');
  const result = { ...context.result };
  const state = new ScanState(result);
  const recent = { ...context, database, state, result, persistAppliedResponses: false, report: () => {} };
  context.sourcePool.capturePreparations(true);
  try {
    copyRecentUsage(context.database.connection, database, preview);
    const sessions = new Set(Array.from(database.connection.prepare('SELECT DISTINCT provider, session_id FROM turn_summary').iterate(),
      row => sessionKey(row.provider as 'claude' | 'codex', row.session_id as string)));
    for (const file of context.state.files.values()) {
      const inRecentSession = file.session_id !== null && sessions.has(sessionKey(file.provider, file.session_id));
      const changed = file.changed && (inRecentSession || !file.removed && file.mtime_ms >= preview.fromMs);
      state.trackFile({ ...file, changed });
      if (!changed) continue;
      state.indexRelatedSources();
      if (file.removed) state.affect(file.provider, file.session_id);
    }
    await prepareAndCommit(recent, names);
    context.check();
    if (!result.failed) preview.onReady(database);
  } finally {
    context.sourcePool.capturePreparations(false);
    database.close();
  }
}

async function prepareAndCommit(
  context: RefreshContext, names: Map<string, string>, committing?: () => void,
): Promise<void> {
  const { scan, check } = context;
  await scan.measureAsync('parseChanged', () => prepareChanged(context));
  await scan.measureAsync('expandRelated', () => expandRelatedSources(context));
  scan.measure('resolveParents', () => resolveParentRequests(context));
  check();
  const aggregated = scan.measure('aggregate', () => collectWinners(context, names));

  committing?.();
  check();
  await scan.measureAsync('commitComponents', () => commitComponents(context, aggregated));
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
  const prepared = new Set(state.preparedFiles);
  for (const file of state.files.values()) {
    if (file.settled || file.removed || !file.changed && !prepared.has(file)) continue;
    file.error = new SummaryError(errorCode);
    recordFailure(context, file);
  }
}
