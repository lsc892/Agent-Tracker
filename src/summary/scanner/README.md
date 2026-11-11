# scanner

원본 파일을 한 번 읽는 동안 그룹 winner DTO를 갱신하고 패자의 숫자 벡터를 버린다. 남은 원본별 winner를 최종 세션·요청 그룹으로 병합해 저장한다. 변경 없는 스캔은 본문을 읽지 않으며 사용량 후보 DTO를 다음 갱신까지 캐시하지 않는다.

- [index.ts](index.ts) — 기존 `refreshSummary`·`PARSER_VERSION` 공개 API를 노출한다.
- [refresh/](refresh/README.md) — 갱신 조율·상태·탐색·준비·관계·집계·저장 책임을 같은 상위 폴더 아래에 모은다.
- [worklist.ts](worklist.ts) — 관계별 멤버 색인과 파일 ID 우선 작업 큐, 입력 순서를 보존하는 성분 멤버 조회를 제공한다.
- [sourceReader.ts](sourceReader.ts) — 고정 byte 경계까지 이벤트를 읽고 파일 식별자·변경 여부·SHA-256을 검증한다.
- [sourcePool.ts](sourcePool.ts) — 갱신 중 최대 4개의 파일 준비 Worker와 8개의 선행 작업을 관리하고 논리 순서대로 결과를 전달한다.
- [sourcePreparation.ts](sourcePreparation.ts) — 파일 하나의 읽기·파싱·해시·원본별 winner 선택과 부분 식별 정보가 있는 실패 결과를 구성한다.
- [sourceWorker.ts](sourceWorker.ts) — DB에 접근하지 않고 파일 준비를 실행하며 처리 바이트와 준비 결과를 전달한다.
- [names.ts](names.ts) — 제공자별 제목 metadata를 읽어 표시 이름의 우선순위를 정한다.
- [lock.ts](lock.ts) — SQLite 잠금으로 여러 VS Code 창의 갱신 쓰기를 직렬화한다.
- [sourceFingerprint.ts](sourceFingerprint.ts) — 원본 식별자·내용 해시로 이동한 로그가 이전 snapshot을 포함하는지 검증한다.
