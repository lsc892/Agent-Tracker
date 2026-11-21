# refresh

한 번의 스캔 갱신을 책임별 모듈로 나눈다. [상위 진입점](../index.ts)은 기존 공개 API를 유지하고, 이 폴더의 index가 실행 순서를 조율한다. 갱신마다 context와 ScanState를 한 번 생성하며 단계들은 기존 Map·Set·DTO의 참조를 공유한다.

- [index.ts](index.ts) — 잠금·Worker 수명과 실제 스캔 단계의 실행 순서를 관리한다.
- [context.ts](context.ts) — 각 단계에 전달하는 실행 환경·상태 참조의 계약을 정의한다.
- [state.ts](state.ts) — 파일과 세션 상태를 관리하고 재파싱·소실 처리에 필요한 시점에 관계 색인을 구성한다.
- [discovery.ts](discovery.ts) — 경로별로 관측을 모아 수정 시각으로 재파싱 후보를 고르고 원본 소실을 판단한다.
- [preparation.ts](preparation.ts) — Worker 준비 결과를 기존 순서로 반영하고 부분 파일·원본 소실을 처리한다.
- [relations.ts](relations.ts) — 관계 큐·계보·부모 요청 귀속·원본 이동 검증을 담당한다.
- [aggregation.ts](aggregation.ts) — 준비한 winner DTO를 변경 원본 우선 순서로 최종 집계기에 전달한다.
- [persistence.ts](persistence.ts) — 연결 묶음을 저장하고 성공한 갱신의 시작 시각을 마지막 트랜잭션에서 확정한다.

의존 방향은 갱신 조율 → 책임별 함수 → 공유 상태·기존 reader/집계/DB 모듈이다. 관계 확장은 준비 함수를 호출하고 준비 함수는 상태만 갱신하므로 관계 모듈을 역참조하지 않는다. 전체 context를 Worker 메시지로 보내거나 단계마다 복제하지 않는다.

알고리즘·최소 힙·선행 창·동점 winner·오류/취소·삭제 보존·트랜잭션 경계와 Worker 종료 시점은 유지한다. 파일별 준비 풀·reader·이름·잠금·작업 큐 구현은 상위 scanner 폴더에서 재사용한다.
