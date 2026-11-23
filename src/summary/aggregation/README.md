# aggregation

파일을 읽으면서 원본별 winner와 요청 상태를 모은다. 부모 요청 귀속을 정한 뒤, 최종 응답 키가 겹치는 후보를 세션 단위로 비교한다. 영향 세션에서는 확정한 응답을 SQLite의 이전 반영값과 대조해 부모 요청에 더할 차분을 구한다.

- [memoryAggregate.ts](memoryAggregate.ts) — `StreamingAggregation`: 원본별 후보를 비교해 확정된 응답과 요청·모델·진단을 만든다.
- [appliedUsage.ts](appliedUsage.ts) — 응답별 이전 반영값과 이번 사용량의 차분을 부모 요청에 더한다. 이전 응답이 사라지거나 귀속이 바뀐 세션에는 원본에서 계산한 집계를 사용한다.
- [sourceEvidence.ts](sourceEvidence.ts) — `SourceEvidence`: 같은 읽기에서 진단·포맷·복사 접두사·request 보정의 작은 근거를 수집하고 남은 winner의 귀속·유효성을 판정한다.
- [sourceWinners.ts](sourceWinners.ts) — `SourceWinners`: 파싱 중 usage winner를 줄이고, 남은 후보 배열과 요청별 상태를 Worker snapshot으로 전달한다.
- [parentGroups.ts](parentGroups.ts) — `groupParents`: 최상위 부모를 한 번 해소해 같은 root별로 직접 그룹화하고 불명확한 계보는 독립적으로 남긴다.
- [winners.ts](winners.ts) — input+output 점수와 동점의 원본 순서를 비교한다.
- [turns.ts](turns.ts) — 요청 수명주기 상태를 합치고 세션 이름·진단을 색인해 최종 요청·모델·도구 행을 만든다.
