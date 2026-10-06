# 상태표시줄 위 카드형 팝업 조사

조사·구현·검증일: 2026-10-05. VS Code 공개 API 문서와 VS Code 1.140.0 소스를 기준으로 정리했다. Markdown 카드와 로컬 workbench 패치를 구현하고 실제 VS Code에서 클릭 토글을 검증했다.

## 결론

상태표시줄의 사용량 항목 바로 위에 카드 형태로 내용을 띄우는 공개 API는 **Rich Status Bar Hover**다. `StatusBarItem.tooltip`에 `MarkdownString`을 지정하면 제목, 표, 아이콘, 명령 링크를 포함한 툴팁을 표시할 수 있다. 기존 VS Code 창 안에 겹쳐 표시되므로 터미널 패널 공간이나 별도 창이 필요하지 않다. [공식 API][statusbar-api], [공식 기능 소개][rich-hover]

다만 공개 API로 지원되는 기본 동작은 **마우스를 올려 표시하는 툴팁**이다. 원하는 **클릭으로 열고 다시 클릭해서 닫는 동작**과 **현재 HTML 카드의 디자인을 그대로 옮기는 기능**은 공개 API에 없다. VS Code 내부에는 클릭 토글 구현이 있지만 일반 확장에서 그대로 사용할 수 있는 API는 아니다. [공개 API][statusbar-api], [내부 상태표시줄 구현][statusbar-item]

Agent Tracker에서는 **로컬 VS Code의 내부 토글 객체에 연결하는 패치**를 적용했다. 상태표시줄 사용량 항목을 클릭하면 카드가 위에 열려 유지되고, 다시 클릭하면 닫힌다. 카드가 닫혀 있을 때 호버하면 제공자별 5시간 남은 비율·재설정 시간과 `클릭하여 열기/닫기` 안내만 표시한다. 카드가 열려 있으면 요약 호버를 표시하지 않는다. 바깥 클릭이나 Esc로도 닫을 수 있다. 이 연결에는 확장 VSIX 외에 아래의 workbench 패치가 필요하다.

## 요구사항과 지원 범위

원하는 UI는 우측 하단 상태표시줄의 사용량 항목 위에 표시되는 카드이며, 클릭으로 켜고 끄고 싶다는 요구다.

| 요구사항 | 조사 결과 |
| --- | --- |
| 상태표시줄 항목 바로 위에 카드 표시 | Rich Hover로 가능. 표시 위치는 VS Code가 결정한다. |
| 사용량, 사용률, 초기화 시간 표시 | Markdown 텍스트와 표로 가능. |
| 새로고침, 사용량 통계 열기 | 허용한 명령으로 연결되는 링크로 가능. |
| 마우스를 올려 열기 | 닫혀 있을 때 짧은 요약만 표시한다. 전체 카드는 클릭으로 연다. |
| 클릭으로 열고 다시 클릭해 닫기 | 공개 API에는 없다. 로컬 workbench 패치로 내장 토글에 연결해 구현·검증했다. |
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

## Agent Tracker에 적용한 구현

- [src/ui/quotaTooltip.ts](../src/ui/quotaTooltip.ts): 제공자 이름과 다음 초기화 시간을 한 줄로, 기간별 색상 막대·비율을 그 아래에 표시한다. 막대는 자체 생성한 SVG data URI를 사용하며 사용률에 따라 초록·노랑·빨강으로 표시한다. 추가 quota, 조회 중·오래된 값·오류 안내와 마지막 갱신 시각도 유지한다. `supportHtml`은 제한된 색상 span에 사용하고 외부 문자열은 `appendText`로 이스케이프한다. Codex 응답의 `rateLimitResetCredits.availableCount`와 사용 가능한 항목의 가장 빠른 `expiresAt`을 재설정 가능 횟수·다음 만료 시간으로 표시한다. 상세 항목 수로 횟수를 추정하지 않으며, 만료 정보가 없으면 횟수만 표시한다. [Codex App Server](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)
- [src/ui/statusBar.ts](../src/ui/statusBar.ts): `tooltip`에는 전체 카드를, 접근성 label에는 짧은 요약을 제공하고 클릭 명령을 `agentTracker.toggleQuotaTooltip`으로 지정한다. 패치가 label을 자동 호버에 사용하므로 스크린리더와 마우스 사용자가 같은 요약을 받는다. [statusBarPresentation.ts](../src/ui/statusBarPresentation.ts)의 `quotaHoverSummary`는 Claude·Codex 순서로 5시간 남은 비율과 재설정까지의 시간을 표시한다. 카운트다운은 1분마다 현재 snapshot에서 다시 계산하며 네트워크 조회나 통계 스캔을 시작하지 않는다.
- [src/extension.ts](../src/extension.ts): 전체 새로고침·사용량 통계·상세/압축 명령과 Agent Tracker 설정 열기를 등록한다. 제공자별 새로고침·확장 관리 명령은 제거했다. 설정에서 추적 대상, 자동/수동 갱신, 통계 사용 여부와 계산 데이터 삭제를 관리한다. 패치가 없는 설치에서 클릭 명령은 `workbench.action.showHover`로 열린다.
- [package.json](../package.json): 하단 사용량 패널 등록과 기존 `agentTracker.toggleQuota` 명령을 제거했다. 기존 quota Webview 구현과 전용 JS/CSS도 제거했다. 사용량 통계·Diagnostics Webview는 계속 사용한다.
- [scripts/vscode/statusbar-toggle.cjs](../scripts/vscode/statusbar-toggle.cjs): Agent Tracker 클릭 명령을 내부 토글 객체에 연결하는 로컬 설치 패치와 적용 확인·복원을 제공한다.

