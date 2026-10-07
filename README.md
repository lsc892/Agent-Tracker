# Agent Tracker

Claude와 Codex의 구독 사용률, 로컬 대화 기록의 요청별 토큰 사용량을 보여 주는 VS Code 확장입니다.

- **Quota**: 하나의 상태 표시줄에 Claude·Codex 로고, 남은 잔량 막대, 사용률과 초기화 시각 표시
- **Usage**: 일·월·프로젝트·세션·사용자 요청별 합계와 평균, 제공자 오른쪽 토글로 도표와 표를 제공자별·모델별로 전환
- **Skill 통계**: 프로젝트·기간별 스킬·서브에이전트·플러그인·모델의 사용 횟수와 전체 대비 비율을 표시하고, 모든 표의 비율을 최다 사용 항목 기준의 상대 막대로 비교
- **API 비용**: 구독 사용은 0원, 충전 API는 모델·토큰별 추정 USD 비용을 저장해 확장 설정에서 표시 여부 선택
- **데이터 확인**: 통계 화면 맨 아래의 링크로 별도 Webview를 열어 파일 처리 상태, 오류 위치, 품질 경고·이전 정상 통계를 유지한 요청 표시

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
| `agentTracker.usage.skillsEnabled` | Skill 통계 집계 켜짐; AI가 선택한 호출도 포함 |
| `agentTracker.usage.showApiCosts` | API 추정 비용 표시 꺼짐 |
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
| `agentTracker.display.colorMode` | `automatic`; 자동·흰색·검은색·사용자 지정 |
| `agentTracker.display.customColor` | `#ffffff`; 사용자 지정 모드의 HEX 색상 |

확장 설정의 **Display: Color Mode**에서 상태 표시줄 색상을 선택합니다. 기본 **자동**은 2026 Dark·Light·고대비를 포함한 현재 테마와 작업공간의 상태 표시줄 색상을 따릅니다. **Display: Custom Color**에 `#abc`·`#aabbcc`·`#ffffffcc`처럼 입력하거나 설정 설명의 **색상 선택 열기**를 누른 뒤 색상 견본을 클릭해 고를 수 있습니다. 선택 화면은 HEX 입력·불투명도·미리 보기와 사용자/현재 작업공간 저장을 제공합니다. 적용하면 로고·잔량 막대·글자와 새로고침 버튼 색상이 즉시 바뀝니다.

Windows의 npm Codex 설치는 `.cmd` 옆 패키지에서 네이티브 실행 파일을 찾습니다. 다른 설치 방식이면 `.exe` 경로를 지정하세요. WSL·SSH·컨테이너에서는 확장이 실행되는 환경의 CLI·로그 경로를 사용합니다.

추적을 끈 제공자는 quota 조회·통계 수집을 중단하고 카드와 통계에서 숨깁니다. 기존 통계 데이터는 보관하며 다시 켜면 표시합니다. Claude는 추적이 켜져 있으면 상태 표시줄에 표시합니다. `codex.showStatusBar`는 Codex의 상태 표시줄만 숨기는 설정입니다. 자동 갱신은 Claude·Codex에 같은 간격을 적용하며 활성 창에서만 동작합니다. 창으로 돌아올 때 마지막 성공 조회가 5분 이상 지났거나 조회에 실패했다면 재시도합니다. 수동 정책은 시작 시에도 조회하지 않고 새로고침을 누를 때만 조회합니다.

`Usage: Enabled`를 끄면 진행 중인 통계 수집을 취소하고 통계 창을 닫습니다. 이 설정 아래의 **통계 계산 데이터 삭제** 링크 또는 같은 이름의 명령 팔레트 명령으로 파일 처리 정보(`manifest`)와 집계 결과(`turn_summary`)를 함께 비울 수 있습니다. 원본 대화 로그는 유지됩니다. 삭제 직후 재수집하지 않으며, 통계를 켜고 다시 열면 재계산합니다. 상태 표시줄 항목이 모두 숨겨져도 명령 팔레트의 **Agent Tracker: 설정 열기**에서 다시 설정할 수 있습니다.

## 데이터 처리

