# 상태표시줄 위 카드형 팝업 조사

조사일: 2026-10-05. VS Code 공개 API 문서와 VS Code 1.140.0 소스를 기준으로 정리했다. 아래 내용은 API와 소스 조사 결과이며, 클릭 토글 우회 방법을 실제 UI에서 검증한 결과는 아니다.

## 결론

상태표시줄의 사용량 항목 바로 위에 카드 형태로 내용을 띄우는 공개 API는 **Rich Status Bar Hover**다. `StatusBarItem.tooltip`에 `MarkdownString`을 지정하면 제목, 표, 아이콘, 명령 링크를 포함한 툴팁을 표시할 수 있다. 기존 VS Code 창 안에 겹쳐 표시되므로 터미널 패널 공간이나 별도 창이 필요하지 않다. [공식 API][statusbar-api], [공식 기능 소개][rich-hover]

다만 공개 API로 지원되는 기본 동작은 **마우스를 올려 표시하는 툴팁**이다. 원하는 **클릭으로 열고 다시 클릭해서 닫는 동작**과 **현재 HTML 카드의 디자인을 그대로 옮기는 기능**은 공개 API에 없다. VS Code 내부에는 클릭 토글 구현이 있지만 일반 확장에서 그대로 사용할 수 있는 API는 아니다. [공개 API][statusbar-api], [내부 상태표시줄 구현][statusbar-item]

## 요구사항과 지원 범위

원하는 UI는 우측 하단 상태표시줄의 사용량 항목 위에 표시되는 카드이며, 클릭으로 켜고 끄고 싶다는 요구다.

| 요구사항 | 조사 결과 |
| --- | --- |
| 상태표시줄 항목 바로 위에 카드 표시 | Rich Hover로 가능. 표시 위치는 VS Code가 결정한다. |
| 사용량, 사용률, 초기화 시간 표시 | Markdown 텍스트와 표로 가능. |
| 새로고침, 사용량 통계 열기 | 허용한 명령으로 연결되는 링크로 가능. |
| 마우스를 올려 열기 | 공개 API의 기본 동작. |
| 클릭으로 열고 다시 클릭해 닫기 | 공개된 상태표시줄 API에 토글 기능이 없다. |
| 현재 카드의 CSS, 버튼, 상세/압축 탭을 그대로 재사용 | Markdown 툴팁으로는 불가. HTML 지원도 제한된 요소만 허용한다. |
| 사용자가 카드를 드래그해 위치 이동 | 공개된 상태표시줄 툴팁 API에 해당 기능이 없다. |

위 범위는 [StatusBarItem][statusbar-api]과 [MarkdownString][markdown-api]의 공개 인터페이스를 기준으로 판단했다. 확장에는 VS Code 화면의 DOM에 접근해 임의의 카드를 삽입하는 기능도 제공되지 않는다. [확장 기능 제한][no-dom]

## 공개 API로 만드는 방법

`StatusBarItem.tooltip`은 문자열 또는 `MarkdownString`을 받는다. `MarkdownString.supportThemeIcons`로 VS Code 테마 아이콘을 표시하고, `isTrusted.enabledCommands`로 카드 안의 링크가 실행할 명령을 지정할 수 있다. `supportHtml`을 활성화해도 임의의 HTML, CSS, JavaScript를 실행하는 Webview가 되는 것은 아니다. [StatusBarItem][statusbar-api], [MarkdownString][markdown-api]

아래 코드는 표시 방식의 예시다. 사용률과 초기화 시간은 설명용 고정 값이며, 실제 적용할 때는 현재 quota 상태에서 생성해야 한다.

```ts
const tooltip = new vscode.MarkdownString();
tooltip.supportThemeIcons = true;
tooltip.isTrusted = {
  enabledCommands: ['agentTracker.refreshQuota', 'agentTracker.openUsage'],
};
tooltip.appendMarkdown('### 사용량\n\n');
tooltip.appendMarkdown('| 제공자 | 기간 | 사용률 |\n| --- | --- | ---: |\n');
tooltip.appendMarkdown('| Codex | 5시간 | 58% |\n');
tooltip.appendMarkdown('| Codex | 7일 | 53% |\n\n');
tooltip.appendMarkdown('2시간 56분 후 초기화\n\n');
tooltip.appendMarkdown('[$(refresh) 새로고침](command:agentTracker.refreshQuota)');
tooltip.appendMarkdown(' · [사용량 통계](command:agentTracker.openUsage)');
statusBarItem.tooltip = tooltip;
```

