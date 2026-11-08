# metadata

호환 SQL staging 경로의 요청 의미 서명·dirty 의존성·확정 집계 재사용을 관리한다. 기본 메모리 갱신의 직접 저장 경로와는 별도이며, 하나의 SQLite 연결과 기존 트랜잭션 경계를 공유한다.

- [index.ts](index.ts) — `SummaryMetadata`: 기존 공개 API, 처리 순서와 metadata TEMP 표의 생성·정리를 소유한다.
- [signatures.ts](signatures.ts) — `MetadataSignatures`: 파일 root 캐시를 소유하고 원본 순서·이름·품질 flag의 의미 서명을 비교한다.
- [dependencies.ts](dependencies.ts) — `MetadataDependencies`: 현재 의존 키를 소유하고 공유 응답·누계의 dirty 요청 확장과 확정 의존 키 저장을 담당한다.
- [snapshots.ts](snapshots.ts) — `MetadataSnapshots`: 확정 요청·모델·Skill을 지연 조회하고 현재 연결 성분의 변경 snapshot을 저장한다.
- [types.ts](types.ts) — 요청·원본 root·의존 키와 dirty 저장 범위의 공유 계약을 정의한다.

`prepare()`는 요청 범위 초기화 → 서명 비교 → 변경 존재 확인 → 의존성 확장 순서다. `commit()`은 세션 저장 트랜잭션 안에서 확정 요청·모델·Skill → 의존 키 순서로 반영한다. `release()`는 완료 파일의 root 캐시만 해제하고 `close()`는 캐시·현재 의존 키·TEMP 표를 정리한다.
