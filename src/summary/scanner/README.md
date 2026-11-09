# scanner

원본 파일을 한 번 읽는 동안 그룹 winner DTO를 갱신하고 패자의 숫자 벡터를 버린다. 남은 원본별 winner를 최종 세션·요청 그룹으로 병합해 저장한다. 변경 없는 스캔은 본문을 읽지 않으며 사용량 후보 DTO를 다음 갱신까지 캐시하지 않는다.

- [index.ts](index.ts) — `refreshSummary`가 파일 탐색·관계 역인덱스와 작업 큐·부모 요청 귀속·winner 전달·성분별 최종 저장을 조율한다.
- [worklist.ts](worklist.ts) — 관계별 멤버 색인과 파일 ID 우선 작업 큐, 입력 순서를 보존하는 성분 멤버 조회를 제공한다.
- [sourceReader.ts](sourceReader.ts) — 고정 byte 경계까지 이벤트를 읽고 파일 식별자·변경 여부·SHA-256을 검증한다.
- [names.ts](names.ts) — 제공자별 제목 metadata를 읽어 표시 이름의 우선순위를 정한다.
- [lock.ts](lock.ts) — SQLite 잠금으로 여러 VS Code 창의 갱신 쓰기를 직렬화한다.
- [sourceFingerprint.ts](sourceFingerprint.ts) — 원본 식별자·내용 해시로 이동한 로그가 이전 snapshot을 포함하는지 검증한다.
