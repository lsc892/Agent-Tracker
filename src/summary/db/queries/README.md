# queries

현재 통계는 일별 합계에서 읽는다. 각 파일은 쿼리와 바인딩을 함께 만든다.

- [common/](common/README.md): SQL 타입, 제공자·이름·날짜 필터, 표시 기준 정렬을 공유한다.
- [rollup/](rollup/README.md) — 일별 집계 저장과 통계·이름·도구·파일 진단 조회를 구성한다.
- [raw/](raw/README.md) — 이전 DB 이관과 과거 스키마 검증에 쓰는 원본 조회를 구성한다.

기존 호출부는 [queries.ts](../queries.ts)와 [rollup-queries.ts](../rollup-queries.ts)를 사용한다. 두 파일은 공개 함수와 타입을 재노출하고 구현을 담지 않는다. 내부 구현은 필요한 파일을 직접 참조해 공개 진입점과의 순환 의존을 피한다.

[집계 상태·테이블 정의](../rollup-state.ts)와 [일별 집계 유지](../rollups.ts)는 저장 책임이므로 DB 계층에 둔다. 조회 실행과 페이지 검증은 [reader.ts](../reader.ts)가 맡는다.

## 관련 문서

- [SQLite 테이블](../../../../docs/refrences/SQLiteTables.md) — 현재 테이블의 키와 저장·이관 규칙.
- [SQL 조회 흐름](../../../../docs/refrences/UsageQueryFlow.md) — Webview 요청부터 SQLite 실행과 표·차트 반환까지.
