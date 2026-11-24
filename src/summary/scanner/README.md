# scanner

파일별 마지막 정상 반영 수정 시각과 현재 수정 시각을 비교한다. 새 경로와 수정 시각이 다른 원본, 영향 세션의 관련 원본은 처음부터 파싱한다. 저장된 계보 메타는 파일명에 스레드 ID가 없는 부모 후보도 찾는 데 사용한다. 최종 winner를 이전에 반영한 응답과 비교하고 요청 합계와 함께 저장한다.

- [index.ts](index.ts) — 기존 `refreshSummary`·`PARSER_VERSION` 공개 API를 노출한다.
- [refresh/](refresh/README.md) — 갱신 조율·상태·탐색·준비·관계·집계·저장 책임을 같은 상위 폴더 아래에 모은다.
- [worklist.ts](worklist.ts) — 관계별 멤버 색인과 파일 ID 우선 작업 큐, 입력 순서를 보존하는 성분 멤버 조회를 제공한다.
- [sourceReader.ts](sourceReader.ts) — 관측한 크기까지 처음부터 파싱하고 읽는 중 축소나 같은 크기의 재작성을 검출한다.
- [sourcePool.ts](sourcePool.ts) — 최대 4개의 파일 준비 Worker와 8개의 선행 작업을 관리하고 논리 순서대로 준비 결과를 반환한다.
- [sourcePreparation.ts](sourcePreparation.ts) — 파일을 읽으며 응답별 winner와 귀속 근거를 모은다. 실패하면 부분 식별 정보와 오류를 반환한다.
- [sourceWorker.ts](sourceWorker.ts) — 읽기 경계와 원본 식별 정보를 받아 파싱하고 진행량과 준비 결과를 반환한다.
- [names.ts](names.ts) — 제공자별 제목 metadata를 읽어 표시 이름의 우선순위를 정한다.
- [lock.ts](lock.ts) — SQLite 잠금으로 여러 VS Code 창의 갱신 쓰기를 직렬화한다.
