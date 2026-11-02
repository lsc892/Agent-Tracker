# claudeCredentials

Claude CLI가 소유한 운영체제별 인증 정보를 읽어 quota 조회용 토큰을 제공한다.

- [common.ts](common.ts): 인증 소스 계약·데이터 경로·인증 파일 읽기·토큰 검증을 제공한다.
- [index.ts](index.ts): 운영체제에 맞는 인증 소스를 생성하고 인증 구현을 공개한다.
- [mac.ts](mac.ts) — `MacClaudeCredentials`: macOS 인증 파일을 우선 읽고 기본 경로의 읽기 실패에만 Keychain을 조회한다.
- [windows.ts](windows.ts) — `WindowsClaudeCredentials`: Windows·Linux에서 CLI 소유 인증 파일을 읽어 조회용 토큰을 제공한다.
