# ui

quota와 사용량 통계를 VS Code 상태바·툴팁·Webview에 표시한다.

- [colorSettings.ts](colorSettings.ts) — `ColorSettings`: 색상 설정 패널의 수명과 설정 저장을 관리한다.
- [colors.ts](colors.ts): 색상 메시지·HEX 값을 검증하고 상태바 전경색을 결정한다.
- [dashboard.ts](dashboard.ts) — `Dashboard`: 통계·진단 패널의 수명과 조회·갱신 상태를 관리한다.
- [html.ts](html.ts): 통계·진단·색상 설정 화면의 초기 HTML과 실행 자원 경계를 구성한다.
- [presentation.ts](presentation.ts): 문자열을 안전하게 변환하고 Webview 메시지와 조회 범위를 검증한다.
- [quotaTooltip.ts](quotaTooltip.ts): 제공자별 quota·초기화 시각·조회 상태를 Markdown 카드로 구성한다.
- [statusBar.ts](statusBar.ts) — `QuotaStatusBar`: quota 항목·툴팁·새로고침 버튼과 남은 시간 표시를 관리한다.
- [statusBarPresentation.ts](statusBarPresentation.ts): quota를 상태바 문구·잔량 아이콘·접근성 설명으로 변환한다.
