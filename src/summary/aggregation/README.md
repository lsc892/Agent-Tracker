# aggregation

현재 스레드 수집에서는 응답 후보의 점수 계산과 Codex 누계 검산을 맡는다. 파일 내부 선택은 [ThreadLogParser](../parsers/threadUsage.ts), 파일 간 병합은 [ThreadAggregation](../scanner/refresh/aggregation.ts)이 수행한다. 아래에는 이전 요청 집계의 검증·비교 코드도 포함한다.

- [memoryAggregate.ts](memoryAggregate.ts) — `StreamingAggregation`: 세션별로 파일 winner를 병합해 요청·모델·진단을 만든다.
- [threadAccounting.ts](threadAccounting.ts) — 확정한 응답을 스레드·모델별로 합산하고 Codex 부모 복사본과 누계 차이를 검산한다.
- [sourceEvidence.ts](sourceEvidence.ts) — `SourceEvidence`: 같은 읽기에서 진단·포맷·복사 접두사·request 보정의 근거를 수집하고 응답 후보의 유효성을 판정한다.
- [sourceWinners.ts](sourceWinners.ts) — `SourceWinners`: 파일 파싱 중 응답 winner와 요청·누계·도구 상태를 갱신하고 Worker snapshot으로 전달한다.
- [parentGroups.ts](parentGroups.ts) — `groupParents`: 최상위 부모를 한 번 해소해 같은 root별로 직접 그룹화하고 불명확한 계보는 독립적으로 남긴다.
- [winners.ts](winners.ts) — input+output 점수와 동점의 원본 순서를 비교한다.
- [turns.ts](turns.ts) — 요청 수명주기 상태를 합치고 세션 이름·진단을 색인해 최종 요청·모델·도구 행을 만든다.

## 관련 문서

- [winner 정책](../../../docs/refrences/WinnerPolicy.md) — 응답 비교 키와 동점 처리, Codex 누계 검산.
