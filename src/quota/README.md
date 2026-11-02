# quota

Claude·Codex의 구독 quota를 조회하고 공통 상태와 갱신 수명을 관리한다.

- [base.ts](base.ts) — `BaseQuotaProvider`: 제공자별 통신 구현과 별개로 조회의 등록·취소·종료를 관리한다.
- [claude.ts](claude.ts) — `ClaudeQuotaProvider`: Claude OAuth 사용량 조회의 취소·시간 제한·인증 재시도·HTTP 오류를 관리한다.
- [claude/](claude/README.md): Claude HTTP 본문 읽기와 quota 응답 정규화를 담당한다.
- [claudeCredentials/](claudeCredentials/README.md): 운영체제별 Claude CLI 인증 정보를 읽고 토큰을 검증한다.
- [codex.ts](codex.ts) — `CodexQuotaProvider`: 대화 생성 없이 Codex 구독 quota를 조회하고 App Server 실행 수명을 관리한다.
- [codex/](codex/README.md): Codex 실행 파일 탐색·JSON-RPC 통신·quota 응답 정규화를 담당한다.
- [index.ts](index.ts): quota 계약·서비스·제공자·Claude 인증 구현을 외부에 공개한다.
- [providerState.ts](providerState.ts) — `ProviderQuotaState`: 마지막 성공 스냅샷과 오류에 따라 재시도·만료·표시 상태를 결정한다.
- [service.ts](service.ts) — `QuotaService`: 제공자 조회·수동 재실행·구독 알림과 자동 갱신 일정을 조율한다.
- [types.ts](types.ts) — `QuotaError`와 공통 quota 계약·도우미: 데이터·상태를 정의하고 안전한 오류 코드·메시지·재시도 지연을 전달한다.
