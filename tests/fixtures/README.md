# fixtures

테스트와 벤치마크에서 재사용하는 합성 입력·기준 구현·보조 프로세스를 제공한다.

- [jsonl-byte-reader.ts](jsonl-byte-reader.ts) — `SummaryError`로 오류 위치를 전달하고 `JsonlLine`으로 줄 예산을 관리하는 독립 기준 리더를 제공한다.
- [quota-app-server.cjs](quota-app-server.cjs) — quota 테스트용 Codex RPC 응답과 실패·종료 시나리오를 모사한다.
- [quota-benchmark-app-server.cjs](quota-benchmark-app-server.cjs) — 고정 메모리와 응답 지연을 가진 quota 벤치마크용 RPC 서버를 모사한다.
- [quotaCardFixture.ts](quotaCardFixture.ts) — 실제 VS Code 팝업 검증에 사용할 합성 quota 상태와 상태바를 준비한다.
- [request-title-ab.ts](request-title-ab.ts) — 제목 집계 SQL 대안을 비교할 합성 입력·검증·공간 조회 도구를 제공한다.
- [statusbar-toggle-v4.txt](statusbar-toggle-v4.txt) — 이전 v4 상태바 패치를 재현하는 문자열 입력으로 호환·복원 검증에 사용한다.
- [summary-lock.cjs](summary-lock.cjs) — 스레드·자식 프로세스에서 요약 갱신 잠금의 획득과 해제를 제어한다.
- [usage-chart.ts](usage-chart.ts) — 공개 사용량 표 페이지를 차트로 변환하는 공통 테스트 도우미를 제공한다.
