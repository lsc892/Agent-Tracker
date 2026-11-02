# db

대화 사용량 통계를 SQLite에 저장하고 조건별 조회와 일별 사전 집계를 제공한다.

- [billing.ts](billing.ts) — `SessionBillingStore`: 세션 결제 분류와 요청별 비용을 저장·재계산한다.
- [chart.ts](chart.ts) — 선택한 표 페이지를 같은 항목·순서의 도표 데이터로 변환한다.
- [connection.ts](connection.ts) — `SqliteSession`: SQLite 연결·쿼리 캐시·트랜잭션·유지보수를 관리한다.
- [index.ts](index.ts) — `SummaryDatabase`: 공유 연결의 저장소들을 구성하고 통계 DB API를 제공한다.
- [manifest.ts](manifest.ts) — `ManifestStore`: 원본 파일의 식별·관측·진단과 파일 목록 조회를 관리한다.
- [migrations.ts](migrations.ts) — 기존 통계와 식별자를 보존하며 DB 스키마를 갱신한다.
- [queries.ts](queries.ts) — 원본 조회의 공개 SQL 함수와 타입을 재노출한다.
- [queries/](queries/README.md) — 공통 정책·원본 조회·롤업 조회를 책임별 폴더와 파일로 나눈다.
- [reader.ts](reader.ts) — `SummaryReader`: 조건에 맞는 원본·사전 집계 SQL로 통계 페이지를 조회한다.
- [rollup-queries.ts](rollup-queries.ts) — 롤업 조회·원본 일별 집계의 공개 SQL 함수를 재노출한다.
- [rollup-state.ts](rollup-state.ts) — 일별 사전 집계의 병합 지표·테이블·형식 버전을 정의한다.
- [rollups.ts](rollups.ts) — `UsageRollupStore`: 일별 사전 집계를 구축하고 교체 대상 세션 전체를 재집계한다.
- [schema.ts](schema.ts) — 테이블·인덱스·버전과 기존 스키마 변환 SQL을 정의한다.
- [sessionChanges.ts](sessionChanges.ts) — `SessionChanges`: 큰 세션의 TEMP 집합 비교와 변경 비율에 따른 부분·일괄 반영을 맡는다.
- [sessions.ts](sessions.ts) — `SessionStore`: 세션 입력·원본 보존·저장 경로를 조정하고 요청·종속 통계를 원자적으로 반영한다.
- [timezone.ts](timezone.ts) — 지정 시간대의 일·월 집계 키와 UTC 기간 경계를 계산한다.
- [types.ts](types.ts) — DB 저장 입력·조회 필터·페이지·집계·진단 타입을 정의한다.
- [validation.ts](validation.ts) — 페이지 상한과 비음수 정수를 검증한다.
