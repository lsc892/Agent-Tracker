// 갱신 단계의 실행 순서와 잠금·진행·취소·Worker 종료 수명을 조율한다.
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldToWorker } from 'node:timers/promises';
import { SummaryDatabase } from '../../db';
import { copyRecentUsage, type RecentWindow } from '../../db/recentSnapshot';
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
import { PARSER_VERSION, ScanState, sessionKey } from './state';

export { PARSER_VERSION } from './state';

// NTFS write timestamps can lag Date.now() by a few milliseconds.
const WINDOWS_MTIME_OVERLAP_MS = 8;
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
  const scope = refreshScope(roots, collect, options.maxLineBytes);
  const context: RefreshContext = { database, result, scan, storage, state, sourcePool,
    roots, collect, retain, cancelled, check, report: publish, onBytes };

  let release: (() => void) | undefined;
  try {
    check();
    release = await scan.measureAsync('lock', () => acquireRefreshLock(options.dbPath, signal, cancelled));
    await scanUnderLock(context, scope, publish, preview);
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

async function scanUnderLock(context: RefreshContext, scope: string, publish: PublishProgress, preview?: RecentPreview): Promise<void> {
  const { database, scan, roots, check, cancelled } = context;
  const startedMs = Date.now();
  const cutoff = readRefreshCutoff(database, scope, startedMs);
  publish('scanning');
  await scan.measureAsync('discover', () => discoverSources(context, cutoff));
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
  scan.measure('finishScan', () => finishScan(context, names, scope, startedMs));
  scan.measure('optimize', () => database.optimize());
}

async function prepareRecentPreview(
  context: RefreshContext, names: Map<string, string>, preview: RecentPreview,
): Promise<void> {
  const database = new SummaryDatabase(':memory:');
  const result = { ...context.result };
  const state = new ScanState(result);
  const recent = { ...context, database, state, result, report: () => {} };
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
  await scan.measureAsync('reconnect', () => reconnectSources(context));
  check();
  const aggregated = scan.measure('aggregate', () => collectWinners(context, names));

  committing?.();
  check();
  await scan.measureAsync('commitComponents', () => commitComponents(context, aggregated));
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
