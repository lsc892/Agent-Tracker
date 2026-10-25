# summary

Claude·Codex 대화 로그를 수집·집계하고 Worker를 통해 통계 API를 제공한다.

- [client.ts](client.ts) — `SummaryClient`: 통계 조회·갱신·설정 API와 작업 순서를 조율한다.
- [db](db/README.md) — 통계의 SQLite 저장·조회·마이그레이션·사전 집계를 담당한다.
- [jsonl.ts](jsonl.ts) — JSONL을 읽으며 `SummaryError`는 오류 코드·위치를, `JsonlLine`은 크기 제한·이미지 제거를 담당한다.
- [lock.ts](lock.ts) — 여러 VS Code 창의 통계 쓰기를 SQLite 잠금으로 직렬화한다.
- [modelOrder.ts](modelOrder.ts) — 모델 출시일과 숫자 버전으로 정렬 기준을 만든다.
- [names.ts](names.ts) — Codex의 별도 제목 메타데이터를 저장된 세션 이름에 반영한다.
- [parsers](parsers/README.md) — 제공자별 로그를 공통 식별 정보와 파싱 이벤트로 변환한다.
- [pricing.ts](pricing.ts) — 모델별 표준 단가로 API 추정 비용을 계산한다.
- [refresh.ts](refresh.ts) — `RefreshController`: 갱신·취소·삭제 요청의 중복과 실행 순서를 관리한다.
- [scanner.ts](scanner.ts) — 변경된 로그와 연결 세션을 다시 파싱해 통계를 교체한다.
- [staging.ts](staging.ts) — `SummaryStaging`: 임시 테이블에서 세션 계보·중복 제거·요청 집계 후보를 관리한다.
- [transport.ts](transport.ts) — `WorkerTransport`: Worker 수명과 요청·응답·진행 알림을 관리한다.
- [types.ts](types.ts) — 통계 API와 제공자 공통 파싱 이벤트 타입을 정의한다.
- [worker.ts](worker.ts) — 호스트 명령에 따라 DB 조회·갱신·설정·삭제를 실행한다.
- [zstd.ts](zstd.ts) — Zstd를 스트리밍 해제하며 `ZstdError`는 오류를, `ZstdFrames`는 프레임 경계 검증을 담당한다.
