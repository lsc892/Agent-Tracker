<p align="center">
  <a href="README.md">English</a> |
  <strong><a href="README.ko.md">한국어</a></strong> |
  <a href="README.zh.md">简体中文</a> |
  <a href="README.ja.md">日本語</a> |
  <a href="README.es.md">Español</a> |
  <a href="README.fr.md">Français</a>
</p>

# Agent Tracker

Claude·Codex의 현재 사용량과 리셋까지 남은 시간을 확인하고, 대화 로그로 토큰 사용량과 소요 시간을 추적하는 VS Code 확장입니다.

## 주요 기능

### 상태 표시줄에서 사용량 확인

- **현재 사용량** — VS Code 상태 표시줄에서 Claude·Codex의 구독 사용률과 리셋까지 남은 시간을 확인합니다.
- **상세 카드** — 클릭하면 5시간·주간 사용량, 리셋 시간, Codex 리셋권 등을 보여 주는 카드가 열립니다.
- **자동·수동 갱신** — 기본 15분 간격으로 조회하며, 새로고침 버튼으로 바로 갱신할 수 있습니다.

![상태 표시줄과 사용량 상세 카드](resource/readme/at-1.png)

### 대화·기간·모델별 토큰과 시간 비교

- **토큰·시간 통계** — 대화·일·월·프로젝트·모델별 총 토큰, 요청당 평균 토큰, 평균 소요 시간을 표와 차트로 확인합니다.
- **사용 기록** — 스킬·플러그인·서브에이전트·모델의 사용 횟수와 비율을 살펴봅니다.
- **이용 방식 개선** — 요청당 평균 토큰과 시간을 기준으로 모델 변경이나 스킬·플러그인 도입 전후를 비교하고, 에이전트 사용 방식을 조정합니다.

![모델별 평균 토큰 차트와 스킬 사용 통계](resource/readme/at-2.png)

카드의 **사용량 통계** 또는 명령 팔레트의 **Agent Tracker: 사용 통계 열기**로 진입합니다. 통계는 화면을 열 때 로컬 대화 로그에서 계산합니다.

## 설치 및 삭제

### 설치

Node.js **22.15 이상**, VS Code **1.101 이상**, 터미널에서 실행 가능한 `code` 명령이 필요합니다. Claude Code·Codex CLI에서 먼저 로그인하세요.

```sh
npx agent-tracker-vscode@latest
```

npm으로 설치 명령을 전역에 등록하려면 다음을 실행합니다.

```sh
npm install -g agent-tracker-vscode@latest
agent-tracker-vscode
```

설치 후 VS Code 명령 팔레트에서 **Developer: Reload Window**를 실행합니다. 업데이트도 같은 설치 명령을 사용합니다. macOS에서 `code` 명령이 없으면 **Shell Command: Install 'code' command in PATH**를 먼저 실행하세요.

특정 프로필에 설치하려면 미리 만든 프로필 이름을 지정합니다.

```sh
npx agent-tracker-vscode@latest --profile "Work"
```

카드를 다시 클릭해 닫는 토글 동작은 선택적인 [로컬 VS Code 패치](docs/research/StatusBarPopup.md)가 필요합니다.

### 삭제

VS Code 확장 목록에서 **Agent Tracker → 제거**를 선택하거나 다음 명령을 실행합니다.

```sh
code --uninstall-extension AgentTracker.agent-tracker
```

특정 프로필에 설치했다면 삭제 명령에도 `--profile "Work"`를 붙입니다. npm 전역 설치 패키지도 제거하려면 다음을 실행합니다.

```sh
npm uninstall -g agent-tracker-vscode
```

npm 패키지 삭제와 VS Code 확장 삭제는 별도입니다.

## VS Code 확장 설정

카드의 **설정**을 클릭하거나 VS Code 설정에서 `@ext:AgentTracker.agent-tracker`를 검색합니다.
아래 설정 키에는 모두 `agentTracker.` 접두사가 붙습니다.

| 설정 | 기본값 | 설명 |
| --- | --- | --- |
| `language` | `auto` | VS Code 언어 따르기. 한국어·영어·중국어 간체·일본어·스페인어·프랑스어 선택 가능 |
| `claude.enabled` / `codex.enabled` | `true` | 제공자별 사용량 조회·로그 통계 추적 |
| `quota.refreshPolicy` | `automatic` | 자동 조회. `manual`은 새로고침을 누를 때만 조회 |
| `quota.pollingIntervalSeconds` | `900` | 자동 조회 간격(초). 최소 30초, 비활성 창에서는 일시 중지 |
| `codex.showStatusBar` | `true` | Codex 상태 표시줄 표시. 숨겨도 사용량 조회는 유지 |
| `display.percentage` | `used` | 사용률 표시. `remaining`은 남은 비율 표시 |
| `display.detail` | `detailed` | 7일·5시간 표시. `compact`는 5시간만 표시 |
| `display.colorMode` | `automatic` | 테마 색상 사용. `white`·`black`·`custom` 선택 가능 |
| `display.customColor` | `#ffffff` | `custom` 모드에서 사용할 HEX 색상 |
| `codex.showReserve` | `false` | 계정에서 제공하는 GPT Reserve 사용량 표시 |
| `codex.showResetCredits` | `true` | 계정에서 제공하는 리셋권 횟수와 다음 만료 시간 표시 |
| `usage.enabled` | `true` | 로컬 대화 로그의 토큰·시간 통계 사용 |
| `usage.skillsEnabled` | `true` | 스킬·플러그인·서브에이전트·모델 사용 횟수 집계 |
| `usage.showApiCosts` | `false` | API 추정 비용(USD) 표시. 구독 사용은 0으로 표시 |
| `usage.excludeEmptyUsage` | `true` | 모델과 토큰 정보가 모두 없는 요청을 차트·평균에서 제외. 표에는 유지 |
| `usage.timezone` | 시스템 시간대 | 일·월 통계의 기준 시간대. 예: `Asia/Seoul` |
| `dataHome` | `~` | `.claude`·`.codex`가 있는 공통 상위 폴더. 사용자 설정에서 지정 |
| `claude.cleanupPeriodDays` | `null` | Claude 로그 보존 일수. 1 이상 입력 시 Claude 설정에 반영, `null`은 기존 값 유지 |
| `codex.executable` | `codex` | Codex CLI 명령 또는 실행 파일 경로 |

**통계 계산 데이터 삭제** 명령으로 집계 결과를 초기화할 수 있습니다. 원본 대화 로그는 유지되며 통계를 다시 열면 재계산합니다.

[사용 및 개발 참고](docs/Development.ko.md)