이 예시는 툴팁 내용만 설정한다. 상태표시줄 클릭 명령이나 클릭 토글을 구현하는 코드는 포함하지 않는다. 외부에서 읽은 문자열을 넣을 때는 `appendText` 등으로 Markdown 구문을 이스케이프하고, 실행할 명령은 필요한 목록만 허용한다.

## 내부 클릭 토글을 그대로 호출할 수 없는 이유

VS Code 내부 상태표시줄 서비스에는 다음 객체가 정의되어 있다. [내부 명령 정의][statusbar-service]

```ts
export const ShowTooltipCommand: Command = {
  id: 'statusBar.entry.showTooltip', title: '',
};
export const ToggleTooltipCommand: Command = {
  id: 'statusBar.entry.toggleTooltip', title: '',
};
```

상태표시줄 항목은 명령 ID 문자열만 비교하는 것이 아니라 `command === ToggleTooltipCommand`처럼 **내부 객체의 동일성**을 검사해 툴팁 표시 및 닫기를 처리한다. 확장에서 전달한 명령은 별도의 객체로 변환되어 전달되므로 `statusBarItem.command = 'statusBar.entry.toggleTooltip'`을 지정한다고 같은 경로로 처리되지 않는다. 이 ID를 공개 토글 명령처럼 사용하는 방법은 지원되는 구현으로 판단할 수 없다. [상태표시줄 처리][statusbar-item], [확장 명령 변환][ext-host-commands], [확장 상태표시줄 전달][statusbar-extension]

VS Code 자체의 사용량 카드에는 DOM으로 만든 대시보드가 사용된다. 이 내부 구현이 존재한다는 사실과 일반 확장에서 같은 HTML 팝업을 사용할 수 있다는 것은 별개의 문제다. [내장 대시보드 소스][chat-dashboard]

## Agent Tracker의 현재 코드와 적용 지점

- [src/ui/statusBar.ts](../src/ui/statusBar.ts): 현재 사용량 항목의 `tooltip`은 문자열이다. Rich Hover를 적용한다면 이 값을 quota 상태에서 만든 `MarkdownString`으로 바꾸는 것이 적용 지점이다.
- [src/ui/quotaView.ts](../src/ui/quotaView.ts): 현재 `toggle()`은 `agentTracker.quotaView.focus`와 `workbench.action.closePanel`로 하단 패널을 열고 닫는다. 상태표시줄 위 툴팁 토글과는 다른 동작이다.
- [package.json](../package.json): 사용량 Webview는 `viewsContainers.panel` 아래에 등록되어 있다. 공개 Webview API에는 이를 상태표시줄에 붙는 팝업으로 전환하는 옵션이 없다. [Webview 문서][webview-guide]

공개 API 범위에서 선택할 수 있는 구현은 Markdown 카드형 툴팁이다. 클릭 토글이 필수라면 이 조사만으로 요구사항이 충족되는 구현을 확보한 상태는 아니다. 이 문서는 조사 내용을 기록하며 실제 UI 코드는 변경하지 않았다.

[statusbar-api]: https://code.visualstudio.com/api/references/vscode-api#StatusBarItem
[markdown-api]: https://code.visualstudio.com/api/references/vscode-api#MarkdownString
[rich-hover]: https://code.visualstudio.com/updates/v1_58#_rich-status-bar-hover
[no-dom]: https://code.visualstudio.com/api/extension-capabilities/overview#no-dom-access
[webview-guide]: https://code.visualstudio.com/api/extension-guides/webview
[statusbar-service]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/services/statusbar/browser/statusbar.ts
[statusbar-item]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/browser/parts/statusbar/statusbarItem.ts
[ext-host-commands]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/api/common/extHostCommands.ts
[statusbar-extension]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/api/browser/statusBarExtensionPoint.ts
[chat-dashboard]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.ts
