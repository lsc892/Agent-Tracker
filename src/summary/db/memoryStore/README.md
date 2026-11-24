# memoryStore

영향 세션의 메모리 집계 값을 받아 SQLite에서 일별 합계를 교체한다. 일별 합계와 파일 상태·수정 시각·이름을 한 쓰기 트랜잭션에서 확정한다.

- [공개 진입점](../memoryStore.ts) — 기존 소스·컴파일 출력 경로에서 폴더 구현을 명시적으로 다시 공개한다.
- [index.ts](index.ts) — `MemoryStore`는 입력 범위를 확인하고 파일 상태와 이름을 반영한 뒤 일별 집계를 교체한다.
- [types.ts](types.ts) — `MemoryReplacement`·`SavedSessionNames`: snapshot 입력과 확정한 세션 이름 결과의 계약을 정의한다.
- [values.ts](values.ts) — 토큰 합계와 모델 비용 입력을 검증한다.

일별 SQL에 넘길 값을 준비하는 [dailyFacts.ts](../dailyFacts.ts)가 `values.ts`를 사용한다.

입력 준비·묶음 반영처럼 의미가 큰 단계는 메소드로 유지한다. 각 단계의 검증·조회·갱신은 같은 메소드에서 이어서 읽도록 묶고, 단건 처리나 SQL 한 문장만 보려고 보조 메소드를 계속 따라가지 않게 한다.
