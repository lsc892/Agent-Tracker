# memoryStore

메모리 집계 snapshot을 기존 SQLite 행과 비교해 달라진 영속 행만 원자적으로 저장한다.

- [공개 진입점](../memoryStore.ts) — 기존 소스·컴파일 출력 경로에서 폴더 구현을 명시적으로 다시 공개한다.
- [index.ts](index.ts) — `MemoryStore`: 입력 준비·원본·요청·이름·비용·rollup을 같은 트랜잭션에서 반영한다.
- [types.ts](types.ts) — `MemoryReplacement`·`SavedSessionNames`: snapshot 입력과 확정한 세션 이름 결과의 계약을 정의한다.
- [values.ts](values.ts) — 요청·모델·Skill을 검증하고 SQL 값 배열과 비교 순서로 변환한다.

`index.ts`가 `types.ts`와 `values.ts`를 사용한다. 값 변환은 DB·트랜잭션·프로파일에 접근하지 않으며, 새 모듈은 index를 역참조하지 않는다.

입력 준비·묶음 반영처럼 의미가 큰 단계는 메소드로 유지한다. 각 단계의 검증·조회·갱신은 같은 메소드에서 이어서 읽도록 묶고, 단건 처리나 SQL 한 문장만 보려고 보조 메소드를 계속 따라가지 않게 한다.
