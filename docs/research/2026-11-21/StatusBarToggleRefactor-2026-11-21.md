# 상태 표시줄 팝업 코드 분리

## 변경 범위

사용자가 요청한 호버·클릭 동작과 화면 표시의 파일 분리를 적용했다. 기존 `statusbar-toggle.cjs`는 설치 파일 검사·적용·복원, 과거 버전 주입 코드, 현재 팝업 동작, 구분선 스타일을 함께 다뤘다. 분리 후 [패치 진입점](../../../tools/vscode/statusbar-toggle.cjs)은 주입 코드를 조립하고 설치 파일을 검사·적용·복원한다.

- 동작 모듈은 마우스를 누르는 동안 열린 카드를 유지하고 클릭을 VS Code 내장 토글에 전달한다. 첫 클릭으로 포커스를 주고 고정하며, 고정된 카드는 다음 클릭으로 닫는다. [동작 모듈](../../../tools/vscode/statusbar-toggle-behavior.cjs)
- 팝업 구분선은 별도 View 모듈에서 제공한다. 카드 본문은 Markdown으로 구성한다. [View 모듈](../../../tools/vscode/statusbar-toggle-view.cjs) · [Markdown 카드](../../../src/ui/quotaTooltip.ts)
- 호환 모듈은 기존 설치의 v1~v6 주입 코드를 재구성해 대조한다. 당시의 구분선 코드도 보존하므로 현재 스타일을 수정한 뒤에도 과거 버전을 식별할 수 있다. [호환 모듈](../../../tools/vscode/statusbar-toggle-history.cjs)

## 검증

- 두 가지 workbench 식별자 조합에 대해 v1~v6 주입 코드 12개와 현재 View의 구분선 함수가 이전 패처와 바이트 단위로 일치했다.
- 타입 검사·린트와 438개 Node 테스트를 통과했다. v1~v6 업그레이드, 백업 유지·복원을 확인했다. [패치 테스트](../../../tests/node/statusbar-toggle.test.ts)
- VS Code 1.147.0에서 호버로 열린 카드가 `mousedown` 동안 표시되고, 클릭이 완료되면 같은 위치에서 포커스를 받는 것을 확인했다. 재클릭 닫기, 마우스 이탈과 재진입, Esc·바깥 클릭, 6개 언어 카드 갱신과 실행 시 checksum 검사도 통과했다. [VS Code 화면 테스트](../../../tests/vscode/statusbar-toggle.cjs)
