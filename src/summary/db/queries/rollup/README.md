# rollup

일별 사전 집계와 원본 경계 구간을 결합해 통계 조회 SQL을 만든다.

- [usage.ts](usage.ts) — 입력 검증, 조회 차원·정렬, 통계 행·개수 SQL 조립을 맡는다.
- [source.ts](source.ts) — 완전한 현지 일과 원본 경계를 결합하고 저장·조회가 공유하는 일별 집계 SQL을 만든다.
- [metrics.ts](metrics.ts) — 일별 합계·완료 표본 수를 병합해 토큰·캐시·소요 시간·품질 지표 SQL을 만든다.

외부 호출부는 [기존 공개 진입점](../../rollup-queries.ts)을 사용한다. 내부 구현은 [공통 필터](../common/filters.ts)·[정렬](../common/sorting.ts)·[타입](../common/types.ts)과 [원본 소스](../raw/source.ts)를 직접 참조한다.
