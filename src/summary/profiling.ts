// 갱신과 SQL 저장 단계의 단조 시계 경과 시간·호출 횟수만 모은다.
import { performance } from 'node:perf_hooks';

export type ScanStage = 'lock' | 'discover' | 'names' | 'parseChanged' | 'expandRelated'
  | 'resolveParents' | 'aggregate' | 'commitComponents' | 'finishScan' | 'optimize' | 'readSources' | 'sourcePoolClose';
export type StorageStage = 'replace' | 'begin' | 'commit' | 'rollback' | 'prepare' | 'source_file'
  | 'indexSummaries' | 'deleteMissing' | 'metadata' | 'summaries' | 'summaryCompare' | 'summaryWrites'
  | 'removeSources' | 'rollups' | 'pruneNames'
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
    // [측정 정책] 단계별 호출 횟수와 단조 시계 경과 시간을 독립적으로 누적한다.
    const timing = this.timings[stage] ??= { calls: 0, totalMs: 0 };
    timing.calls++;
    timing.totalMs += performance.now() - started;
  }

  measure<T>(stage: Stage, action: () => T): T {
    // [측정 정책] 작업 성공 여부와 무관하게 종료 시점의 경과 시간을 기록한다.
    const started = performance.now();
    try { return action(); }
    finally { this.record(stage, started); }
  }

  async measureAsync<T>(stage: Stage, action: () => Promise<T>): Promise<T> {
    // [측정 정책] Promise가 정착할 때까지 기다려 비동기 대기 시간도 포함한다.
    const started = performance.now();
    try { return await action(); }
    finally { this.record(stage, started); }
  }
}
