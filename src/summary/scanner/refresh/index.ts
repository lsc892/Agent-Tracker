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
import type { RefreshContext } from './context';
import { discoverSources } from './discovery';
import { commitComponents, finishScan, recordFailure } from './persistence';
import { prepareChanged } from './preparation';
import { expandRelatedSources } from './relations';
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
  // [진행 정책] 이번 갱신의 계수·타이머를 초기화하고 로컬·공유 신호 중 어느 하나로도 취소한다.
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
  const retain = options.retainDeletedSourceUsage !== false;
  const sourcePool = new SourceReaderPool({ workers: options.sourceWorkers,
    maxLineBytes: options.maxLineBytes, signal, cancelled, externalCancellation: options.cancellation, onBytes });
  const state = new ScanState(result);
  const roots = options.roots.map(root => ({ ...root, path: resolve(root.path) }));
  const context: RefreshContext = { database, result, scan, storage, state, sourcePool,
    roots, retain, cancelled, check, report: publish };

  // [SQL 트랜잭션 정책] 갱신 전체의 창 간 잠금을 확보한 뒤 스캔하고 중단은 원본 진단에 남긴다.
  let release: (() => void) | undefined;
  try {
    check();
    release = await scan.measureAsync('lock', () => acquireRefreshLock(options.dbPath, signal, cancelled));
    await scanUnderLock(context, publish, options.timezone ?? 'UTC', preview);
  } catch (error) {
    recordInterruptedScan(context, error);
  } finally {
    // [종료 정책] Worker가 남긴 작업을 정리한 뒤 잠금을 풀고 완료를 알린다.
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

async function scanUnderLock(context: RefreshContext, publish: PublishProgress, timezone: string, preview?: RecentPreview): Promise<void> {
  const { database, scan, roots, check, cancelled } = context;

  // [탐색 정책] 저장 시간대를 먼저 맞춘 뒤 원본 변경과 세션 이름을 조사한다.
  publish('scanning');
  database.setDailyTimezone(timezone);
  await scan.measureAsync('discover', () => discoverSources(context));
  check();
  const names = await scan.measureAsync('names', () => readNames(roots, cancelled));

  // [미리보기 정책] 요청이 있을 때만 메모리 DB에서 최근 사용량을 먼저 계산해 전달한다.
  publish('parsing');
  if (preview) {
    await prepareRecentPreview(context, names, preview, timezone).catch(() => { check(); });
    publish('parsing');
    await yieldToWorker();
  }

  // [저장 정책] 전체 변경을 반영한 뒤 별도로 남은 원본 상태와 이름을 저장한다.
  await prepareAndCommit(context, names, () => publish('committing'));
  check();
  scan.measure('finishScan', () => finishScan(context, names));
  scan.measure('optimize', () => database.optimize());
}

async function prepareRecentPreview(
  context: RefreshContext, names: Map<string, string>, preview: RecentPreview, timezone: string,
): Promise<void> {
  const database = new SummaryDatabase({ databasePath: ':memory:', timezone });
  const result = { ...context.result };
  const state = new ScanState(result);
  const recent = { ...context, database, state, result, report: () => {} };
  context.sourcePool.capturePreparations(true);
  try {
    // [미리보기 정책] 기존 최근 사용량을 복사해 변경분을 계산할 기준을 만든다.
    copyRecentUsage(context.database.connection, database, preview, timezone);
    // [미리보기 정책] 변경 파일 중 최근 저장 세션에 속하거나 조회 시작 이후 수정된 원본을 고른다.
    const sessions = new Set(Array.from(database.connection.prepare('SELECT DISTINCT provider, session_id FROM usage_request_daily').iterate(),
      row => sessionKey(row.provider as 'claude' | 'codex', row.session_id as string)));
    for (const file of context.state.files.values()) {
      const inRecentSession = file.session_id !== null && sessions.has(sessionKey(file.provider, file.session_id));
      const changed = file.changed && (inRecentSession || !file.removed && file.mtime_ms >= preview.fromMs);
      state.trackFile({ ...file, changed });
      if (!changed) continue;
      state.indexRelatedSources();
      if (file.removed) state.affect(file.provider, file.session_id);
    }

    // [미리보기 정책] 임시 DB에 변경을 반영하고 실패가 없을 때만 결과를 전달한다.
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
  const { scan, check, state } = context;
  // [파싱 정책] 변경된 원본을 다시 읽어 파일별 응답 winner와 누계 근거를 수집한다.
  await scan.measureAsync('parseChanged', () => prepareChanged(context));

  // [Winner 정책] 같은 세션의 원본도 병합하고, 필요한 Codex 부모 원본을 찾아 복사 이력을 확인할 근거를 모은다.
  await scan.measureAsync('expandRelated', () => expandRelatedSources(context));
  check();

  // [DTO 정책] 확정된 winner와 검증된 누계를 반영해 변경 세션의 스레드별 저장 요약을 만든다.
  const summaries = scan.measure('aggregate', () => state.aggregation.summarize(state.affected, names, check));

  // [SQL 트랜잭션 정책] 연결된 세션의 요약과 원본 상태를 같은 쓰기 단위로 반영한다.
  committing?.();
  check();
  await scan.measureAsync('commitComponents', () => commitComponents(context, summaries));
}

function progressReporter(result: RefreshResult, progress?: (value: SummaryProgress) => void): PublishProgress {
  // [진행 정책] 단계 전환은 즉시 알리고 같은 단계의 보고는 100ms 간격으로 제한한다.
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
  // [진단 정책] 취소와 실패를 구분하고 반영되지 않은 변경·준비 원본만 중단 상태로 기록한다.
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
