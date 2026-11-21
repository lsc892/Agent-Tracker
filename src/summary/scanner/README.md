# scanner

마지막 성공 갱신의 시작 시각 이후에 수정된 원본을 처음부터 파싱한다. 영향을 받은 세션의 관련 원본도 읽어 winner와 귀속에 필요한 근거를 모으고 최종 요청을 저장한다. 파서 상태와 winner는 이번 갱신에서만 사용하며, SQLite에 저장한 기준 시각은 재시작 후에도 적용한다.

- [index.ts](index.ts) — 기존 `refreshSummary`·`PARSER_VERSION` 공개 API를 노출한다.
- [refresh/](refresh/README.md) — 갱신 조율·상태·탐색·준비·관계·집계·저장 책임을 같은 상위 폴더 아래에 모은다.
- [worklist.ts](worklist.ts) — 관계별 멤버 색인과 파일 ID 우선 작업 큐, 입력 순서를 보존하는 성분 멤버 조회를 제공한다.
- [sourceReader.ts](sourceReader.ts) — 관측한 크기까지 처음부터 파싱하면서 이동 검증용 내용 해시를 계산한다.
- [sourcePool.ts](sourcePool.ts) — 갱신 중 최대 4개의 파일 준비 Worker와 8개의 선행 작업을 관리하고 논리 순서대로 결과를 전달한다.
- [sourcePreparation.ts](sourcePreparation.ts) — 파일 하나의 읽기·파싱·해시·원본별 winner 선택과 부분 식별 정보가 있는 실패 결과를 구성한다.
- [sourceWorker.ts](sourceWorker.ts) — 읽기 경계와 원본 식별 정보를 받아 파싱한다. 진행량과 winner DTO 또는 오류를 반환한다.
- [names.ts](names.ts) — 제공자별 제목 metadata를 읽어 표시 이름의 우선순위를 정한다.
- [lock.ts](lock.ts) — SQLite 잠금으로 여러 VS Code 창의 갱신 쓰기를 직렬화한다.
- [sourceFingerprint.ts](sourceFingerprint.ts) — 원본 식별자·내용 해시로 이동한 로그가 이전 snapshot을 포함하는지 검증한다.
