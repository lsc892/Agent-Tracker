# aggregation

파일별 응답 후보를 비교하고, 확정된 모델과 토큰을 부모 대화에 반영한다. [스캔 집계 진입점](../scanner/refresh/aggregation.ts)

- [memoryAggregate.ts](memoryAggregate.ts) — `StreamingAggregation`: 세션별로 파일 winner를 병합해 요청·모델·진단을 만든다.
- [threadAccounting.ts](threadAccounting.ts) — 이전 스레드별 집계의 토큰 합산과 Codex 누계 검산을 구현한다.
- [sourceEvidence.ts](sourceEvidence.ts) — `SourceEvidence`: 같은 읽기에서 진단·포맷·복사 접두사·request 보정의 근거를 수집하고 응답 후보의 유효성을 판정한다.
- [sourceWinners.ts](sourceWinners.ts) — `SourceWinners`: 파일 파싱 중 응답 winner와 요청·누계·도구 상태를 갱신하고 Worker snapshot으로 전달한다.
- [parentGroups.ts](parentGroups.ts) — `groupParents`: 최상위 부모를 한 번 해소해 같은 root별로 직접 그룹화하고 불명확한 계보는 독립적으로 남긴다.
- [winners.ts](winners.ts) — input+output 점수와 동점의 원본 순서를 비교한다.
- [turns.ts](turns.ts) — 요청 수명주기 상태를 합치고 세션 이름·진단을 색인해 최종 요청·모델·도구 행을 만든다.

## 관련 문서

- [winner 정책](../../../docs/refrences/WinnerPolicy.md) — 응답 비교 키와 동점 처리, Codex 누계 검산.
