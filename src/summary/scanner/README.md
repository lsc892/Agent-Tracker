# scanner

원본 파일을 선별하고 승인된 파일 DTO를 재사용해 변경된 통계를 원자적으로 갱신한다.

- [index.ts](index.ts) — `refreshSummary`·`PARSER_VERSION`의 공개 진입점을 제공한다.
- [memoryScanner.ts](memoryScanner.ts) — manifest 비교·전체 파일 재파싱·승인 DTO 재사용·관련 집계·성분별 최종 저장을 조율한다.
- [lock.ts](lock.ts) — SQLite 잠금으로 여러 VS Code 창의 갱신 쓰기를 직렬화한다.
- [sourceFingerprint.ts](sourceFingerprint.ts) — 원본 식별자·내용 해시로 이동한 로그가 이전 snapshot을 포함하는지 검증한다.