통계 기능이 켜져 있으면 활성화 시 SQLite schema만 준비합니다. quota는 추적 대상과 갱신 정책에 따라 조회합니다. JSONL 스캔은 사용량 통계에 진입하거나 열린 통계 창에서 Skill 집계를 다시 켤 때 시작합니다. quota 툴팁 표시·카운트다운·새로고침·상세/압축 변경, 통계 날짜·시간대·그룹·페이지 변경과 데이터 확인 링크 열기·다시 조회·페이지 이동은 스캔을 시작하지 않습니다. 비활성 창에서는 quota 자동 조회를 생략합니다.

**Usage: Skills Enabled**는 기본 ON입니다. 사용자가 스킬 이름을 지시했는지와 관계없이 AI가 호출한 스킬·서브에이전트·플러그인·모델 기록을 집계합니다. OFF에서는 새 횟수 집계와 Skill 표시를 멈추고 기존 요청의 저장된 횟수는 보존하며 토큰·API 비용·quota 기능을 유지합니다. 다시 ON으로 켜면 열린 통계 창에서 로그를 재계산하고, 통계 창이 닫혀 있으면 다음에 열 때 OFF 동안 생략한 기록을 복구합니다. 같은 기록을 다시 더하지 않으며 원본 로그가 남아 있는 범위를 대상으로 복구합니다.

SQLite는 확장 `globalStorageUri`의 `agent-tracker.sqlite`에 저장됩니다. 영속 테이블은 `manifest`, `projects`, `sessions`, `turn_summary`, `turn_model_usage`, `turn_costs`, `session_billing`입니다. 프로젝트명은 프로젝트당 한 번, 세션명은 제공자·세션 ID당 한 번 저장하고 요청별 통계에서는 ID로 연결합니다. 통계 창의 프로젝트명·세션명을 클릭하면 저장된 이름 목록이 열리고 스크롤해 선택하면 표·도표에 바로 적용됩니다. 목록은 날짜·표 페이지와 무관하며 현재 제공자 선택을 따릅니다. 프로젝트를 선택하면 해당 프로젝트의 세션을 표시하고, ‘전체 프로젝트’·‘전체 세션’으로 선택을 해제할 수 있습니다. 같은 이름의 세션도 각각 표시하며 제공자·프로젝트·시작 시각으로 구분합니다. 목록이나 표의 이름을 선택하면 해당 ID로 조회하며 전체 경로와 세션 ID는 이름에 마우스를 올려 확인할 수 있습니다.

**초기화**는 조회 단위·기간·제공자·프로젝트·세션·도표 지표·집계 기준과 페이지를 기본 상태로 돌립니다. 저장된 통계와 결제 방식은 유지됩니다. **제공자** 오른쪽의 **제공자별 / 모델별** 토글은 같은 조회 단위의 도표와 하단 표를 함께 전환하고 표의 첫 페이지부터 조회합니다. 모델별에서는 제공자 열이 모델 열로 바뀌고 도표·표에 `opus5.5`, `sonnet4.6` 같은 모델명을 바로 표시합니다. 모델명 앞의 네모는 Claude 주황·Codex 파랑이며 총 토큰 막대는 입력 파랑·출력 주황·캐시 저장 보라·캐시 재사용 초록으로 구분합니다. 총 토큰 도표 위에는 같은 색상의 `Input / Output / Cache Write / Cache Read` 범례를 표시하며 구성이 미확인인 막대가 있으면 회색 ‘구성 미확인’을 추가합니다. 다른 지표와 빈 결과에서는 범례를 숨깁니다. 실제 토큰이 있지만 모델을 확인할 수 없는 기록은 ‘모델 미상’, 모델 정보와 토큰 사용량이 없는 요청은 ‘사용량 기록 없음’으로 구분합니다. Claude의 0토큰 오류 안내인 `<synthetic>`은 모델 집계에서 제외하고 요청 상태와 오류 전에 사용한 토큰은 유지합니다. 이전 기록은 다음 통계 갱신에서 한 번 재집계합니다. 별도 누계 구역은 두지 않습니다.

