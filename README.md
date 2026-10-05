# Agent Tracker

Claude와 Codex의 구독 사용률, 로컬 대화 기록의 요청별 토큰 사용량을 보여 주는 VS Code 확장입니다.

- **Quota**: 하나의 상태 표시줄에 Claude·Codex 로고, 남은 잔량 막대, 사용률과 초기화 시각 표시
- **Usage**: 일·월·프로젝트·세션·사용자 요청별 합계와 완료 요청의 평균 토큰·소요 시간
- **Diagnostics**: 파일 처리 상태, 오류 위치, 이전 정상 통계를 유지한 요청

## 실행

Node.js 22.15 이상에서 다음 명령을 실행한 뒤 VS Code에서 **F5**를 누릅니다. VS Code 1.101 이상이 필요하며, 확장 호스트에 내장 `node:sqlite`가 있어야 합니다.

```sh
npm ci
npm run build
```

아래의 로컬 VS Code 패치를 적용하면 상태 표시줄의 Claude·Codex 사용량 항목을 **클릭해 바로 위에 카드를 열고, 다시 클릭해 닫습니다.** 카드가 닫혀 있을 때 마우스를 올리면 제공자별 5시간 남은 비율·재설정까지의 시간과 `클릭하여 열기/닫기` 안내가 나옵니다. 카드가 열려 있으면 이 요약 호버는 숨겨지며, 열린 카드는 마우스를 옮겨도 유지됩니다. 바깥 클릭이나 Esc로도 닫습니다. 카드에는 모든 quota 기간의 사용률·잔량·초기화 시간, 조회 상태와 마지막 갱신 시각이 나옵니다. `상세`/`압축` 링크는 상태 표시줄의 표시량을 바꾸며, 상세는 7일·5시간 사용량을, 압축은 5시간 사용량만 표시합니다. 카드는 두 모드 모두 모든 quota 기간을 표시합니다. `사용량 통계` 링크로 통계 Webview를 열고, 바로 아래 `설정` 링크로 VS Code의 Agent Tracker 확장 설정을 엽니다. 명령 팔레트의 `Agent Tracker: 대시보드 열기` 또는 `Agent Tracker: 사용 통계 열기`로도 통계에 진입할 수 있습니다.

카드의 제공자 이름 옆에는 다음 quota 초기화까지 남은 시간이 나오고, 아래에는 `5h`·`wk` 등의 기간과 색상 막대·사용률을 표시합니다. 사용률이 50% 이상이면 노랑, 80% 이상이면 빨강이며 낮은 사용률은 초록입니다. 추가 quota도 별도 줄에 표시하고, 막대에 마우스를 올리면 해당 기간의 초기화 시간을 확인할 수 있습니다. Codex 아래에는 서버가 제공한 **rate-limit 재설정 N회 사용 가능**과 **다음 항목이 … 후 만료됨**을 표시합니다. 재설정 횟수는 quota 기간 수와 별개이며, 만료 상세 정보가 없으면 횟수만 표시합니다. [Codex App Server 응답](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)

오른쪽 새로고침 버튼과 툴팁 상단의 새로고침 링크는 추적 중인 제공자의 현재 quota만 조회합니다. 조회 중인 링크는 갱신 상태 문구로 바뀝니다. 제공자별 새로고침·확장 관리 링크는 제공하지 않습니다. 툴팁 상단의 새로고침은 제목과 같은 행의 오른쪽에 표시합니다. 로고 SVG와 상태줄·툴팁용 아이콘 폰트는 `resource/icon`에 포함됩니다.

VSIX를 만들려면 다음 명령을 사용합니다. 생성된 `agent-tracker-0.1.0.vsix`를 VS Code의 **Extensions: Install from VSIX...**로 설치합니다.

```sh
npm run package
```

