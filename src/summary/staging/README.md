# staging

호환 SQL staging의 원본·이벤트·계보·집계 준비를 한 SQLite 연결에서 관리한다. 기본 메모리 갱신 경로와 별개인 공개 `SummaryStaging` API를 유지한다.

- [index.ts](index.ts) — `SummaryStaging`: 원본 관측·파싱·연결 성분·집계·해제를 조율하고 기존 공개 API와 계측 메소드 경계를 유지한다.
- [types.ts](types.ts) — `StagedFile`·`PreparedTurn`: 임시 원본과 준비 요청의 공유 SQL 행 타입을 정의한다.
- [schema.ts](schema.ts) — 원본·이벤트·연결 성분 TEMP 표와 인덱스를 생성·정리한다.
- [sources.ts](sources.ts) — `StagingSources`: 원본 귀속·영향 세션·이동 후보와 파일 페이지 조회를 관리한다.
- [events.ts](events.ts) — `StagingEvents`: 청크 DTO·플래그의 실패 복구, 복사 접두사 검증과 일회 SQL 적재를 관리한다.
- [lineage.ts](lineage.ts) — TEMP 방문 상태·스택을 사용해 부모를 먼저 해소하고 순환·모호한 경로의 기존 귀속을 보존한다.
- [components.ts](components.ts) — 영향 세션의 양방향 연결 성분을 선택하고 성공한 성분의 TEMP 입력을 정리한다.
- [summaries.ts](summaries.ts) — `StagingSummaries`: 정상 성분의 집계 TEMP를 재사용하고 요청·모델·Skill을 저장 DTO로 변환한다.
- [memoryEvents.ts](memoryEvents.ts) — `MemoryEvents`: 승자 DTO·원본 서명·의존성과 복사 검증 근거를 보관한다.
- [eventValues.ts](eventValues.ts) — 선택된 DTO·root anchor를 SQL 열 순서로 변환한다.
- [names.ts](names.ts) — 제공자 제목 metadata를 우선순위에 따라 staging과 저장 이름에 반영한다.
