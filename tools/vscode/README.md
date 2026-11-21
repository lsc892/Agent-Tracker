# vscode

로컬 VS Code의 quota 카드 토글 패치를 적용·검사·복원한다.

- [statusbar-toggle.cjs](statusbar-toggle.cjs) — VS Code 상태바의 quota 카드 토글 패치를 조립하고 검사·적용·복원한다.
- [statusbar-toggle-behavior.cjs](statusbar-toggle-behavior.cjs) — 임시 호버에서 클릭으로 포커스를 주고 카드를 고정하는 동작을 연결한다.
- [statusbar-toggle-view.cjs](statusbar-toggle-view.cjs) — 사용량 카드의 구분선 스타일을 적용한다. 카드 본문은 [quotaTooltip.ts](../../src/ui/quotaTooltip.ts)가 구성한다.
- [statusbar-toggle-history.cjs](statusbar-toggle-history.cjs) — 업그레이드 시 설치된 v1~v6 패치의 주입 코드를 대조한다.
