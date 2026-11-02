# raw

저장된 요청 원본을 기준으로 통계와 선택 목록·진단 SQL을 만든다. 공통 조건과 정렬은 [common](../common/README.md)을 사용한다.

- [source.ts](source.ts) — 제공자·모델 요청 원본에 이름·비용·기록 여부 열을 구성한다.
- [usage.ts](usage.ts) — 요청 원본을 기간·프로젝트·세션별로 집계하고 행·개수 SQL을 만든다.
- [turns.ts](turns.ts) — 요청 상세 목록과 개수 SQL을 만든다.
- [names.ts](names.ts) — 프로젝트·세션 이름 선택 목록과 개수 SQL을 만든다.
- [capabilities.ts](capabilities.ts) — 도구 분류별 사용 순위와 전체 합계·최댓값 SQL을 만든다.
- [diagnostics.ts](diagnostics.ts) — 파일·요청 진단 목록과 처리 상태 개수 SQL을 만든다.
