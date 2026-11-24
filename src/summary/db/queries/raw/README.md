# raw

이전 스레드 상세 DB의 이관과 검증에 필요한 원본 SQL을 만든다. 현재 통계 조회는 [일별 SQL](../rollup/README.md)을 사용한다.

- [source.ts](source.ts) — 이전 스레드의 토큰·모델·비용을 일별 이관 입력으로 읽는다.
- [usage.ts](usage.ts) — 기존 SQL 검증에서 사용하는 원본 통계와 행 개수를 계산한다.
