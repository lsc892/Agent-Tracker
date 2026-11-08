# aggregation

원본 DTO를 조회용 최종 요청 snapshot으로 집계한다. 파일 읽기와 DB 저장은 호출자가 맡는다.

- [memoryAggregate.ts](memoryAggregate.ts) — 파일별 DTO의 계보·legacy/current·복사 접두사·응답 winner를 확인해 요청·모델·도구의 최종 메모리 집계를 만든다.
