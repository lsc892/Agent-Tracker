# summary

Claude·Codex 로그를 읽으면서 그룹별 winner DTO를 갱신하고 패자를 버린 뒤 최종 요청·모델·도구 결과만 저장한다. 원본 이벤트 DTO 캐시와 SQL staging·turn metadata 집계 경로는 제거했다.

- [client/](client/README.md): 통계 클라이언트, Worker 통신·명령 실행, 갱신·취소·삭제 직렬화.
- [scanner/](scanner/README.md): 파일 탐색·유효성 근거 수집·스트리밍 집계·성분별 저장, 잠금과 원본 이동 검증.
- [jsonl/](jsonl/README.md): JSONL 스트림·줄/이미지 처리와 Zstd frame 검증·해제.
- [aggregation/](aggregation/README.md): 유효한 후보를 winner와 비교해 같은 DTO를 갱신하고 요청·모델·도구 집계를 생성.
- [models/](models/README.md): 모델별 API 단가와 출시일·이름 정렬 정책.
- [db/](db/README.md): SQLite 저장·조회·마이그레이션·사전 집계.
- [parsers/](parsers/README.md): Claude·Codex 원본을 공통 식별 정보와 파싱 이벤트로 정규화.
- [types.ts](types.ts): 통계 API와 제공자 공통 파싱 이벤트 타입.
- [profiling.ts](profiling.ts): 갱신·SQL 저장 단계별 누적 시간과 호출 횟수.

Worker 실행 파일은 [client/worker.ts](client/worker.ts)에 있다. 수집의 공개 API는 [scanner/index.ts](scanner/index.ts), 실행 조율과 책임별 단계는 [scanner/refresh/](scanner/refresh/README.md), 최종 저장은 [db/memoryStore.ts](db/memoryStore.ts)의 한 경로를 사용한다.
