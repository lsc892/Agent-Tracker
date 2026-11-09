# aggregation

파일을 한 번 읽으며 원본별 그룹 winner DTO를 갱신하고 패자 벡터를 버린다. 남은 winner를 부모 요청 그룹에 전달하며 교체 전·후의 기여를 즉시 차감·가산한다. 자식의 독립 요청 행과 종료 시 winner 전체 재합산은 만들지 않는다. 패자 모델을 별도 행으로 복원하지 않는다. 파일 읽기와 DB 저장은 호출자가 맡는다.

- [memoryAggregate.ts](memoryAggregate.ts) — `StreamingAggregation`: 원본별 남은 winner를 부모 요청 DTO에 즉시 반영하고 요청·모델·진단을 확정한다.
- [sourceEvidence.ts](sourceEvidence.ts) — `SourceEvidence`: 같은 읽기에서 진단·포맷·복사 접두사·request 보정의 작은 근거를 수집하고 남은 winner의 귀속·유효성을 판정한다.
- [sourceWinners.ts](sourceWinners.ts) — `SourceWinners`: 파싱 중 동일 그룹의 더 좋은 후보로 같은 DTO를 갱신하고 패자 숫자 벡터를 즉시 버린다.
- [parentGroups.ts](parentGroups.ts) — `groupParents`: 직접 자식은 부모 그룹으로 모으고 다단계 계보는 Union-Find·Small-to-Large로 연결하며 불명확한 계보는 독립적으로 남긴다.
- [winners.ts](winners.ts) — `Winners`: 그룹마다 한 DTO를 유지하며 input+output 최대값과 동점의 원본 순서로 갱신하고 교체 전·후 기여를 알린다.
- [turns.ts](turns.ts) — 요청 수명주기와 최종 winner를 요청·모델·도구·진단 결과로 만든다.
