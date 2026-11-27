// 메모리 집계 snapshot의 저장 입력과 확정한 세션 이름의 결과 타입을 정의한다.
import type { FileMetadata, SessionRef, TurnSummaryInput } from '../types';
import type { AppliedResponse } from '../appliedResponses';

export interface MemoryReplacement {
  sessions: Iterable<SessionRef>;
  summaries: Iterable<TurnSummaryInput>;
  files: readonly (FileMetadata & { id: number })[];
  removedFileIds?: Iterable<number>;
  retainDeletedSourceUsage?: boolean;
  /** @deprecated Response records are no longer persisted. */
  appliedResponses?: readonly AppliedResponse[];
  /** Preserve saved Skill rows during refreshes with collection disabled. */
  preserveCapabilities?: boolean;
}

/** COMMIT한 이름만 스캔 마무리의 중복 이름 갱신 생략에 사용한다. */
export type SavedSessionNames = ReadonlyMap<string, string>;
