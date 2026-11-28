# summary

Claude·Codex 로그를 읽으며 파일별 응답 후보를 고르고, 관련 파일의 중복 응답과 Codex 누계를 비교해 스레드별 사용량을 계산한다. SQLite 쓰기 트랜잭션에서 영향 세션의 일별 제공자·모델 집계와 원본 상태를 함께 반영한다.

- [client/](client/README.md): 통계 클라이언트, Worker 통신·명령 실행, 갱신·취소·삭제 직렬화.
- [scanner/](scanner/README.md): 파일별 수정 시각 비교·스트리밍 집계·잠금과 성분별 저장.
- [jsonl/](jsonl/README.md): JSONL 스트림·줄/이미지 처리와 Zstd frame 검증·해제.
- [aggregation/](aggregation/README.md): 현재 스레드 누계 검산과 토큰 합산, 이전 요청 집계의 비교 코드.
- [models/](models/README.md): 모델별 API 단가와 출시일·이름 정렬 정책.
- [db/](db/README.md): SQLite 저장·조회·마이그레이션·사전 집계.
- [parsers/](parsers/README.md): Claude·Codex 원본을 공통 식별 정보와 파싱 이벤트로 정규화.
- [types.ts](types.ts): 통계 API와 제공자 공통 파싱 이벤트 타입.
- [profiling.ts](profiling.ts): 갱신·SQL 저장 단계별 누적 시간과 호출 횟수.

Worker 실행 파일은 [client/worker.ts](client/worker.ts)에 있다. 수집의 공개 API는 [scanner/index.ts](scanner/index.ts), 실행 조율과 책임별 단계는 [scanner/refresh/](scanner/refresh/README.md), 최종 저장은 [db/memoryStore/index.ts](db/memoryStore/index.ts)의 한 경로를 사용한다. 기존 [db/memoryStore.ts](db/memoryStore.ts)는 공개 경로를 유지하며, [memoryStore/](db/memoryStore/README.md) 안에서 영속 반영과 값 변환·타입을 나눈다.

## 관련 문서

- [설계 명세](../../docs/refrences/AgentTracker.md) — 기능의 설계 기준과 정책.
- [LogParsingFields](../../docs/refrences/LogParsingFields.md) — Claude·Codex JSONL 필드와 해석 규칙.
- [winner 정책](../../docs/refrences/WinnerPolicy.md) — 응답 비교 키와 동점 처리, Codex 누계 검산.
- [SQLite 테이블](../../docs/refrences/SQLiteTables.md) — 현재 테이블의 키와 저장·이관 규칙.
- [SQL 조회 흐름](../../docs/refrences/UsageQueryFlow.md) — Webview 요청부터 SQLite 실행과 표·차트 반환까지.
