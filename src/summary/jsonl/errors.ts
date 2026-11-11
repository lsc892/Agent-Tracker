// JSONL 처리에서 공유하는 오류 코드와 원본 바이트 위치를 정의한다.
/** 통계 처리 오류의 코드와 원본 바이트 위치를 전달한다. */
export class SummaryError extends Error {
  constructor(public readonly code: string, public readonly offset = 0) { super(code); }
}
