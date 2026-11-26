# raw

이전 스레드 상세 DB의 이관과 검증에 필요한 원본 SQL을 만든다. 현재 통계 조회는 [일별 SQL](../rollup/README.md)을 사용한다.

- [source.ts](source.ts) — 이전 스레드의 토큰·모델·비용을 일별 이관 입력으로 읽는다.
- [usage.ts](usage.ts) — 기존 SQL 검증에서 사용하는 원본 통계와 행 개수를 계산한다.

## 관련 문서

- [SQLite 테이블](../../../../../docs/refrences/SQLiteTables.md) — 현재 테이블의 키와 저장·이관 규칙.
- [SQL 조회 흐름](../../../../../docs/refrences/UsageQueryFlow.md) — Webview 요청부터 SQLite 실행과 표·차트 반환까지.
