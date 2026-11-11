# aggregation

파일을 한 번 읽으며 원본별 그룹 winner와 요청 상태·최신 check·도구 중복을 함께 누적한다. raw metadata 이벤트 재생·합친 정렬을 만들지 않고 관계 확정 뒤 남은 상태·winner만 병합한다. 교체 전·후 숫자 기여는 즉시 차감·가산하며 패자 진단·root 근거를 보존한다. 파일 읽기와 최종 DB transaction은 호출자가 맡는다.

- [memoryAggregate.ts](memoryAggregate.ts) — `StreamingAggregation`: 원본별 남은 winner를 부모 요청 DTO에 즉시 반영하고 요청·모델·진단을 확정한다.
- [sourceEvidence.ts](sourceEvidence.ts) — `SourceEvidence`: 같은 읽기에서 진단·포맷·복사 접두사·request 보정의 작은 근거를 수집하고 남은 winner의 귀속·유효성을 판정한다.
- [sourceWinners.ts](sourceWinners.ts) — `SourceWinners`: 파싱 중 usage winner와 요청별 turn·check·도구·최소 위치 상태를 누적해 Worker snapshot으로 전달한다.
- [parentGroups.ts](parentGroups.ts) — `groupParents`: 최상위 부모를 한 번 해소해 같은 root별로 직접 그룹화하고 불명확한 계보는 독립적으로 남긴다.
- [winners.ts](winners.ts) — `Winners`: 그룹마다 한 DTO를 유지하며 input+output 최대값과 동점의 원본 순서로 갱신하고 교체 전·후 기여를 알린다.
- [turns.ts](turns.ts) — 요청 수명주기 상태를 합치고 세션 이름·진단을 색인해 최종 요청·모델·도구 행을 만든다.
