# codex

Codex App Server 조회에 필요한 실행 파일 탐색·JSON-RPC 통신·응답 변환을 제공한다.

- [errors.ts](errors.ts): 프로토콜 실패와 조회 취소에 사용할 공통 quota 오류를 생성한다.
- [executable.ts](executable.ts): Windows의 경로·npm shim에서 셸 없이 실행할 Codex 실행 파일을 찾는다.
- [response.ts](response.ts): 한도 응답과 초기화 크레딧을 검증해 공통 quota 스냅샷으로 변환한다.
- [rpcSession.ts](rpcSession.ts) — `RpcSession`: App Server 하나의 JSON-RPC 연결·대기 요청·프로세스 종료 수명을 관리한다.
