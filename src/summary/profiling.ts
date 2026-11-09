// 갱신과 SQL 저장 단계의 단조 시계 경과 시간·호출 횟수만 모은다.
import { performance } from 'node:perf_hooks';

export type ScanStage = 'lock' | 'discover' | 'names' | 'parseChanged' | 'expandRelated'
  | 'resolveParents' | 'reconnect' | 'aggregate' | 'commitComponents' | 'finishScan' | 'optimize' | 'readSources';
export type StorageStage = 'replace' | 'begin' | 'commit' | 'rollback' | 'prepare' | 'manifest'
  | 'indexSummaries' | 'deleteMissing' | 'summaries' | 'summaryCompare' | 'summaryWrites'
  | 'reconnectDiagnostics' | 'removeSources' | 'rollups' | 'pruneNames'
  | 'rollupRequestDelete' | 'rollupRequestInsert' | 'rollupModelDelete' | 'rollupModelInsert'
  | 'facts' | 'models' | 'capabilities' | 'costs';

export interface TimingMeasurement { calls: number; totalMs: number }
export type StageTimings<Stage extends string> = Partial<Record<Stage, TimingMeasurement>>;
export interface RefreshTimings {
  totalMs: number;
  scan: StageTimings<ScanStage>;
  storage: StageTimings<StorageStage>;
}

/** 고정된 단계 키에 성공·실패를 포함한 누적 시간을 기록한다. 중첩 단계는 합산하지 않는다. */
export class StageProfiler<Stage extends string> {
  readonly timings: StageTimings<Stage> = {};

  record(stage: Stage, started: number): void {
    const timing = this.timings[stage] ??= { calls: 0, totalMs: 0 };
    timing.calls++;
    timing.totalMs += performance.now() - started;
  }

  measure<T>(stage: Stage, action: () => T): T {
    const started = performance.now();
    try { return action(); }
    finally { this.record(stage, started); }
  }

  async measureAsync<T>(stage: Stage, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { return await action(); }
    finally { this.record(stage, started); }
  }
}
