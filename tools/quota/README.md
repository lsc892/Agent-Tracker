# quota

실제 계정의 quota 응답과 제품 파싱·표시·프로세스 정리를 독립 대조한다.

- [contract.cjs](contract.cjs) — `QaError`로 고정 오류 코드를 전달하며 제품 파서와 독립적으로 서버 quota 기대 값·표시를 검증한다.
- [live-qa.cjs](live-qa.cjs) — 실계정 quota를 조회해 서버 응답·확장 결과·화면 표시와 프로세스 정리를 대조한다.
- [observe-codex.cjs](observe-codex.cjs) — Codex RPC를 중계하며 quota 기대 값과 자식 프로세스 수명 증거만 기록한다.
