# storage-ab fixtures

2026-10-29 증분 저장 롤백 직전의 `SessionStore`·`UsageRollupStore` 컴파일 결과를 고정한다. 출처는 `tests/.cache/rollback-worktrees-20261029/before`의 당시 빌드이며, 워크트리 HEAD는 `929c0c4f7c0e141395501351ba29bb4cb82ee024`였다. 당시 미커밋 변경도 포함된 작업 snapshot이므로 HEAD만으로 이 파일을 복원할 수 있다고 가정하지 않는다.

- [incremental-sessions.js.txt](incremental-sessions.js.txt) — 요청별 기존 행·모델·Skill TEMP 비교와 차이 저장의 보존본.
- [incremental-rollups.js.txt](incremental-rollups.js.txt) — 영향 날짜·프로젝트 재집계와 큰 변경의 세션 재집계 보존본.

벤치마크는 이 두 클래스만 schema v13 제품 snapshot의 연결·스키마·조회·검증·가격 계산에 연결한다. 나머지 제품 코드와 SQL은 모든 후보가 공유한다. 월 PK 제품 전환 이후에는 `storage-ab.cjs --product=<schema-v13-root>`로 고정 버전을 지정하며, 로컬에 보존된 `tests/.cache/storage-product-20261030/before`가 있으면 기본 선택한다. 파일은 실행기가 `Module._compile`로 읽으며 제품 번들에는 연결하지 않는다. 보존본과 사용한 제품 소스·빌드·실행기 SHA-256은 원시 보고서에 기록한다.
