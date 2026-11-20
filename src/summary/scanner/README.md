# scanner

원본의 완성 줄 경계 P와 `[0,P)` SHA-256을 검증하고, 일치하면 P 이후만 파싱한다. 불일치·축소·파서 설정 변경은 전체 파싱으로 복구한다. 변경 없는 파일도 prefix를 읽는다. 원문 대신 파서 문맥·요청별 winner를 통계 Worker의 DB 수명 동안 보관하고, 영향을 받은 세션의 최종 요청만 저장한다. DB 재시작·캐시 부재와 Zstd 원본은 전체 파싱한다.

- [index.ts](index.ts) — 기존 `refreshSummary`·`PARSER_VERSION` 공개 API를 노출한다.
- [refresh/](refresh/README.md) — 갱신 조율·상태·탐색·준비·관계·집계·저장 책임을 같은 상위 폴더 아래에 모은다.
- [worklist.ts](worklist.ts) — 관계별 멤버 색인과 파일 ID 우선 작업 큐, 입력 순서를 보존하는 성분 멤버 조회를 제공한다.
- [sourceReader.ts](sourceReader.ts) — 원본 prefix 해시를 검증하고 완성 줄 경계부터 파서 상태를 재개한다.
- [sourceHash.ts](sourceHash.ts) — 완성 줄 경계에서 상태를 소모하지 않는 SHA-256 스트리밍 해시를 제공한다.
- [sourcePool.ts](sourcePool.ts) — 갱신 중 최대 4개의 파일 준비 Worker와 8개의 선행 작업을 관리하고 논리 순서대로 결과를 전달한다.
- [sourcePreparation.ts](sourcePreparation.ts) — 파일 하나의 읽기·파싱·해시·원본별 winner 선택과 부분 식별 정보가 있는 실패 결과를 구성한다.
- [sourceWorker.ts](sourceWorker.ts) — DB에 접근하지 않고 파일 준비를 실행하며 처리 바이트와 준비 결과를 전달한다.
- [names.ts](names.ts) — 제공자별 제목 metadata를 읽어 표시 이름의 우선순위를 정한다.
- [lock.ts](lock.ts) — SQLite 잠금으로 여러 VS Code 창의 갱신 쓰기를 직렬화한다.
- [sourceFingerprint.ts](sourceFingerprint.ts) — 원본 식별자·내용 해시로 이동한 로그가 이전 snapshot을 포함하는지 검증한다.
