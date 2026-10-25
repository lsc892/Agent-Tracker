# parsers

Claude·Codex 로그를 공통 식별 정보와 요청·사용량·도구 이벤트로 변환한다.

- [capabilities.ts](capabilities.ts) — 도구 호출에서 스킬·서브에이전트·플러그인 사용을 추출한다.
- [claude.ts](claude.ts) — `ClaudeParserAdapter`: Claude 세션 문맥을 유지하며 요청·응답·수명주기 이벤트를 내보낸다.
- [codex.ts](codex.ts) — `CodexCurrentParserAdapter`는 현재·이전 로그를 해석하고 `CodexLegacyParserAdapter`는 이전 형식용 이름을 제공한다.
- [common.ts](common.ts) — 값·경로·제목·토큰·결제 분류의 공통 정규화를 제공한다.
- [index.ts](index.ts) — Claude·Codex 파서와 제공자별 토큰 변환 함수를 공개한다.