클릭 토글은 VS Code 내부의 `ToggleTooltipCommand`에 연결하므로 VSIX 설치와 별도로 로컬 workbench 패치가 필요합니다. 저장소 루트에서 다음 명령을 실행하고 **모든 VS Code 창을 종료한 뒤 다시 실행하세요.** 창 새로고침만으로는 메인 프로세스가 가진 이전 checksum 기준값이 갱신되지 않아 설치 손상 경고가 남을 수 있습니다. 일반 빌드나 확장 활성화에서는 VS Code 설치 파일을 수정하지 않습니다.

```sh
npm run patch:vscode
npm run patch:vscode -- --check # 적용 확인
npm run restore:vscode         # 원본 복원
```

패치는 원본과 무결성 정보를 백업하고 Agent Tracker의 해당 클릭 명령만 내부 토글 객체로 연결합니다. 자동 호버는 짧은 요약을 표시하고 클릭은 전체 카드를 표시합니다. 카드가 열린 동안에는 요약 호버를 차단하며 다른 항목의 호버는 유지합니다. 이전 v1·v2 패치는 원본 백업을 유지하며 v3으로 갱신합니다. VS Code 1.140.0에서 실제 호버와 클릭을 검증했습니다. VS Code 업데이트 뒤에는 패치를 다시 적용해야 하며, 지원하지 않는 내부 구조이면 적용을 중단합니다. Windows 기본 설치는 환경 변수와 현재 CLI에서 찾으며, 다른 설치는 `--cli <code.cmd 경로>`, `--executable <실행 파일>` 또는 `--app-root <resources/app 경로>`로 지정합니다. 패치가 없는 환경에서는 VS Code의 기본 마우스 호버와 클릭 열기 경로를 사용하므로 클릭으로 닫기는 지원하지 않습니다.

## 로그인과 경로

확장과 같은 환경의 CLI 로그인 정보를 사용합니다. Claude Code 또는 Codex CLI에서 먼저 로그인하세요. Codex API key 계정은 ChatGPT 구독 quota 대상으로 표시하지 않습니다.

| 설정 | 기본값 |
|---|---|
| `agentTracker.claude.enabled` / `agentTracker.codex.enabled` | 각 제공자 추적 켜짐 |
| `agentTracker.quota.refreshPolicy` | `automatic`; 수동 새로고침만 사용하려면 `manual` |
| `agentTracker.usage.enabled` | 사용량 통계 켜짐 |
| `agentTracker.claude.dataHome` | `CLAUDE_CONFIG_DIR` 또는 `~/.claude` |
| `agentTracker.codex.dataHome` | `CODEX_HOME` 또는 `~/.codex` |
| `agentTracker.codex.executable` | PATH의 `codex` |
| `agentTracker.usage.claudeRoots` | Claude 홈의 `projects` |
| `agentTracker.usage.codexRoots` | Codex 홈의 `sessions`, `archived_sessions` |
| `agentTracker.usage.timezone` | 시스템 시간대; 예: `Asia/Seoul` |
| `agentTracker.quota.pollingIntervalSeconds` | Claude·Codex 공통 900초, 최소 30초 |
| `agentTracker.codex.showStatusBar` | Codex 상태 표시줄 표시 |
| `agentTracker.display.percentage` | `used`; 남은 비율은 `remaining` |
| `agentTracker.display.detail` | `detailed`; 간략 표시는 `compact` |

Windows의 npm Codex 설치는 `.cmd` 옆 패키지에서 네이티브 실행 파일을 찾습니다. 다른 설치 방식이면 `.exe` 경로를 지정하세요. WSL·SSH·컨테이너에서는 확장이 실행되는 환경의 CLI·로그 경로를 사용합니다.

추적을 끈 제공자는 quota 조회·통계 수집을 중단하고 카드와 통계에서 숨깁니다. 기존 통계 데이터는 보관하며 다시 켜면 표시합니다. Claude는 추적이 켜져 있으면 상태 표시줄에 표시합니다. `codex.showStatusBar`는 Codex의 상태 표시줄만 숨기는 설정입니다. 자동 갱신은 Claude·Codex에 같은 간격을 적용하며 활성 창에서만 동작합니다. 창으로 돌아올 때 마지막 성공 조회가 5분 이상 지났거나 조회에 실패했다면 재시도합니다. 수동 정책은 시작 시에도 조회하지 않고 새로고침을 누를 때만 조회합니다.

