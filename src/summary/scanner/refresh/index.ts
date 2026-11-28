// 갱신 단계의 실행 순서와 잠금·진행·취소·Worker 종료 수명을 조율한다.
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import type { SummaryDatabase } from '../../db';
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
import { expandRelatedSources, resolveClaudeParentRequests, resolveParentRequests } from './relations';
import { collectWinners } from './aggregation';
import { ScanState } from './state';

export { PARSER_VERSION } from './state';

const PROGRESS_INTERVAL_MS = 100;
type PublishProgress = (phase?: SummaryProgress['phase']) => void;

/** 사용량 갱신을 실행하고 잠금·Worker를 정리한 뒤 갱신 결과를 반환한다. */
export async function refreshSummary(
  database: SummaryDatabase, options: SummaryOptions, signal?: AbortSignal,
  progress?: (value: SummaryProgress) => void,
): Promise<RefreshResult> {
  // [진행 정책] 이번 갱신의 계수·타이머를 초기화하고 로컬·공유 신호 중 어느 하나로도 취소한다.
  const started = performance.now();
  const scan = new StageProfiler<ScanStage>();
  const storage = new StageProfiler<StorageStage>();
  const timings = { totalMs: 0, scan: scan.timings, storage: storage.timings };
  const result: RefreshResult = { discovered: 0, parsed: 0, reused: 0, failed: 0,
    bodyBytes: 0, interrupted: false, completedAt: '', timings };
  const publish = progressReporter(result, progress);
  // 원본에서 읽은 바이트를 누적해 진행 보고에 반영한다.
  const onBytes = (bytes: number): void => {
    result.bodyBytes += bytes;
    publish();
  };
  const cancellation = options.cancellation ? new Int32Array(options.cancellation) : undefined;
  // 중단 신호와 Worker가 공유하는 취소 플래그를 함께 확인한다.
  const cancelled = (): boolean => Boolean(signal?.aborted || cancellation && Atomics.load(cancellation, 0));
  // 단계 중간에 취소가 확인되면 중단 오류로 갱신 흐름을 빠져나간다.
  const check = (): void => {
    if (cancelled()) throw new SummaryError('interrupted');
  };
  const retain = options.retainDeletedSourceUsage !== false;
  const collect = options.collectCapabilities !== false;
  const sourcePool = new SourceReaderPool({ workers: options.sourceWorkers,
    maxLineBytes: options.maxLineBytes, collectCapabilities: collect,
    signal, cancelled, externalCancellation: options.cancellation, onBytes });
  const state = new ScanState(result);
  const roots = options.roots.map(root => ({ ...root, path: resolve(root.path) }));
  const context: RefreshContext = { database, result, scan, storage, state, sourcePool,
    roots, retain, collect, cancelled, check, report: publish };

  // [SQL 트랜잭션 정책] 갱신 전체의 창 간 잠금을 확보한 뒤 스캔하고 중단은 원본 진단에 남긴다.
  let release: (() => void) | undefined;
  try {
    check();
    release = await scan.measureAsync('lock', () => acquireRefreshLock(options.dbPath, signal, cancelled));
    await scanUnderLock(context, publish, options.timezone ?? 'UTC');
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

/** 잠금을 보유하는 동안 탐색, 파싱, 관계 확인, 집계, 저장을 순서대로 실행한다. */
async function scanUnderLock(context: RefreshContext, publish: PublishProgress, timezone: string): Promise<void> {
  const { database, scan, state, roots, check, cancelled } = context;

  // [탐색 정책] 저장 시간대를 먼저 맞춘 뒤 원본 변경과 세션 이름을 조사한다.
  publish('scanning');
  database.setDailyTimezone(timezone);
  await scan.measureAsync('discover', () => discoverSources(context));
  check();
  const names = await scan.measureAsync('names', () => readNames(roots, cancelled));

  // [파싱 정책] 변경 파일과 관련 원본을 읽고 Claude·Codex 자식 로그를 부모 요청에 연결한다.
  publish('parsing');
  await scan.measureAsync('parseChanged', () => prepareChanged(context));
  await scan.measureAsync('expandRelated', () => expandRelatedSources(context));
  scan.measure('resolveParents', () => {
    resolveParentRequests(context);
    resolveClaudeParentRequests(state);
  });
  check();

  // 사용량을 집계한 뒤 메인 대화 근거가 있는 요약만 저장 대상으로 삼는다.
  const summaries = scan.measure('aggregate', () => collectWinners(context, names).summaries);

  // [저장 정책] 연결된 세션을 확정하고 남은 원본 상태와 이름을 저장한다.
  publish('committing');
  check();
  await scan.measureAsync('commitComponents', () => commitComponents(context, summaries));
  check();
  scan.measure('finishScan', () => finishScan(context, names));
  scan.measure('optimize', () => database.optimize());
}

/** 현재 단계와 누적 처리량을 전달하는 진행 보고 함수를 만든다. */
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

/** 갱신이 끝까지 진행되지 못한 이유를 결과와 원본 진단에 남긴다. */
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
