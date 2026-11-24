# db

대화 사용량 통계를 SQLite에 저장하고 조건별 조회와 일별 사전 집계를 제공한다.

- [billing.ts](billing.ts) — `SessionBillingStore`: 일별 비용 조회에 적용하는 세션 결제 분류를 저장한다.
- [chart.ts](chart.ts) — 선택한 표 페이지를 같은 항목·순서의 도표 데이터로 변환한다.
- [connection.ts](connection.ts) — `SqliteSession`: SQLite 연결·쿼리 캐시·트랜잭션·유지보수를 관리한다.
- [index.ts](index.ts) — `SummaryDatabase`: 공유 연결의 저장소들을 구성하고 통계 DB API를 제공한다.
- [sourceFiles.ts](sourceFiles.ts) — `SourceFileStore`는 원본 출처·소실 보존·진단 조회를 관리한다. 갱신은 파일시스템 수정 시각과 경로별로 저장한 `source_file.mtime_ms`를 비교한다.
- [appliedResponses.ts](appliedResponses.ts) — 이전 응답 집계 참조와 호환되는 타입을 정의한다.
- [dailyFacts.ts](dailyFacts.ts) — 메모리의 스레드·모델 합계를 일별 SQL 입력으로 변환한다.
- [memoryStore.ts](memoryStore.ts) — `MemoryStore`와 저장 입력·결과 타입의 기존 공개 경로를 유지한다.
- [memoryStore/](memoryStore/README.md) — 메모리 집계의 영속 반영·SQL 값 검증/변환·입출력 타입을 나눠 관리한다.
- [migrations.ts](migrations.ts) — 이전 상세 행을 일별로 이관하고 현재 스키마를 연다.
- [queries.ts](queries.ts) — 기존 SQL 검증과 일별 조회의 함수·타입을 재노출한다.
- [queries/](queries/README.md) — 일별 경로의 SQL, 공통 필터와 이전 형식 참조를 나눈다.
- [reader.ts](reader.ts) — `SummaryReader`: 일별 결과와 원본 상태에서 통계·진단을 읽는다.
- [rollup-queries.ts](rollup-queries.ts) — 롤업 조회·원본 일별 집계의 공개 SQL 함수를 재노출한다.
- [rollup-state.ts](rollup-state.ts) — 일별 합계의 병합 지표·테이블·형식 버전을 정의한다.
- [rollups.ts](rollups.ts) — `UsageRollupStore`: 메모리 집계의 날짜별 합계를 계산해 변경 세션의 행을 교체한다.
- [schema.ts](schema.ts) — 테이블·인덱스·버전과 기존 스키마 변환 SQL을 정의한다.
- [timezone.ts](timezone.ts) — 지정 시간대의 일·월 집계 키와 UTC 기간 경계를 계산한다.
- [types.ts](types.ts) — DB 저장 입력·조회 필터·페이지·집계·진단 타입을 정의한다.
- [validation.ts](validation.ts) — 페이지 상한과 비음수 정수를 검증한다.
