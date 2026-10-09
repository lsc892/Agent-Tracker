# Agent Tracker 로컬라이징 구조

현재 프로젝트의 한국어 문구를 원문으로 유지한다. 지원 언어는 한국어·영어·중국어 간체·일본어·스페인어·프랑스어다.

## TypeScript 구현 선택

- [i18next TypeScript 문서](https://www.i18next.com/overview/typescript): 리소스로 키를 제한할 수 있다. 이 프로젝트의 `t()`는 한국어 JSON의 `keyof`를 키 타입으로 사용하고 JavaScript·HTML의 키도 빌드에서 검사한다.
- [VS Code 공식 샘플](https://github.com/microsoft/vscode-extension-samples/tree/main/l10n-sample), [vscode-l10n](https://github.com/microsoft/vscode-l10n): 코드의 `vscode.l10n`과 정적 기여 항목의 `package.nls`를 구분한다. 확장 설정으로 언어를 즉시 전환하고 Webview와 공유해야 하므로 실행 중 문구는 i18next, VS Code가 관리하는 manifest는 `package.nls`로 처리한다.

## 구조

```text
localization/
  languages.json         지원 언어, 표시 이름, VS Code locale 별칭
  locales/ko.json         기존 한국어 원문과 전체 키
  locales/{locale}.json   언어별 번역
  package.nls*.json       정적 기여 항목 번역 생성물
src/localization/index.ts 언어 결정, 타입이 있는 t(), 한국어 fallback
media/localization.js     Webview 번역 엔진과 정적 문구 갱신
tools/localization.cjs    검증, package.nls 생성, 패키지 리소스 준비
tools/localization-manifest.cjs 패키징·VS Code 실행 동안 manifest 번역 임시 배치
```

언어별 JSON 하나에 `common.*`, `quota.*`, `status.*`, `dashboard.*`, `diagnostics.*`, `color.*`, `manifest.*`처럼 기능별 키를 둔다. 화면은 문구나 언어별 조건문 대신 `t('dashboard.totalTokens')`를 사용한다. 현재 문자열 규모에서는 기능마다 파일과 로더를 분리하는 복잡성이 필요하지 않다. 원문을 수정해도 의미 기반 키는 유지한다.

언어 목록·번역 원본·manifest 번역 생성물은 루트의 `localization/`에서 관리한다. 빌드는 실행용 JSON을 `dist/localization/`에 준비한다. [VS Code의 manifest 번역 로더](https://github.com/microsoft/vscode/blob/main/src/vs/platform/extensionManagement/common/extensionsScannerService.ts)는 `package.json` 옆의 `package.nls*.json`을 읽으므로, `npm run package`·`npm run test:vscode`·`npm run test:toggle`은 작업 동안만 루트에 복사하고 성공·실패 뒤 정리한다. 기존 루트 파일이 있으면 원래 내용을 복원한다. VSIX에는 루트의 manifest 번역과 `dist/localization/`을 포함하고 원본 `localization/`은 제외한다.

F5 디버깅도 실행 전 task에서 manifest 번역을 임시 배치하고 종료 뒤 task에서 복원한다. 원래 상태는 패키지에서 제외되는 `dist/.localization-manifest.json`에 보관하며 다음 실행 시 남은 이전 복사본을 먼저 복원한다. 디버깅이 비정상 종료되어 복사본이 남았다면 `node tools/localization-manifest.cjs --restore`로 정리할 수 있다.

HTML·SVG·명령 링크는 코드에서 구성하고 번역에는 문구와 `{value0}` 같은 변수만 둔다. HTML 문구는 escape 처리하고 동적 값은 `textContent`로 표시한다. 대화 본문이나 credential을 외부 번역 서비스로 전송하지 않는다.

## 언어 선택과 전환

`agentTracker.language` 기본값 `auto`는 `vscode.env.language`를 따른다. 명시적 언어가 우선하며 지원하지 않는 언어와 누락된 키는 한국어로 fallback한다. 지역 태그는 기본 언어로 묶고 중국어 태그는 간체 번역을 사용한다. 표시 언어와 집계 시간대는 독립적이다.

상태 표시줄·quota 카드·안내와 열린 통계·데이터 확인·색상 화면은 언어 변경에 따라 다시 표시한다. 숫자·날짜·USD 형식도 선택한 언어를 따른다. 로그의 프로젝트·세션·요청 이름과 진단 코드·원본 오류는 번역하지 않는다. 언어 변경은 서버 조회나 원본 재스캔을 발생시키지 않는다. quota 오류에는 키를 보존하여 과거 오류도 현재 언어로 표시한다.

Agent Tracker의 ‘설정 열기’는 `workbench.action.openSettings`로 VS Code Settings의 확장 설정을 연다. 별도의 전체 설정 Webview 없이 기존 사용자·작업공간 설정과 입력 제약·초기화 동작을 사용한다. 기존 색상 선택 Webview는 설정의 색상 선택 링크로 연다.

명령 팔레트와 **VS Code Settings**의 카테고리·설명·선택지는 VS Code가 manifest 로딩 때 번역하므로 VS Code 표시 언어를 따른다. 확장 Language 설정과 독립적이다. `package.nls.json`은 영어로 생성하고 한국어는 `package.nls.ko.json`으로 제공한다. 지원하지 않는 VS Code 언어의 정적 문구는 영어로 fallback하며 실행 중 확장 문구의 한국어 원문·fallback은 유지한다. 별도의 언어별 VSIX나 설치된 manifest의 런타임 수정을 사용하지 않는다.

`npm run check`는 여섯 언어의 설정 manifest 번역·영어 기본 카탈로그·설정 열기 경로도 검증한다. 실제 VS Code의 manifest 로딩과 기본 Settings 열기는 `npm run build` 뒤 `node tests/runners/test-native-settings.cjs en`으로 확인한다. 설치된 한국어 언어팩이 있는 Windows 환경에서는 `en ko`로 두 표시 언어를 대조할 수 있다. 격리 프로필에서 두 제공자의 추적을 끄고 확장 Language를 VS Code와 다른 언어로 지정하여 두 언어 기준의 독립성을 확인하며 실계정 quota는 조회하지 않는다.

## 새 기능과 언어 추가

새 기능은 한국어 JSON에 의미가 있는 키를 추가하고 다른 언어에 같은 키·변수로 번역한 뒤 `t()`로 참조한다. 빌드에서 화면 코드의 한국어 문자열, 없는 키 참조, 번역 누락·빈 값·변수 불일치를 검사한다.

새 언어는 `localization/languages.json`에 locale·표시 이름·VS Code 별칭을 추가하고 같은 키 집합의 `localization/locales/<locale>.json`을 만든다. 언어별 `switch`나 TS import 목록을 수정하지 않는다.

```sh
npm run localization:sync
npm run check
```

`localization/package.nls*.json`은 생성물로 관리하며 번역 수정은 카탈로그에서 한다. 빌드도 동기화하고 타입 검사는 생성물 일치를 확인한다. 실행 시에는 네트워크 없이 패키지에 포함된 JSON과 i18next를 사용한다.
