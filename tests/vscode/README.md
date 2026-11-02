# vscode

실제 VS Code 확장 호스트와 렌더러에서 설정·대시보드·상태바를 검증한다.

- [native-settings-suite.ts](native-settings-suite.ts) — 실제 VS Code의 설정 번역과 기본 설정 편집기 열기를 검증한다.
- [statusbar-toggle.cjs](statusbar-toggle.cjs) — 실제 VS Code를 CDP로 조작해 quota 팝업·색상·다국어 상태바를 검증한다.
- [suite.ts](suite.ts) — 실제 확장 호스트에서 대시보드·요약·설정·테마·페이지 동작을 검증한다.
