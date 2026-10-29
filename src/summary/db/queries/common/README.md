# common

원본·롤업 조회에서 함께 사용하는 SQL 계약과 필터·정렬 규칙을 둔다. 각 조회 구현은 필요한 파일을 직접 참조한다.

- [types.ts](types.ts) — `QuerySql`의 SQL·바인딩 계약과 제공자·모델 집계 기준을 정의한다.
- [filters.ts](filters.ts) — 제공자·프로젝트·세션·이름·날짜 조건과 바인딩을 만든다.
- [sorting.ts](sorting.ts) — 시간·모델 미상 우선순위와 통계 표의 안정적인 전체 정렬을 만든다.
