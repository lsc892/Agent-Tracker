# rollup

일별 합계를 저장하고 읽는 SQL을 만든다. 날짜 범위는 통계 시간대의 날짜 경계를 사용한다.

- [usage.ts](usage.ts) — 입력 검증, 조회 차원·정렬, 통계 행·개수 SQL 조립을 맡는다.
- [source.ts](source.ts) — 날짜·미상 시각 필터를 만들고 SQL 입력을 일별 합계로 묶는다.
- [metrics.ts](metrics.ts) — 일별 합계·완료 표본 수를 병합해 토큰·캐시·소요 시간·품질 지표 SQL을 만든다.
- [names.ts](names.ts) — 일별 사용량이 있는 프로젝트·세션 이름 목록을 만든다.
- [capabilities.ts](capabilities.ts) — 일별 도구 통계의 분류별 사용 순위와 전체 지표를 계산한다.
- [diagnostics.ts](diagnostics.ts) — 원본 파일 처리 상태와 이전 값이 남은 세션의 집계 상태를 읽는다.

[조회 실행](../../reader.ts)은 각 SQL 빌더를 호출한다. [공통 필터](../common/filters.ts)·[정렬](../common/sorting.ts)·[타입](../common/types.ts)은 조회 조건과 바인딩을 공유한다.

## 관련 문서

- [SQLite 테이블](../../../../../docs/refrences/SQLiteTables.md) — 현재 테이블의 키와 저장·이관 규칙.
- [SQL 조회 흐름](../../../../../docs/refrences/UsageQueryFlow.md) — Webview 요청부터 SQLite 실행과 표·차트 반환까지.
