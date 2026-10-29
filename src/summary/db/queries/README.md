# queries

통계 SQL을 공통 정책·원본 조회·일별 사전 집계 조회로 나눈다. 각 파일은 해당 책임의 SQL과 바인딩을 함께 만든다.

- [common/](common/README.md): SQL 타입, 제공자·이름·날짜 필터, 표시 기준 정렬을 공유한다.
- [raw/](raw/README.md): 요청 원본과 통계·요청·이름·도구·진단 조회를 구성한다.
- [rollup/](rollup/README.md): 일별 집계와 원본 경계를 결합하고 합계·평균·조회 페이지를 구성한다.

기존 호출부는 [queries.ts](../queries.ts)와 [rollup-queries.ts](../rollup-queries.ts)를 사용한다. 두 파일은 공개 함수와 타입을 재노출하고 구현을 담지 않는다. 내부 구현은 필요한 파일을 직접 참조해 공개 진입점과의 순환 의존을 피한다.

[집계 상태·테이블 정의](../rollup-state.ts)와 [일별 집계 유지](../rollups.ts)는 저장 책임이므로 DB 계층에 둔다. 조회 실행과 페이지 검증은 [reader.ts](../reader.ts)가 맡는다.