확장 설정에서 **Usage: Show Api Costs** (`agentTracker.usage.showApiCosts`)를 켜면 토큰 통계 표에 비용을 표시합니다. 기본값은 꺼짐입니다. 구독은 0원이며, 충전 API는 [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing)·[OpenAI](https://developers.openai.com/api/docs/pricing)의 모델·토큰 표준 단가로 계산한 추정 비용(USD)입니다. 원본에 결제 방식이 없으면 비용을 미확인으로 표시합니다. 세션을 선택한 뒤 **선택한 세션의 결제 방식**에서 구독/API를 지정하면 세션 전체에 적용하고 DB에 저장합니다. 단가가 없는 모델은 미확인으로 남기며 실제 청구액·충전 잔액과 추가 요금은 포함하지 않습니다. 비용 설정·결제 방식 지정·초기화는 원본 스캔을 시작하지 않으며 초기화 후에도 비용 설정은 유지됩니다.

Claude의 자동·사용자 지정 제목과 Codex의 세션 목록·상태 DB 제목을 사용합니다. 제목이 없으면 ‘이름 없는 세션’으로 표시합니다. 변경된 세션은 원본 전체를 다시 읽어 중복 응답을 제거하고 교체하며, 변화가 없는 세션은 본문을 읽지 않습니다. Codex 제목만 바뀌면 이름만 갱신합니다. 하위 에이전트의 토큰은 부모 요청에 더하고 시간은 부모 요청 값만 사용합니다.

Codex 하위 에이전트 파일 전체에 `root_turn_id`가 없는 구형 로그는 해당 thread를 독립 대화로 집계합니다. 자체 요청·토큰·소요 시간을 사용하고 `standalone-subagent` 품질 표시를 남깁니다. 부모 원본과 일치하는 복제 이력은 중복에서 제외하며, 부모를 확인할 수 없는 이력은 임의로 차감하지 않습니다.

여러 창의 동시 갱신은 데이터·테이블이 없는 별도 `agent-tracker.sqlite.refresh-lock.sqlite` 파일의 SQLite 잠금으로 조정합니다. 프로세스가 비정상 종료되어도 잠금은 해제되며, 이 파일은 재사용하므로 실행 중 삭제하지 않습니다.

파일 목록과 응답 후보는 worker의 디스크 임시 테이블에서 처리합니다. 파일 metadata 묶음은 최대 256개, 조회 페이지는 100개, JSONL 한 줄은 기본 4 MiB로 제한합니다. 한도를 넘거나 형식을 해석할 수 없으면 진단을 남기고 기존 정상 통계를 유지합니다. 프롬프트·응답·tool 본문과 OAuth token은 DB에 저장하지 않습니다.

통계 화면 맨 아래에는 **데이터 확인** 링크만 표시합니다. 클릭하면 별도의 ‘Agent Tracker 데이터 확인’ Webview에 파일 처리 상태와 확인이 필요한 요청을 보여 줍니다. 이미 데이터 확인 창이 열려 있으면 해당 창을 표시하고 첫 페이지를 다시 조회합니다. 데이터 확인 창 열기와 **다시 조회**는 DB에 저장된 상태만 읽으며 원본 재검증·재집계는 하지 않습니다. 통계 갱신이 끝나면 열려 있는 데이터 확인 창도 갱신합니다. **확인이 필요한 요청**은 DB에 저장된 요청 중 품질 경고나 갱신 실패가 있는 목록으로, 경고만으로 통계에서 제외하지 않습니다. 갱신 실패 시 이전 정상 수치를 유지하며, 소요 시간이 없는 요청은 시간 평균의 표본에서 제외합니다. 새 파일을 처음부터 해석하지 못했다면 파일 오류만 기록되고 요청 통계는 만들 수 없습니다.

잘못된 시간대 설정은 화면에 안내하고 시스템 시간대로 조회합니다. 일·월 통계에서 시작 시각이 없는 요청은 날짜 필터를 적용해도 ‘시각 미상’ 그룹으로 표시합니다.

통계 표 위의 도표에서 총 토큰·요청 수·평균 토큰·평균 시간을 선택할 수 있습니다. 월간·프로젝트별을 포함해 Codex는 기존 파랑, Claude는 Claude 주황으로 표시합니다. 총 토큰 막대는 같은 제공자 색상의 명암으로 `Input / Output / Cache Write / Cache Read`를 쌓아 총량과 구성을 함께 표시합니다. 조각에 마우스를 올리면 해당 항목명과 토큰 수가 툴팁과 상세 정보에 표시됩니다. Input은 캐시를 제외한 값이며 구성이 미확인인 막대는 중립색으로 표시합니다. 막대 전체에 키보드로 초점을 옮기면 총량·구성과 평균 표본을 확인할 수 있습니다.

일·월별 도표는 선택한 전체 범위를 최대 30개 기간 구간으로 묶고 제공자별 막대를 나란히 표시합니다. 프로젝트·세션별은 선택한 지표의 상위 10개, 전체는 제공자별 합계, 사용자 요청별은 최근 60개 요청의 토큰·소요 시간을 표시합니다. 표 페이지를 이동해도 도표의 조회 범위는 유지되며 긴 도표는 가로 스크롤할 수 있습니다. 도표 지표 변경은 원본 로그를 다시 읽지 않습니다.

모델별 도표와 표는 같은 기간·프로젝트·세션 조건에서 모델별 토큰을 사용합니다. 도표는 상위 8개 모델 외에 제공자별 ‘기타 모델’로 합산하고 모델 미상·사용량 기록 없음은 별도로 유지합니다. 표는 모든 모델을 개별 집계해 100행씩 표시하며 토큰·요청 수·평균·API 비용을 모델별로 계산합니다. 여러 모델이 포함된 요청은 각 모델의 요청 수에 포함되며 시간은 해당 모델을 포함한 요청 전체의 시간입니다. Skill은 스킬·서브에이전트·플러그인·모델의 네 표와 하단 설명을 표시합니다. 모든 표에서 ‘전체 비율’ 숫자 옆 막대는 해당 분류의 최다 사용 항목을 가득 채우고 나머지를 상대 길이로 표시합니다. 페이지를 바꿔도 최다 항목 기준과 전체 비율의 분모는 유지됩니다.

## 검증

테스트 관련 코드는 `tests/` 아래에서 실행 역할에 따라 나눕니다.

```text
tests/
├─ node/          Node에서 실행하는 단위·통합 테스트
├─ vscode/        실제 VS Code 확장 호스트·마우스·키보드 검증
├─ fixtures/      합성 데이터·가짜 프로세스·화면 상태 준비
├─ runners/       테스트 파일 수집과 격리된 실행 환경 준비
├─ benchmarks/    성능·메모리 측정 도구
├─ .cache/        VS Code 프로필·다운로드·로컬 임시 검증 파일
└─ results/       보고서·스크린샷·benchmarks/ 측정 결과
```

`.cache/`와 `results/`는 실행 중 생성되며 Git에서 제외합니다. 타입 검사·린트·테스트 수집에서도 제외하고, `tests/` 전체는 VSIX에 포함하지 않습니다. `tools/`에는 로컬 VS Code 토글 패치의 적용·확인·복원 도구만 둡니다. 아이콘은 저장소에 포함된 SVG와 WOFF를 그대로 사용합니다.

```sh
npm run check       # 타입 검사, lint, fixture/worker/process/UI 연결 테스트
npm run test:vscode # 격리된 실제 VS Code에서 light/dark Webview 동작 검증
npm run test:toggle # 패치된 로컬 VS Code에서 실제 클릭·유지·닫기 검증
npm run benchmark   # 합성 파일 301개 + 큰 세션 2,000개 요청
npm run benchmark:quota # 합성 App Server 성공/오류/timeout/취소의 시간·메모리·종료 검증
```

대량 benchmark는 `BENCHMARK_FILES`, `BENCHMARK_TURNS` 환경 변수로 조절합니다. 결과는 `tests/results/benchmarks/summary.json`에 남으며 실제 개인 대화 기록은 사용하지 않습니다. quota 자원 측정 옵션과 한계는 [측정 안내](docs/QuotaBenchmark.md)를 참고하세요.

`test:vscode`는 별도 프로필과 합성 로그를 `tests/.cache/vscode/`에 만듭니다. Windows에서는 설치된 VS Code를 우선 사용하고, 그 외에는 테스트용 VS Code를 다운로드합니다. `VSCODE_TEST_VERSION`으로 다운로드 버전을, `VSCODE_EXECUTABLE`로 실행 파일을 지정할 수 있습니다. Linux의 화면 없는 환경에서는 `xvfb-run -a npm run test:vscode`를 실행합니다. 결과는 `tests/results/vscode-smoke.json`에 기록합니다.

`test:toggle`은 패치가 적용된 설치를 읽기 전용으로 확인하고 격리된 창에서 실제 마우스 이동·클릭과 키보드 입력을 보냅니다. hover 지연을 100ms로 설정하고 1.5초 동안 관찰해 요약 호버와 전체 카드가 분리되는지, 카드가 열린 동안 요약이 숨겨지는지, 반복 클릭으로 닫은 카드가 다시 열리지 않는지 검증합니다. 결과와 화면은 `tests/results/statusbar-toggle.json`, `statusbar-toggle.png`에 기록합니다. 패치가 없는 설치에서는 `node tests/vscode/statusbar-toggle.cjs --baseline`으로 클릭 시 카드가 닫힌 뒤 다시 생성되는 기존 버그를 재현하고 `statusbar-toggle-baseline.json`에 기록할 수 있습니다.

PR CI는 Windows·Linux·macOS, Node 22·24의 단위·통합 테스트와 Linux의 최소 지원 VS Code 1.101.0·stable 실제 확장 호스트 테스트를 구성했습니다. 버전 tag는 검증을 거쳐 VSIX artifact를 만들며 Marketplace 게시 단계는 포함하지 않습니다.

## 현재 제약

- 사용량 카드는 `StatusBarItem.tooltip`과 `MarkdownString`을 사용합니다. 클릭 토글에는 로컬 VS Code 패치가 필요하며 드래그 이동은 제공하지 않습니다. 카드의 위치·크기·테마는 VS Code가 결정합니다. 상태줄은 SVG 원본에서 만든 폰트 아이콘을 쓰며 기본 자동 색상은 VS Code 상태 표시줄 색상을 상속합니다. 흰색·검은색·사용자 지정은 사용량 항목 전체와 새로고침 버튼에 함께 적용합니다. 막대는 남은 잔량을 표시하며, 숫자는 `display.percentage` 설정을 따릅니다. API 조사와 구현 지점은 [상태표시줄 팝업 문서](docs/StatusBarPopup.md)를 참고하세요.
- Claude OAuth usage는 비공개 endpoint입니다. 401이면 CLI가 보관한 credential을 한 번 다시 읽고, 계속 실패하면 CLI 재로그인을 안내합니다. refresh token을 직접 교체하지 않습니다.
- 로컬 JSONL은 제공자의 안정된 API 계약이 아닙니다. 확인할 수 없는 부모 관계나 요청은 임의로 합산하지 않고 별도 데이터 확인 Webview에 표시합니다. fork 이력은 부모와 일치하는 순차 legacy prefix만 제외합니다.
- 로컬 Codex 실제 quota 조회와 조회 후 프로세스 종료를 확인했습니다. Claude 실제 조회는 인증 오류여서 Claude Code 재로그인 후 확인이 필요합니다. 실제 VS Code light/dark 테마의 필터·도표·데이터 확인 표시 동작은 자동 검증하며, 화면 가독성과 원격 환경은 수동 검증 대상입니다. 자동 테스트는 합성 fixture와 대체 App Server 프로세스를 사용합니다.
- summary 메모리 benchmark는 Node host와 worker를 합친 process RSS입니다. quota benchmark는 child process를 별도 측정합니다. 기본 합성 실행 결과를 실제 Codex App Server의 메모리 수치로 해석하면 안 됩니다.

설계와 검증 항목은 [설계 명세](docs/AgentTracker.md), [CI/CD 계획](docs/CI-CD.md), [구현 기록](docs/Implementation.md)을 참고하세요.
