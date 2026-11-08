# client

Extension Host의 통계 API와 Worker 실행·통신·작업 순서를 관리한다.

- [index.ts](index.ts) — `SummaryClient`: 조회·갱신·설정·종료 API를 조율한다.
- [transport.ts](transport.ts) — `WorkerTransport`: 같은 폴더의 Worker를 실행하고 요청·응답·진행 알림·종료를 관리한다.
- [refresh.ts](refresh.ts) — `RefreshController`: 갱신 병합·취소·데이터 삭제를 직렬화한다.
- [worker.ts](worker.ts) — Worker 명령을 분배해 DB 조회·스캔·설정·삭제를 실행한다.
