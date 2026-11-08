# summary

Claude·Codex 대화 로그의 수집·집계·저장·Worker API를 책임별 폴더로 나눈다. 기본 갱신은 파일 DTO를 재사용하는 메모리 집계이며 SQL staging·metadata API는 호환성과 별도 검증을 위해 유지한다.

- [client/](client/README.md): 통계 클라이언트, Worker 통신·명령 실행, 갱신·취소·삭제 직렬화.
- [scanner/](scanner/README.md): 기본 갱신 진입점, manifest·파일 DTO 재사용, 잠금과 원본 이동 검증.
- [jsonl/](jsonl/README.md): JSONL 스트림·줄/이미지 처리와 Zstd frame 검증·해제.
- [aggregation/](aggregation/README.md): 파일 DTO의 계보·복사·응답 중복을 처리해 최종 요청·모델·도구 집계 생성.
- [staging/](staging/README.md): 호환 SQL 경로의 원본·이벤트·계보·연결 성분·집계 준비와 제공자 제목 수집.
- [metadata/](metadata/README.md): 호환 SQL 경로의 요청 의미 서명·dirty 의존성·확정 snapshot.
- [models/](models/README.md): 모델별 API 단가와 출시일·이름 정렬 정책.
- [db/](db/README.md): SQLite 저장·조회·마이그레이션·사전 집계.
- [parsers/](parsers/README.md): Claude·Codex 원본을 공통 식별 정보와 파싱 이벤트로 정규화.
- [types.ts](types.ts): 통계 API와 제공자 공통 파싱 이벤트 타입.

기존 summary/client·scanner·jsonl·staging·metadata import는 각 폴더의 index.ts에서 같은 공개 API를 제공한다. Worker 실행 파일은 [client/worker.ts](client/worker.ts)에 있으며 클라이언트의 기본 경로도 같은 폴더를 사용한다.