`Usage: Enabled`를 끄면 진행 중인 통계 수집을 취소하고 통계 창을 닫습니다. 이 설정 아래의 **통계 계산 데이터 삭제** 링크 또는 같은 이름의 명령 팔레트 명령으로 파일 처리 정보(`manifest`)와 집계 결과(`turn_summary`)를 함께 비울 수 있습니다. 원본 대화 로그는 유지됩니다. 삭제 직후 재수집하지 않으며, 통계를 켜고 다시 열면 재계산합니다. 상태 표시줄 항목이 모두 숨겨져도 명령 팔레트의 **Agent Tracker: 설정 열기**에서 다시 설정할 수 있습니다.

## 데이터 처리

통계 기능이 켜져 있으면 활성화 시 SQLite schema만 준비합니다. quota는 추적 대상과 갱신 정책에 따라 조회합니다. JSONL 스캔은 사용량 통계에 진입할 때만 시작합니다. quota 툴팁 표시·카운트다운·새로고침·상세/압축 변경, 통계 내부 탭·날짜·시간대·그룹·페이지 변경은 스캔을 시작하지 않습니다. 비활성 창에서는 quota 자동 조회를 생략합니다.

SQLite는 확장 `globalStorageUri`의 `agent-tracker.sqlite`에 저장됩니다. 영속 테이블은 `manifest`, `turn_summary` 두 개입니다. 변경된 세션은 원본 전체를 다시 읽어 중복 응답을 제거하고 교체하며, 변화가 없는 세션은 본문을 읽지 않습니다. 하위 에이전트의 토큰은 부모 요청에 더하고 시간은 부모 요청 값만 사용합니다.

Codex 하위 에이전트 파일 전체에 `root_turn_id`가 없는 구형 로그는 해당 thread를 독립 대화로 집계합니다. 자체 요청·토큰·소요 시간을 사용하고 `standalone-subagent` 품질 표시를 남깁니다. 부모 원본과 일치하는 복제 이력은 중복에서 제외하며, 부모를 확인할 수 없는 이력은 임의로 차감하지 않습니다.

여러 창의 동시 갱신은 데이터·테이블이 없는 별도 `agent-tracker.sqlite.refresh-lock.sqlite` 파일의 SQLite 잠금으로 조정합니다. 프로세스가 비정상 종료되어도 잠금은 해제되며, 이 파일은 재사용하므로 실행 중 삭제하지 않습니다.

파일 목록과 응답 후보는 worker의 디스크 임시 테이블에서 처리합니다. 파일 metadata 묶음은 최대 256개, 조회 페이지는 100개, JSONL 한 줄은 기본 4 MiB로 제한합니다. 한도를 넘거나 형식을 해석할 수 없으면 진단을 남기고 기존 정상 통계를 유지합니다. 프롬프트·응답·tool 본문과 OAuth token은 DB에 저장하지 않습니다.

잘못된 시간대 설정은 화면에 안내하고 시스템 시간대로 조회합니다. 일·월 통계에서 시작 시각이 없는 요청은 날짜 필터를 적용해도 ‘시각 미상’ 그룹으로 표시합니다.

## 검증

```sh
npm run check       # 타입 검사, lint, fixture/worker/process/UI 연결 테스트
npm run test:vscode # 격리된 실제 VS Code에서 light/dark Webview 동작 검증
npm run test:toggle # 패치된 로컬 VS Code에서 실제 클릭·유지·닫기 검증
npm run benchmark   # 합성 파일 301개 + 큰 세션 2,000개 요청
npm run benchmark:quota # 합성 App Server 성공/오류/timeout/취소의 시간·메모리·종료 검증
```

대량 benchmark는 `BENCHMARK_FILES`, `BENCHMARK_TURNS` 환경 변수로 조절합니다. 결과는 `benchmark-results/summary.json`에 남으며 실제 개인 대화 기록은 사용하지 않습니다. quota 자원 측정 옵션과 한계는 [측정 안내](docs/QuotaBenchmark.md)를 참고하세요.