카드의 상세/압축 설정은 상태표시줄에만 적용하며, 카드에는 추적 중인 제공자의 모든 quota 기간을 표시한다. Claude는 추적이 켜져 있으면 상태표시줄에도 표시한다. `codex.showStatusBar`만 끈 Codex는 카드에 남지만, `enabled`로 추적을 끈 제공자는 조회와 카드·통계 표시에서 제외한다. Claude 추적을 끄고 Codex 상태표시줄도 숨기면 카드 진입점도 숨겨진다. `사용량 통계` 아래의 `설정`과 명령 팔레트의 `Agent Tracker: 설정 열기`는 확장 설정 화면으로 연결된다. 제목 행은 너비 100%의 HTML 표로 구성하고, `새로고침`을 오른쪽 셀의 `align="right"`로 정렬한다. 조회 중에는 같은 위치에 진행 상태를 표시하고 새로고침 링크를 제거한다. 정렬에는 마크다운 렌더러가 허용하는 `width`·`align` 속성을 사용한다. [렌더러 소스](https://github.com/microsoft/vscode/blob/main/src/vs/base/browser/markdownRenderer.ts)

제공자별 텍스트 영역과 하단 명령 영역은 카드 양쪽 끝까지 이어지는 Markdown 수평선으로 구분한다. 기본 수평선은 테마에 따라 잘 보이지 않아 로컬 workbench 패치가 Agent Tracker 설정 링크를 포함하는 카드의 선만 2px·`#888888`로 표시한다. 내용의 좌우 여백을 상쇄하므로 카드 너비가 바뀌어도 구분선이 가장자리까지 이어진다. 각 제공자의 추가 한도·재설정 안내·오류는 해당 영역에 모은다. 마지막 갱신 시각은 추적 중인 제공자들의 가장 최근 성공 시각을 사용해 카드 상단 `사용량` 제목과 `상태 표시줄` 선택 사이에 한 번 표시한다. 성공 이력이 없으면 `—`로 표시한다. 상태표시줄의 Claude·Codex 사이에는 세로 구분선 `│`를 표시한다.

## 내장 클릭 토글에 연결하는 알고리즘

1. 현재 VS Code 설치의 workbench bundle에서 `statusBar.entry.toggleTooltip` 객체와 `StatusbarEntryItem.update` 처리 지점을 찾는다. 변수 이름은 현재 bundle에서 구하며 고정하지 않는다. 중복되거나 예상한 pointer·sticky hover 처리가 없으면 중단한다.
2. `update(entry)` 시작에 `entry.extensionId === 'agent-tracker.agent-tracker'`이고 `entry.command.id === 'agentTracker.toggleQuotaTooltip'`인 경우만 명령 객체를 내부 `ToggleTooltipCommand`로 바꾸는 코드를 삽입한다. 입력 객체는 복사하므로 원래 entry는 변경하지 않는다.
3. 항목별 hover delegate를 만들어 자동 표시(`focus=false`)에는 접근성 label의 plain text 요약을, 클릭·키보드 표시(`focus=true`)에는 원래 Markdown 카드를 전달한다. 다른 항목과 공유하는 원본 delegate는 변경하지 않고 hover 지연과 해제 처리는 그대로 위임한다. 카드가 열린 상태에서는 `mouseover`·`focus` capture listener와 delegate 양쪽에서 요약 표시를 막는다. listener는 한 번만 등록하고 항목 해제 시 제거한다. [자동 호버 소스][hover-service]
4. VS Code의 기존 pointerdown·click 처리는 그대로 실행된다. pointerdown에서 기존 sticky hover 여부를 기록하므로 mousedown의 기본 닫기 처리 뒤에도 두 번째 클릭을 닫기로 판단할 수 있다. 열기는 `hover.show(true)`를 사용해 마우스를 옮겨도 유지한다. [내장 처리 소스][statusbar-item]
5. 다른 확장·명령과 quota 데이터 조회는 이 변환을 거치지 않는다. 닫기·외부 클릭·Esc의 상태 처리는 VS Code가 맡는다.

명령 ID만 전달하는 방식에서 부족했던 **객체 동일성**을 2번에서 해결한다. 3번은 요약 호버와 전체 카드를 분리하고 명시적인 클릭·키보드 토글과 열린 카드의 갱신을 유지한다. 확장 호스트가 내부 sentinel 객체를 직접 얻는 방식은 아니다.

### 클릭 후 다시 열리는 버그의 원인과 재현

2026-10-05 조사 당시 실제 설치에는 토글 패치가 없었다. 따라서 `agentTracker.toggleQuotaTooltip`은 확장 호스트의 fallback인 `workbench.action.showHover`를 매번 실행했다. VS Code의 mousedown 처리가 기존 카드를 먼저 닫은 다음 click 명령이 카드를 다시 열었다. `node scripts/test-statusbar-toggle.cjs --baseline`으로 격리된 VS Code 1.140.0에서 두 번째 클릭의 DOM 제거·재생성을 관찰해 재현했다. 결과는 `test-results/statusbar-toggle-baseline.json`에 기록했다.

v3 패치는 내장 토글의 pointerdown 상태 보존을 사용해 닫기 클릭을 구별한다. 닫힌 뒤 마우스가 다시 들어와도 전체 카드를 열지 않고 짧은 요약만 표시한다. 패치가 없는 환경의 fallback은 여전히 열기 전용이므로 VSIX 설치만으로 토글 동작이 적용되지는 않는다.

## 적용·확인·복원

저장소 루트에서 VSIX를 설치한 뒤 실행한다.

```sh
npm run patch:vscode
npm run patch:vscode -- --check
npm run test:toggle
```

적용·갱신 뒤에는 **모든 VS Code 창을 종료하고 다시 실행한다.** `Developer: Reload Window`는 메인 프로세스를 재시작하지 않으므로 패치 전에 읽은 product checksum으로 변경된 파일을 검사해 설치 손상 경고가 나올 수 있다. 복원 뒤에도 완전히 종료하고 다시 실행한다.

```sh
npm run restore:vscode
```

Windows 기본 설치는 환경 변수에서 찾고 `bin/code.cmd`가 가리키는 현재 버전의 `resources/app`을 사용한다. 개인 계정이나 저장소 절대 경로는 코드에 고정하지 않는다. 선택한 Windows CLI를 대상으로 하려면 `npm run patch:vscode -- --cli "<code.cmd 경로>"`를 사용한다. 별도 설치는 `--executable` 또는 `--app-root`로 지정한다. 확인과 복원에도 동일한 대상 옵션을 사용한다.

수정 전에 등록된 workbench checksum과 JavaScript 구문을 검증한다. 원본 `workbench.desktop.main.js`와 `product.json`을 각각 `.agent-tracker-toggle.bak`으로 보관하며 변경 전후 SHA-256을 `.agent-tracker-toggle.json`에 기록한다. `product.json`에서는 해당 workbench 파일의 checksum만 갱신한다. 재실행은 중복 삽입하지 않고, 기존 v1·v2·v3 토글 패치는 원본 백업을 보존하며 v4 요약·카드 분리 및 구분선 스타일 패치로 갱신한다. 복원은 원본 파일을 정확히 되돌린다. 이후 다른 수정이나 백업 손상이 감지되면 덮어쓰지 않는다. 적용·갱신 도중 한 파일만 변경된 경우도 백업으로 복원할 수 있다.

이는 비공개 구현에 의존하는 로컬 패치다. **VS Code 업데이트 뒤에는 재적용해야 한다.** VSIX 패키징·확장 활성화·CI에서는 설치 파일을 자동 수정하지 않는다. 지원하지 않는 내부 구조에서는 적용을 중단하며, 패치가 없는 설치는 기본 마우스 호버와 클릭 열기 경로를 사용한다.

### 설치 손상 경고를 받은 경우

VS Code는 현재 파일 checksum을 실행 시 전달받은 product 기준값과 비교한다. 패치 당시 실행 중이던 메인 프로세스는 이전 기준값을 계속 사용할 수 있으므로 창 새로고침 후에도 경고가 날 수 있다. [무결성 검사 소스][integrity-service], [렌더러 product 설정][product-configuration]

2026-10-05에 사용자의 경고를 조사했을 때 디스크의 등록된 검사 대상 10개는 모두 현재 checksum과 일치했고, 메인 프로세스는 product 파일 변경 전에 시작되어 있었다. 이전 기준값이 남은 경우로 판단했으며 원본 백업도 유지되어 있다. 경고를 숨기거나 무결성 검사를 끄지 않고 완전 재시작으로 새 기준값을 읽도록 한다. 재시작 후에도 반복되면 실제 검사 실패 항목을 확인하고, 필요하면 위 복원 명령으로 원본으로 되돌린다.

후속 조사에서도 12:47에 시작된 메인 프로세스가 유지되어 새 창이 기존 프로세스를 사용하고 있었다. 별도 프로필의 새 VS Code 프로세스에서 `vscode.context.configuration().product.checksums`를 직접 읽어 디스크 registry와 일치함을 확인하고, 등록된 파일 10개가 실제 runtime 기준값과 모두 일치하는 것을 검증했다. 이 새 프로세스에서는 설치 손상 경고가 표시되지 않았으며 클릭 전용 토글도 통과했다. 결과는 `test-results/statusbar-integrity.json`에 저장한다. 종료할 때는 상단 **파일 → 종료**를 사용하고 다른 VS Code 창이나 메인 프로세스가 남아 있지 않은 상태에서 다시 실행한다.

## 구현 검증

- `npm run check`: 타입 검사·lint와 104개 테스트 통과. 카드 명령과 통계 스캔 분리 외에 요약 문구·순서·카운트다운, 내부 객체 동일성, 확장·명령 범위, 열린 카드의 요약 호버 차단과 listener 해제, v1·v2 패치 갱신, 현재 CLI 경로 선택, checksum·백업·복원, 중단된 적용 복구를 검증했다.
- `npm run test:vscode`: 실제 VS Code 1.140.0에서 `MarkdownString`의 문자열 이스케이프, 모든 기간 표시, 사용률/남은 비율, 초기화 카운트다운과 조회 상태를 검증했다. 카드에 연결된 통계 명령과 Usage·Diagnostics Webview는 light/dark 테마에서 통과했다.
- `npm run test:toggle`: 격리된 실제 VS Code 1.140.0에서 닫힌 카드의 요약 호버, 첫 클릭 열기, 상태표시줄 위 배치, 마우스 이탈 뒤 유지, 열린 카드의 요약 숨김, 두 번째 클릭 닫기와 반복 클릭, 닫은 뒤 요약 호버 복원, 바깥 클릭·Esc 뒤 한 번 클릭 재열기를 검증한다. hover 지연을 100ms로 설정하고 1.5초간 관찰하며 실제 마우스·키보드 이벤트를 전송한다. [검증 스크립트](../scripts/test-statusbar-toggle.cjs)
- 같은 테스트에서 새 프로세스가 로드한 product checksum과 디스크 registry, 파일 10개의 실제 checksum이 일치함을 검증하고 설치 손상 알림이 표시되지 않는지 확인한다.
- 클릭 결과는 `test-results/statusbar-toggle.json`, 실제 화면은 `test-results/statusbar-toggle.png`에 저장했다. 합성 계정 오류 상태의 카드 화면도 직접 확인했다. 모든 제공자 상태·창 크기·원격 환경의 화면 검증까지 포함한 결과는 아니다.

[statusbar-api]: https://code.visualstudio.com/api/references/vscode-api#StatusBarItem
[markdown-api]: https://code.visualstudio.com/api/references/vscode-api#MarkdownString
[rich-hover]: https://code.visualstudio.com/updates/v1_58#_rich-status-bar-hover
[no-dom]: https://code.visualstudio.com/api/extension-capabilities/overview#no-dom-access
[webview-guide]: https://code.visualstudio.com/api/extension-guides/webview
[statusbar-service]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/services/statusbar/browser/statusbar.ts
[statusbar-item]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/browser/parts/statusbar/statusbarItem.ts
[hover-service]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/platform/hover/browser/hoverService.ts#L543
[integrity-service]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/services/integrity/electron-browser/integrityService.ts#L96
[product-configuration]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/platform/product/common/product.ts#L23
[ext-host-commands]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/api/common/extHostCommands.ts
[statusbar-extension]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/api/browser/statusBarExtensionPoint.ts
[chat-dashboard]: https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/chat/browser/chatStatus/chatStatusDashboard.ts