`test:vscode`는 별도 프로필과 합성 로그를 `.vscode-test/`에 만듭니다. Windows에서는 설치된 VS Code를 우선 사용하고, 그 외에는 테스트용 VS Code를 다운로드합니다. `VSCODE_TEST_VERSION`으로 다운로드 버전을, `VSCODE_EXECUTABLE`로 실행 파일을 지정할 수 있습니다. Linux의 화면 없는 환경에서는 `xvfb-run -a npm run test:vscode`를 실행합니다. 결과는 `test-results/vscode-smoke.json`에 기록합니다.

`test:toggle`은 패치가 적용된 설치를 읽기 전용으로 확인하고 격리된 창에서 실제 마우스 이동·클릭과 키보드 입력을 보냅니다. hover 지연을 100ms로 설정하고 1.5초 동안 관찰해 요약 호버와 전체 카드가 분리되는지, 카드가 열린 동안 요약이 숨겨지는지, 반복 클릭으로 닫은 카드가 다시 열리지 않는지 검증합니다. 결과와 화면은 `test-results/statusbar-toggle.json`, `statusbar-toggle.png`에 기록합니다. 패치가 없는 설치에서는 `node scripts/test-statusbar-toggle.cjs --baseline`으로 클릭 시 카드가 닫힌 뒤 다시 생성되는 기존 버그를 재현하고 `statusbar-toggle-baseline.json`에 기록할 수 있습니다.

PR CI는 Windows·Linux·macOS, Node 22·24의 단위·통합 테스트와 Linux의 최소 지원 VS Code 1.101.0·stable 실제 확장 호스트 테스트를 구성했습니다. 버전 tag는 검증을 거쳐 VSIX artifact를 만들며 Marketplace 게시 단계는 포함하지 않습니다.

## 현재 제약

- 사용량 카드는 `StatusBarItem.tooltip`과 `MarkdownString`을 사용합니다. 클릭 토글에는 로컬 VS Code 패치가 필요하며 드래그 이동은 제공하지 않습니다. 카드의 위치·크기·테마는 VS Code가 결정합니다. 상태줄은 SVG 원본에서 만든 폰트 아이콘을 쓰며 단일 항목 전체에 밝은 테마는 검정, 어두운 테마는 흰색을 적용합니다. 막대는 남은 잔량을 표시하며, 숫자는 `display.percentage` 설정을 따릅니다. API 조사와 구현 지점은 [상태표시줄 팝업 문서](docs/StatusBarPopup.md)를 참고하세요.
- Claude OAuth usage는 비공개 endpoint입니다. 401이면 CLI가 보관한 credential을 한 번 다시 읽고, 계속 실패하면 CLI 재로그인을 안내합니다. refresh token을 직접 교체하지 않습니다.
- 로컬 JSONL은 제공자의 안정된 API 계약이 아닙니다. 확인할 수 없는 부모 관계나 요청은 임의로 합산하지 않고 Diagnostics에 표시합니다. fork 이력은 부모와 일치하는 순차 legacy prefix만 제외합니다.
- 로컬 Codex 실제 quota 조회와 조회 후 프로세스 종료를 확인했습니다. Claude 실제 조회는 인증 오류여서 Claude Code 재로그인 후 확인이 필요합니다. 실제 VS Code light/dark 테마의 탭·필터·표시 동작은 자동 검증하며, 화면 가독성과 원격 환경은 수동 검증 대상입니다. 자동 테스트는 합성 fixture와 대체 App Server 프로세스를 사용합니다.
- summary 메모리 benchmark는 Node host와 worker를 합친 process RSS입니다. quota benchmark는 child process를 별도 측정합니다. 기본 합성 실행 결과를 실제 Codex App Server의 메모리 수치로 해석하면 안 됩니다.

설계와 검증 항목은 [설계 명세](docs/AgentTracker.md), [CI/CD 계획](docs/CI-CD.md), [구현 기록](docs/Implementation.md)을 참고하세요.
