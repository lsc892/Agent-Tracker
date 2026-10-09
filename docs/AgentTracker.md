# Agent Tracker 설계 명세

> 상태: 설계 기준 문서 · 첫 구현 진행 및 검증 현황은 [구현 기록](./Implementation.md) 참고
> 검증일: 2026-10-02
> 의사결정 이력: [Agent Tracker 일지](./AgentTracker-일지.md)

## 1. 목표

VS Code 확장으로 다음 두 기능을 제공한다.

1. Claude와 Codex의 현재 구독 quota 사용률과 reset 시각을 상태 표시줄에서 확인한다.
2. 로컬 JSONL 기록을 필요할 때만 SQLite에 반영하여 일·월·프로젝트·세션별 token 총량과 완료한 사용자 요청 turn별 평균 token 사용량·소요 시간, 제공자별·모델별 도표·표와 충전 API 추정 비용, 프로젝트·기간별 Skill 사용 횟수·비율을 조회한다.

핵심 설계 원칙은 다음과 같다.

- quota는 실시간성이 중요하므로 작은 최신 상태만 메모리에 유지한다.
- 과거 누계는 화면을 열거나 사용자가 새로 고침을 요청할 때만 manifest와 JSONL을 비교하는 lazy 방식으로 갱신한다.
- SQLite 영속 table은 manifest·projects·sessions·turn_summary와 모델·요금 정보를 담는 turn_model_usage·turn_costs·session_billing, Skill 사용 횟수를 담는 turn_capability_usage로 둔다. 표시 이름은 프로젝트·세션당 한 번 저장하고 요청별 통계는 식별자로 연결한다.
- subagent token은 부모의 사용자 요청에 합산하지만, 시간은 root/main turn의 경과 시간만 사용한다.

## 2. 전체 구조

```text
                    실시간 quota 경로

Claude OAuth usage adapter ─┐
                            ├─ QuotaService ── StatusBar Claude / Codex
Codex App Server ───────────┘       │
                                   └─ 클릭 토글 ── Markdown quota 카드

                    지연 누계 경로

Claude projects/**/*.jsonl ─┐
                            ├─ manifest diff ─ session 재집계 ─ SQLite
Codex sessions/**/*.jsonl ──┘                              │
                                                          └─ Webview 사용량 화면
```

두 경로는 분리한다. 상태 표시줄 quota 갱신이 JSONL 전체 통계 갱신을 유발해서는 안 된다.

현재 quota는 서버 조회 결과를 사용하고, 과거 token 통계는 manifest에서 변경 session을 찾아 요청·모델·비용 집계를 함께 갱신한다.

확장 대표 아이콘은 `package.json`의 `icon`에 지정한 `resource/icon/AgentTracker_Icon.png`를 사용한다. 같은 PNG를 VSIX에 포함해 VS Code 확장 목록과 상세 화면에 표시한다.

## 3. 기능 1: 실시간 quota 표시

### 3.1 Claude

구현 후보는 ClaudeCodeUsage가 사용하는 OAuth usage endpoint다.

```http
GET https://api.anthropic.com/api/oauth/usage
Authorization: Bearer <Claude OAuth access token>
```

다만 중요한 제약이 있다.

- 반면 위 `/api/oauth/usage` endpoint는 공개되고 안정성이 보장된 Platform API로 문서화되어 있지 않다.
- Claude Code 업데이트로 인증 위치나 응답 형식이 바뀔 수 있다.

따라서 endpoint 변경에 대비해 `ClaudeQuotaProvider`만 교체 가능한 adapter로 분리한다. 정상 UI에 전달하는 값은 각 quota window의 다음 세 가지뿐이다.

```text
현재 사용량
최대 사용량
초기화 시각
```

provider가 백분율만 반환하면 현재 사용량은 `usedPercent`, 최대 사용량은 `100%`로 표시한다. 조회 실패 시 마지막 성공 snapshot과 시각을 유지하고 오래된 값·갱신 실패 안내를 함께 표시한다. 성공 이력이 없거나 유지 기한이 지났으면 `조회 불가`로 표시한다.

보안 규칙:

- OAuth token을 SQLite, log, telemetry에 기록하지 않는다.
- token은 요청 직전 메모리에서만 사용하고 응답 후 참조를 폐기한다.
- credential 접근 실패 시 사용자에게 Claude Code 로그인을 안내하되 로그인 정보를 직접 요구하지 않는다.
- `401`은 credential refresh 경로를 한 번만 시도하고, 자동 조회의 `429`는 `Retry-After` 또는 지수 backoff를 따른다. 명시적인 수동 강제 조회의 예외는 3.3을 따른다.

### 3.2 Codex

Codex는 quota 조회가 필요할 때 `codex app-server`를 extension child process로 짧게 실행하고, 응답을 받은 뒤 종료한다. 기본 stdio JSONL transport를 사용한다. 초기안의 상주 process 재사용 대신 15분 기본 조회 주기에 맞춘 실행·조회·종료 방식을 채택한다.

```text
1. codex app-server 시작
2. initialize 요청
3. initialized notification
4. account/read로 인증 유형 확인
5. account/rateLimits/read 요청
6. 응답을 작은 in-memory snapshot으로 저장
7. stdin, readline, child process 정리 및 종료 확인
```

App Server는 `initialize` → `initialized` handshake 뒤에 요청을 받으며, stdio에서는 한 줄당 하나의 JSON-RPC 메시지를 사용한다.

위 메시지는 extension과 로컬 child process 사이의 통신이며 각각이 외부 HTTP 요청인 것은 아니다. quota 조회 command는 한 refresh당 `account/rateLimits/read` 한 번이다. token 갱신이나 재시도로 외부 요청이 추가될 수 있으므로 HTTP 호출 횟수를 항상 정확히 한 번이라고 보장하지 않는다. quota 조회를 위해 thread/turn을 만들거나 모델 추론을 실행하지 않는다.

요청:

```json
{"method":"account/rateLimits/read","id":6}
```

중요 응답 필드:

```text
rateLimitsByLimitId.*.primary.usedPercent
rateLimitsByLimitId.*.primary.windowDurationMins
rateLimitsByLimitId.*.primary.resetsAt
rateLimitsByLimitId.*.secondary
rateLimitReachedType
```

`resetsAt`은 Unix timestamp 초 단위다. `rateLimitsByLimitId`가 있으면 이를 우선하고, 없을 때만 backward-compatible `rateLimits`를 사용한다. window를 무조건 5시간과 7일이라고 가정하지 말고 `windowDurationMins`로 label을 만든다. account·plan에 따라 다른 window가 올 수 있다.

`account/read` 결과가 `apiKey`인 경우 ChatGPT 구독 quota가 없을 수 있다. `chatgpt` 계열 인증에서만 `account/rateLimits/read` 결과를 기대하고, API key rate limit과 구독 quota를 같은 것으로 표시하지 않는다.

App Server 생명주기:

- 최초·정기·복귀·수동 조회가 실제로 실행될 때만 process를 시작하며 조회 사이에는 유지하지 않는다.
- 제공자별 single-flight로 중복 process 생성을 막고 매 실행마다 handshake한다.
- 성공·오류·timeout·취소 모든 종료 경로에서 stdin, readline, child process를 정리하고 종료를 확인한다. extension deactivate도 진행 중인 process를 정리한다.
- 비정상 종료는 quota 조회 실패로 처리하고 3.3의 재시도 정책을 따른다. 조회할 일이 없을 때 process를 복구하기 위한 별도 상주 재시작 loop는 두지 않는다.
- stdout에는 protocol JSON만 받고 stderr는 민감정보를 제거한 진단 log로 제한한다.
- `account/rateLimits/updated`가 조회 중 도착하면 반영할 수 있지만 조회 사이에는 process가 없어 수신하지 않는다. 이 notification을 별도 터미널이나 다른 process의 전체 활동을 구독하는 기능으로 가정하지 않는다.

기본 15분 간격에서는 대기 중 process 메모리를 줄이는 이점을 선택하고 매번 시작·handshake하는 비용과 조회 사이 notification 미수신을 감수한다. 구현 시 실행 시간, peak 메모리, 실패·timeout 시 process 정리를 측정·검증한다.

### 3.3 refresh 정책

```text
extension activate
  └─ 최초 quota read (즉시 조회 생략 경로는 1초 뒤 활성 창에서 조회 시도)

조회 중 수신한 provider notification
  └─ 즉시 in-memory snapshot 갱신; 상주 notification 구독은 하지 않음

focused VS Code window
  └─ 제공자별 기본 15분 polling; 비활성·최소화·숨김 상태에서는 생략

window focus 복귀
  └─ 마지막 정상 조회가 5분 이상 지났으면 read; 최초 데이터가 없으면 조회 시도

복귀 시 조회 실패 상태
  └─ 실패 제공자별 30s → 1m → 2m → 4m → 8m → 최대 15m backoff

manual refresh
  └─ 선택한 제공자만 강제 read
```

여러 refresh 요청은 제공자별 single-flight로 합친다. 자동 요청은 실행 중인 조회에 합류하고, 수동 강제 요청은 `rerunRequested = true`로 묶어 현재 작업 종료 후 한 번만 더 실행한다. 명시적인 수동 강제 조회는 복귀 debounce 및 `Retry-After` 대기 게이트를 우회할 수 있다. 조회 중에는 버튼에 진행 상태를 표시하고 연속 클릭을 합친다.

복귀 실패 backoff는 복귀 이벤트의 재시도 허용 간격이며, 비활성 창에서 고빈도 재시도 timer를 실행한다는 뜻이 아니다. 성공하면 해당 제공자의 실패 횟수를 초기화한다. VS Code에서는 창 focus 상태를 기준으로 자동 조회를 제어한다.

자동 갱신 간격은 공통 설정 `agentTracker.quota.pollingIntervalSeconds`로 변경하며 추적 중인 Claude·Codex에 함께 적용한다. 기본값은 900초, 최소값은 30초이며 정기 조회 간격만 바꾼다. 복귀 5분 debounce와 제공자별 실패 backoff는 별도다. 일반 실패 snapshot은 마지막 성공 이후 최대 30분, `429` snapshot은 최대 24시간 유지하되 오래된 값임을 명시한다. reset countdown 표시 갱신은 네트워크 요청을 유발하지 않으며 reset 시각이 지났다고 사용률을 임의로 0으로 바꾸지 않는다.

### 3.4 상태 표시줄과 카드형 툴팁

상태 표시줄 오른쪽에 Claude·Codex 통합 사용량 항목과 새로고침 버튼을 배치한다. 통합 항목 안에서는 Claude가 왼쪽, Codex가 오른쪽이다. 로컬 VS Code에 클릭 전용 패치를 적용하면 사용량 항목 클릭으로 `StatusBarItem.tooltip`의 `MarkdownString` 카드를 바로 위에 열어 유지하고 재클릭으로 닫는다. 마우스를 올리거나 포커스만 주어서는 자동으로 열리지 않는다. 바깥 클릭이나 Esc로도 닫으며, 그 뒤 한 번 클릭으로 다시 열린다. 하단 quota 패널이나 별도 창은 만들지 않는다.

클릭 명령은 `agentTracker.toggleQuotaTooltip`이다. `tools/vscode/statusbar-toggle.cjs`가 Agent Tracker의 이 명령만 내부 `ToggleTooltipCommand` 객체로 변환한다. 공개 API의 기능은 아니므로 확장 설치·활성화와 패치 적용을 구분한다. 원본 백업과 복원 명령을 제공하며 VS Code 업데이트 뒤 재적용한다. 패치가 없는 설치에서는 기본 호버와 클릭 열기 경로를 사용한다.

`src/ui/quotaTooltip.ts`가 현재 snapshot으로 카드 내용을 만든다. 외부 label과 오류 메시지는 `appendText`로 이스케이프하고, 명령 링크는 필요한 명령만 `isTrusted.enabledCommands`에 허용한다. 위치와 스타일은 VS Code 기본 툴팁을 따른다. API 근거와 구현 상세는 [StatusBarPopup.md](StatusBarPopup.md)에 정리한다.

### 3.5 카드 내용과 설정

상태 표시줄 전경색은 확장 설정의 `agentTracker.display.colorMode`에서 자동(`automatic`, 기본)·흰색(`white`)·검은색(`black`)·사용자 지정(`custom`)을 선택한다. 자동은 `StatusBarItem.color`에 CSS 값 `inherit`를 지정해 현재 테마의 상태 표시줄 색상과 `workbench.colorCustomizations`, 작업공간의 기본 색상을 상속한다. VS Code는 이 값을 항목 label의 인라인 `style.color`에 반영하므로 마우스를 올렸을 때도 상태 표시줄의 전경색을 유지한다. 밝음/어두움만 보고 순백·검정을 지정하지 않으므로 2026 Dark의 기본 회색, 밝은 테마, 고대비·디버깅·폴더 없는 창의 색상도 VS Code가 결정한다. 흰색·검은색·사용자 지정은 검증한 HEX를 인라인 CSS 색상으로 고정하므로 테마가 바뀌어도 선택한 색상과 투명도를 유지한다. 로고·잔량 막대·문자는 하나의 항목이므로 같은 전경색을 사용하며 새로고침 버튼에도 같은 모드를 적용한다. [StatusBarItem API](https://code.visualstudio.com/api/references/vscode-api#StatusBarItem), [상태표시줄 테마 색상](https://code.visualstudio.com/api/references/theme-color#status-bar-colors), [VS Code의 인라인 색상 반영 구현](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/browser/parts/statusbar/statusbarItem.ts)

`agentTracker.display.customColor`는 `#RGB`·`#RGBA`·`#RRGGBB`·`#RRGGBBAA`를 받으며 짧은 값을 확장하고 투명도를 유지한다. 기본값은 `#ffffff`이고 사용자 지정 모드에서만 사용한다. 잘못된 HEX나 알 수 없는 모드는 테마 기본 색상으로 처리한다. 두 설정은 window scope로 사용자·작업공간에 저장하고 VS Code의 작업공간 우선순위를 따른다.

설정 설명의 `색상 선택 열기`와 명령 팔레트의 `Agent Tracker: 상태 표시줄 색상 선택`은 별도 색상 설정 Webview를 연다. 색상 견본을 클릭해 네이티브 색상 선택기를 사용하거나 HEX·불투명도를 편집하며, 편집 시 사용자 지정 모드로 전환한다. 적용 전 미리 보기와 사용자/현재 작업공간 저장 위치를 제공한다. 작업공간이 없으면 작업공간 저장을 허용하지 않는다. 저장·설정 변경은 상태 표시줄을 즉시 갱신하고 색상 선택 창을 닫아도 설정은 유지한다. 색상 조작은 quota 조회나 원본 통계 스캔을 시작하지 않는다. 카드의 위험도 막대 색상과 통계 도표의 항목 색상은 각각의 기존 의미를 따른다.

- Quota 카드: 제공자 이름 아래 5h·wk의 기간·색상 막대·사용률/남은 비율을 나란히 표시하고 각 열 바로 아래에 해당 초기화 카운트다운을 표시한다. 막대 너비는 초기화 문구의 추정 글자 너비를 96~160px로 제한한 뒤 80%로 줄이고 정수 픽셀로 반올림한 값에서 15px를 더 빼서 62~113px로 표시한다. 같은 제공자의 기본 기간은 가장 긴 문구를 기준으로 같은 너비를 사용한다. 마지막 열을 제외한 기간 행과 초기화 행에는 줄바꿈 없는 공백 세 칸을 추가한다. 추가 quota는 아래 줄에 초기화 정보와 함께 표시하며 해당 문구에 같은 막대 너비 기준을 적용한다. `codex.showReserve`는 기본 false로 `limitId` 또는 `limitName`이 `gpt-reserve`인 한도를 숨기며 다른 추가 한도는 유지한다. `base_model_inference` 식별자는 변경하지 않고 서버가 보낸 `gpt-reserve` 이름도 별도로 보존해 판별하므로 단일 한도의 기간만 표시할 때도 숨김이 적용된다. 막대의 색은 사용률 50% 미만 초록, 50% 이상 노랑, 80% 이상 빨강이다. 조회 중·오래된 값·갱신 실패 안내도 표시한다.
- 카드의 마지막 갱신: `사용량` 제목과 `상태 표시줄` 선택 사이에 한 번 표시한다. 추적 중인 제공자들의 가장 최근 성공 갱신 시각을 사용하고, 성공 이력이 없으면 `—`로 표시한다.
- Codex 재설정 안내: `account/rateLimits/read`의 `rateLimitResetCredits.availableCount`를 사용 가능한 횟수로 표시한다. 상세 항목 중 `resetType=codexRateLimits`, `status=available`인 항목의 가장 빠른 `expiresAt`을 다음 만료 시간으로 표시한다. 상세 목록은 서버에서 제한될 수 있으므로 항목 수로 횟수를 계산하지 않는다. 횟수·만료 정보를 받지 못한 경우 값을 추정하지 않는다. [응답 형식](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt)
  `codex.showResetCredits`는 기본 true이며 끄면 횟수와 만료 안내를 함께 숨긴다. Reserve·리셋권 표시 전환은 기존 snapshot만 다시 그리며 quota 조회와 JSONL 스캔을 시작하지 않는다.
- 카드의 새로고침 링크: 제목 행 오른쪽에서 추적 중인 제공자의 quota를 함께 수동 새로고침한다. 조회 중인 링크는 갱신 상태로 대체한다.
- 카드의 설정 링크: 사용량 통계 링크 아래에서 Agent Tracker 확장 설정 화면으로 이동한다.
- 카드의 상세/압축 링크: 상태 표시줄 표시량을 변경한다. 카드의 quota 기간은 항상 모두 표시한다.
- Usage: 일·월·프로젝트·세션별 token 총량과 완료 turn 평균 token·시간. 상세 통계 버튼으로 이동한다.
- Diagnostics: manifest와 turn summary의 현재 처리 상태, 중단 단계·위치와 오류. quota 조회 실패 상태도 확인한다.

| 범위 | 설정 | 기본값 |
|---|---|---|
| 공통 | 사용률 / 남은 비율 표시 | 사용률 |
| 공통 | 상태바 간략 / 상세 표시 | 상세 |
| Codex | 상태바 표시 / 숨김 | 표시 |
| 공통 | Claude·Codex 자동 갱신 간격 | 900초 |

상태바 압축 모드는 5시간 window만, 상세 모드는 7일·5시간 window를 표시한다. 5시간 window가 없으면 압축 상태바에 정보 없음으로 표시하고 장기 window로 대체하지 않는다. Quota 툴팁은 상태바 모드와 관계없이 모든 window를 표시한다. Claude는 추적이 켜져 있으면 상태바에 표시한다. Codex 상태바 숨김은 provider 비활성화와 구분하며 툴팁에서는 숨긴 Codex도 볼 수 있다. Claude 추적을 끄고 Codex 상태바도 숨기면 툴팁 진입점도 숨긴다. 표시 설정 변경은 기존 snapshot에 즉시 반영한다.

### 3.6 Codex App Server 사용

Codex quota는 `codex app-server`를 실행하고 `initialize` → `initialized` handshake 뒤 `account/read`와 `account/rateLimits/read`를 호출하여 조회한다. 응답에서 현재 사용량, 최대 사용량과 초기화 시각을 추출해 표시한다. 구체적인 process 생명주기와 응답 처리 규칙은 3.2를 따른다.

### 3.7 VS Code 설정 구역

Agent Tracker의 VS Code 설정은 다음 순서의 소제목과 목차 하위 구역으로 나눈다. 각 구역과 항목에 `order`를 지정하여 사용 여부·표시 방식부터 세부 값으로 이어지도록 배치한다.

| 구역 | 설정 항목 |
|---|---|
| 언어 | VS Code 언어 자동 선택, 한국어·영어·중국어 간체·일본어·스페인어·프랑스어 지정 |
| 추적 및 갱신 | Claude·Codex 추적, 구독 사용량 갱신 정책, 자동 갱신 간격 |
| 상태 표시줄 | Codex 표시 여부, 사용률·남은 비율, 상세·압축 표시, 색상 모드, 사용자 지정 색상 |
| 사용량 카드 | Codex GPT Reserve, 사용량 리셋권 표시 |
| 사용량 통계 | 통계 사용 여부, Skill 집계, API 추정 비용, 빈 사용량 제외, 시간대 |
| 데이터 및 로그 | 공통 상위 데이터 홈, Claude 로그 보존 기간, Codex CLI 실행 파일 |

`package.json`의 `contributes.configuration`을 여섯 카테고리의 배열로 등록한다. 설정은 총 20개이며 데이터 위치는 `agentTracker.dataHome` 하나로 지정한다. 카드·통계 화면·명령 팔레트의 설정 열기는 `@ext:agent-tracker.agent-tracker`로 필터링한 VS Code Settings를 연다. 카테고리·설명·선택지는 VS Code의 현재 표시 언어로 번역하며 비율의 사용률·남은 비율과 표시 방식의 압축·상세 선택지도 번역한다. 별도의 전체 설정 Webview는 제공하지 않는다. 설정 키·기본값·scope·입력 제약과 VS Code의 사용자·작업공간 저장 및 초기화 동작을 유지한다. 설정 화면을 여는 것만으로 quota 조회·원본 재집계를 실행하지 않는다. [VS Code 설정 카테고리와 정렬 규칙](https://code.visualstudio.com/api/references/contribution-points#contributesconfiguration)

### 3.8 표시 언어와 번역 리소스

통계의 시작일·종료일 입력칸은 표시 언어와 관계없이 `year-month-day`를 안내하고 `YYYY-MM-DD` 값을 사용한다. 직접 입력과 기본 달력 선택을 함께 제공하며 유효하지 않은 날짜는 조회하지 않는다.

`agentTracker.language`는 기본 `auto`로 VS Code 표시 언어를 따르며 여섯 언어를 명시적으로 지정할 수 있다. 확장의 실행 중 문구는 명시적 언어·VS Code 표시 언어·한국어 fallback 순서로 결정한다. 한국어 JSON을 원문과 번역 키의 기준으로 둔다. 상태 표시줄·카드·안내와 열린 통계·데이터 확인·색상 화면을 현재 언어로 다시 표시한다. 숫자·날짜도 언어를 따르며 집계 시간대·원본 이름·진단 코드는 보존한다. 언어 전환은 서버 조회나 원본 재집계를 유발하지 않는다.

기능별 키를 가진 언어별 JSON과 공통 i18next 계층을 사용한다. 언어 목록·번역 원본·`package.nls` 생성물은 루트의 `localization/`에 모으고 `localization/languages.json`에서 설정 선택지·manifest 번역·패키지 리소스를 생성한다. 실행용 JSON은 `dist/localization/`에서 읽는다. VS Code가 요구하는 루트의 `package.nls*.json`은 패키징·VS Code 테스트·F5 디버깅 동안만 복사하고 작업 뒤 원래 상태로 복원한다. 번역 키·변수·누락과 화면 코드의 한국어 문자열을 검사한다. 명령 팔레트·VS Code Settings의 카테고리·설명·선택지는 VS Code 표시 언어를 따르며 확장 Language 설정과 독립적이다. 기본 `package.nls.json`은 영어로 생성하고 한국어는 `package.nls.ko.json`으로 제공한다. 지원하지 않는 VS Code 언어의 정적 manifest 문구는 영어로 fallback한다. 추가 절차와 구현 근거는 [로컬라이징 문서](./research/Localization.md)에 기록한다.

## 4. 기능 2: 일·월·프로젝트·세션 총량과 turn 평균

### 4.1 lazy 갱신 정책

과거 누계는 Usage Webview를 열거나 사용자가 새로 고침을 요청하거나 열린 통계 창에서 Skill 집계를 다시 켤 때 갱신한다. 갱신 시 manifest와 현재 JSONL metadata를 비교하고, 새로 생기거나 변경되거나 삭제되거나 Skill 집계를 생략한 파일이 속한 session만 재집계한 뒤 조회 결과를 반환한다. Skill을 켜도 통계 창이 닫혀 있으면 다음 진입까지 스캔하지 않는다.

extension 시작과 상태 표시줄 quota 갱신은 과거 누계 갱신을 실행하지 않는다.

### 4.2 데이터 위치

`agentTracker.dataHome`은 Claude·Codex의 공통 상위 폴더이며 기본값은 `~`(사용자 홈)다. 빈 값도 사용자 홈으로 해석하고 `~/...`는 홈 아래의 폴더로 확장한다. 상대 경로는 작업공간과 무관하게 사용자 홈 기준으로 해석한다. `machine` scope의 사용자·원격 사용자 설정으로 전역 지정하며 작업공간·폴더 설정은 적용하지 않는다. 기기별 경로이므로 Settings Sync 대상에서도 제외한다. [VS Code 설정 scope](https://code.visualstudio.com/api/references/contribution-points#scope)

선택한 상위 폴더 아래에서 다음 경로만 사용한다.

```text
Claude: <dataHome>/.claude/projects/**/*.jsonl
Codex:  <dataHome>/.codex/sessions/**/*.jsonl
        <dataHome>/.codex/archived_sessions/**/*.jsonl
```

Claude credential·로그 보존 설정은 `<dataHome>/.claude`, Codex App Server의 `CODEX_HOME`·세션 제목 metadata는 `<dataHome>/.codex`를 사용한다. 기존 `claude.dataHome`·`codex.dataHome`·`usage.claudeRoots`·`usage.codexRoots` 설정은 등록·사용하지 않고 환경 변수 `CLAUDE_CONFIG_DIR`·`CODEX_HOME`도 확장의 경로를 덮어쓰지 않는다. 경로를 바꾸면 quota provider를 재생성하고 진행 중인 통계 수집과 열린 통계·진단 창을 정리하며 다음 통계 진입에서 새 로그 경로를 수집한다. 기존 원본과 통계 계산 데이터는 자동 이동·삭제하지 않는다. 로그 수집에서는 symlink directory, credential/config 파일, JSONL이 아닌 파일을 읽지 않는다.

### 4.3 manifest

영속 SQLite table은 `manifest`, `projects`, `sessions`, `turn_summary`, `turn_model_usage`, `turn_costs`, `session_billing`, `turn_capability_usage`로 둔다. manifest는 JSONL 파일마다 한 행, turn summary는 main과 subagent를 합친 외부 사용자 요청마다 한 행이다. 프로젝트명은 project_key당 한 행, 세션명은 (provider, session_id)당 한 행으로 저장하고 summary에는 식별자만 둔다. 요청의 모델별 토큰·추정 단가 결과는 turn_model_usage, 결제 방식에 따른 비용 합계는 turn_costs, 사용자가 지정한 세션 결제 방식은 session_billing, Skill 분류·이름별 횟수는 turn_capability_usage에 저장한다. agent별 실행 row와 response candidate는 영속화하지 않는다.

manifest 전체를 메모리에 적재하지 않는다. 파일 metadata 전수조사는 유지하되 발견·조회·비교는 최대 `n`개씩 처리한다. 진단용 정보는 상태·처리 위치·기록 시각·오류 네 column으로 제한한다.

```text
id                  // 내부 파일 식별자; 경로 이동에도 유지하며 디버깅에서 참조
provider            // 로그 제공자: claude 또는 codex
source_root         // 정규화된 소속 로그 루트; 삭제 판정 범위를 제한
path                // 정규화된 JSONL 파일 경로; provider와 함께 유일한 조회 key
session_id          // 마지막 정상 summary에 반영한 논리 session; 미처리는 NULL
size_bytes          // 마지막 정상 반영 시점에 읽기로 정한 파일 범위의 크기(byte)
mtime_ms            // 그 범위를 정할 때 확인한 파일 수정 시각(Unix epoch 밀리초); 변경 비교용
dev                 // 파일이 위치한 장치 식별자; inode와 함께 파일 동일성 판단
inode               // 장치 내 파일 식별자; 신뢰할 수 있을 때만 이동 감지에 사용
parser_version      // 마지막 정상 반영에 사용한 parser 버전; 다르면 해당 session 재집계
last_seen_scan_id   // 파일 존재를 마지막으로 확인한 scan ID; 파싱 성공 여부와 독립
processing_status   // processing / done / error / interrupted; 최근 시도의 상태
processing_position // 최근 단계와 위치를 담은 짧은 문자열; 예: parse: byte=8192
recorded_at         // 위 상태·위치·오류를 기록한 시각(UTC); 파일 수정 시각과 별개
last_error          // 최근 오류 원인; 정상 처리하면 NULL로 초기화
```

묶음 처리 규칙:

- 디렉터리는 iterator로 순회하고 전체 경로 목록을 만들지 않는다. `n`의 초기값은 256이며 metadata buffer의 byte 예산에 먼저 도달하면 더 작은 묶음으로 처리한다. 실제 값은 SQLite bind parameter 한도와 benchmark 결과에 맞춘다.
- 현재 묶음의 `(provider, path)`에 해당하는 manifest만 index로 조회한다. 경로가 없으면 신뢰 가능한 `(provider, dev, inode)`로 이동 후보를 조회하고, 후보가 여러 개면 이동 최적화를 사용하지 않는다.
- 이번 실행의 변경 파일·현재 session 귀속·영향 session 목록은 worker의 임시 디스크 staging에서 관리하고 종료 시 폐기한다. manifest에는 별도 재처리 대기 상태나 다음 실행의 작업 목록을 저장하지 않는다.
- 파일 본문은 스트리밍으로 읽고 parser/row buffer는 byte 예산으로 제한한다. 중복 제거·agent 연결·turn 합산도 임시 staging에서 수행한다. 한 session의 관련 파일은 page 단위로 조회한다.

분류 규칙:

```text
reused
  이전 정상 metadata와 path/identity, size, mtime, parser_version이 같고 최근 오류·중단이 없음
  → 방문 표시만 갱신; 해당 session에 다른 변경 파일도 없으면 body read 0 byte

append / modified / truncated / replaced
  size 또는 mtime 변화, identity 변경, parser_version 변경
  → 이번 실행에서 해당 session의 원본을 다시 집계하고 summary 교체

removed
  대상 로그 루트를 모두 순회한 뒤에도 이번 scan에서 방문하지 않음
  → 이번 실행에서만 삭제 대상으로 판정; 남은 session 원본 집계와 함께 manifest 삭제

new / previous error or interruption
  이전 정상 metadata가 없거나 최근 시도가 오류·중단으로 끝남
  → 사용자가 다시 열거나 새로 고침을 요청했을 때 해당 session을 다시 처리

moved
  path는 달라졌지만 신뢰 가능한 dev/inode가 동일
  → 같은 파일 id로 path와 source_root 갱신; 내용·session 귀속 변화는 별도 판정
```

Windows나 일부 filesystem에서 `dev/inode`가 `0`, 누락, 반복 충돌이면 이동 최적화를 사용하지 않고 `removed + new`로 처리한다.

agent 실행 중 조회는 읽기 시작 시 확인한 파일 크기까지 처리한다. JSONL 마지막 줄이 newline 없이 끝나면 보류한다. 완료 신호가 아직 없는 요청은 진행 중으로 표시한다. 이후의 순수 append는 다음 화면 진입·수동 새로 고침에 반영한다. 마지막 줄 보류와 실행 중 요청은 오류가 아니다.

response별 증분 상태를 영속화하지 않으므로 append도 tail만 더하지 않는다. 변경 없는 session은 재사용하고 변경 session은 전체 원본을 다시 읽는다. `processing_position`은 issue 보고용 진단 문자열이며 그 위치부터 자동으로 이어 처리하는 cursor가 아니다.

### 4.4 transaction과 오류 처리

누계 갱신은 Usage 화면 진입 또는 사용자 새로 고침으로 시작한다. 파일 조사와 방문 기록은 최대 n개씩 수행하고, 통계의 확정 단위는 논리 session이다. 하나의 session에는 main과 여러 subagent 파일이 함께 속할 수 있다. 파일의 session 귀속이 바뀌면 이전·새 session을 같은 반영 단위로 묶는다.

아래 절차는 각 문제에 대한 처리 기준이다. scan ID, 이번 실행의 대상 루트와 순회 완료 여부는 worker의 실행 상태로만 관리한다. 임시 작업 목록과 집계 결과는 디스크 staging에 두고 종료 시 폐기한다. 요청·모델·비용 결과와 이름·정상 metadata·삭제는 session transaction으로 함께 반영한다.

#### 4.4.1 파일과 집계 결과가 커져 메모리·DB 잠금이 늘어나는 문제

**문제 상황**: 파일 목록이나 한 session의 response·summary를 한꺼번에 적재하면 AI 사용량에 따라 메모리가 증가한다. 파일 파싱 전체를 write transaction 안에서 수행하면 다른 DB 쓰기도 오래 기다린다.

**처리 절차**:

1. 디렉터리를 iterator로 순회하고 metadata 발견·manifest 조회·방문 기록은 최대 n개씩 처리한다. 초기 n은 256이며 byte 예산에 먼저 도달하면 더 작은 묶음으로 처리한다.
2. session의 원본 파일 목록과 staging 결과도 page 단위로 읽는다. 파일 본문은 64 KiB씩 읽고 native LF 탐색으로 줄을 나눈다. 한 chunk에서 완성되고 줄 예산 이내이며 대소문자 구분 없는 `data:image/` 후보가 없는 줄은 바로 JSON.parse로 넘긴다. 이미지 후보·chunk에 걸친 줄은 문자열 상태를 유지하며 따옴표·역슬래시 위치를 캐시하고 연속 영역을 예산 내 block으로 복사한다. `data:image/...;base64,` 문자열은 헤더와 JSON 경계만 보존하고 이미지 본문은 버린다. 기본 4MiB 줄 예산은 보존하는 JSON에 적용하며, 오류 위치는 원래 파일의 byte offset을 사용한다. 버리는 문자열의 escape·제어 문자도 검증하고 newline 없는 마지막 줄은 보류한다.
3. 변경·삭제·session 귀속 목록, response 중복 제거와 agent 연결, turn 합산 결과는 임시 디스크 staging에 기록한다.
4. 다음 묶음은 현재 묶음의 처리가 진행된 만큼만 받아 대기열이 무제한으로 늘어나지 않도록 한다.
5. 파일 읽기·파싱·집계가 끝난 뒤 결과 반영에만 write transaction을 사용한다. 한 session의 결과를 여러 묶음으로 읽어 쓰더라도 COMMIT은 그 반영 단위가 완성됐을 때 수행한다.

**처리 결과**: n개는 메모리와 조회 묶음의 경계이며, session은 통계 확정의 경계다. 큰 session도 전체 결과를 메모리에 올리지 않고 처리한다. 대신 임시 디스크 I/O와 변경 session 원본 전체를 다시 읽는 비용이 발생하며, transaction 중에는 해당 session 결과의 DB 반영 비용이 남는다.

#### 4.4.2 파일의 session 귀속 변경으로 중복·누락이 생기는 문제

**문제 상황**: 이전 집계에서는 session A에 속했던 파일이 이번 해석에서는 B에 속할 수 있다. B에만 새로 더하면 A에 이전 기여가 남아 중복되고, A에서 먼저 제거한 뒤 B 처리가 실패하면 기여가 사라진다.

**처리 절차**:

1. manifest의 마지막 정상 `session_id`와 이번에 확인한 session_id를 비교한다.
2. 다르면 이전·새 session을 함께 영향 목록에 넣고 현재 원본 귀속은 임시 staging에서 관리한다. manifest의 정상 session_id를 먼저 바꾸지 않는다.
3. 현재 귀속을 기준으로 두 session의 summary를 모두 다시 계산한다.
4. 두 결과와 관련 manifest의 session_id·정상 metadata를 같은 transaction에서 교체한다. 어느 한쪽의 파싱·반영이 실패하면 두 session 모두 이전 정상 결과를 유지한다.

**처리 결과**: session 간 기여 이동이 함께 확정되어 중복·누락을 막는다. sessions는 표시 이름만 관리하고 귀속 변경 이력은 만들지 않는다.

#### 4.4.3 여러 창·화면의 갱신이 겹치는 문제

**문제 상황**: 여러 Webview나 VS Code 창이 같은 DB를 동시에 갱신하면 서로 다른 scan ID와 파일 관측 결과를 사용하게 된다. 한 작업이 통계를 저장하는 동안 다른 작업이 같은 session을 예전 관측 결과로 덮어쓸 수 있다.

**처리 절차**:

1. 같은 process에서 같은 DB의 누계 갱신 요청은 진행 중인 한 작업으로 합친다.
2. 여러 VS Code 창이 DB를 공유하면 process 간 lock을 획득한 작업만 갱신한다. 다른 창의 갱신은 lock이 해제될 때까지 대기한다.
3. lock은 파일 조사부터 삭제 판정·재집계·결과 반영·임시 작업 정리까지 갱신 전체에 적용한다. 각 session의 write transaction은 그 안에서 필요한 때만 연다.
4. 작업 종료·오류·정상 취소 시 lock을 해제한다.

**처리 결과**: 한 DB에 대한 조사·집계 작업이 직렬 실행된다. SQLite transaction은 한 반영 단위의 DB 변경을 보호하고, process 간 lock은 transaction 밖의 파일 조사·staging까지 포함한 갱신 순서를 보호한다.

#### 4.4.4 중단과 부분 성공을 전체 완료로 오인하는 문제

**문제 상황**: 폴더 조사 중 사용자가 취소할 수도 있고, 여러 session 중 일부만 저장한 뒤 종료될 수도 있다. 이때 모든 통계가 최신이라고 표시하면 실패한 session의 이전 값까지 새 결과로 오인하게 된다.

**처리 절차**:

1. 전체 순회를 끝내기 전에 접근 실패·취소·중단이 발생하면 삭제 판정과 session 교체를 시작하지 않고 기존 통계를 유지한다.
2. 재집계 도중 중단되면 이미 COMMIT한 session은 유지하고, 반영 중인 transaction은 취소한다. 미처리 session은 이전 통계를 유지한다.
3. 기록할 수 있는 경우 해당 시도의 상태를 `interrupted`로 남긴다. process가 비정상 종료되어 기록할 수 없으면 `processing`이 남을 수 있다.
4. 자동 복구나 offset 이어 처리는 실행하지 않는다. 다음 화면 진입·수동 새로 고침에서 새 scan ID로 처음부터 다시 조사한다. 그 조사에서 변경 없는 정상 session은 기존 summary를 재사용할 수 있다.
5. Usage는 갱신 중 기존 화면과 진행 상태를 유지하고 작업이 끝난 뒤 DB 결과를 다시 조회한다. 실패가 있으면 이전 정상값을 유지한 session과 오류를 함께 표시한다.

**처리 결과**: session A가 저장된 뒤 B에서 실패하면 A는 새 값, B는 이전 값으로 남고 B의 실패를 표시한다. refresh 전체를 한 번에 확정하는 원자성은 제공하지 않으며, session 또는 귀속 변경으로 함께 묶인 session 단위의 원자성만 제공한다.

## 5. provider별 JSONL 해석

JSONL은 provider 소유 형식이며 안정적인 공통 schema가 아니다. 먼저 `ClaudeParserAdapter`, `CodexCurrentParserAdapter`, `CodexLegacyParserAdapter`로 해석한 뒤 공통 row로 정규화한다.

여기서 공통 row와 agent 연결 정보는 재집계 중의 임시 자료다. 영속 결과는 사용자 요청 summary뿐이다. 복제·resume·archive 파일은 provider metadata와 검증된 parent/fork 관계로 같은 논리 session에 묶어 중복을 비교한다. session이나 부모 요청 귀속을 확인할 수 없는 파일은 임의로 새 사용자 요청으로 세지 않고 manifest 오류와 coverage로 표시한다.

### 5.1 Claude

#### session과 agent

```text
main file:
  ~/.claude/projects/<project>/<session-id>.jsonl

subagent file:
  ~/.claude/projects/<project>/<session-id>/subagents/.../agent-<agent-id>.jsonl
```

subagent transcript는 `agent-{agentId}.jsonl`로 별도 보존된다.

파싱 중의 내부 정규화:

```text
main:
  session_id = session id
  agent_id = session_id                 // main용 synthetic id
  agent_role = main

subagent:
  session_id = parent session id
  agent_id = Claude agentId
  agent_role = subagent
```

`agent_id`와 `agent_role`은 parser 내부에서 response 중복과 부모 사용자 요청을 구분할 때만 사용하며 영속 agent 실행 row를 만들지 않는다. 서브에이전트 생성 호출의 역할 이름은 Skill 통계의 집계 이름으로만 저장한다.

#### root turn

Claude Code v2.1.196 이상에서 `prompt_id`는 현재 처리 중인 사용자 prompt를 식별하는 UUID다.

JSONL에 `promptId`가 있으면 이를 `root_turn_id`로 우선 사용한다. usage-bearing assistant row에 `promptId`가 없을 수 있으므로 파일을 순서대로 읽으면서 현재 prompt context를 유지한다.

```text
외부 사용자 prompt row(promptId=P)
  → current_root_turn_id = P

뒤따르는 assistant/tool-result rows
  → P에 귀속
```

`type=user`만으로 새 turn을 만들면 안 된다. tool result도 user row로 기록될 수 있기 때문이다. `promptId`, `isMeta`, content type, prompt source를 함께 본다.

#### 과금 응답 중복 제거

Claude의 응답 identity:

```text
response_key = message.id + requestId
```

동일 response가 thinking/text, partial/final snapshot, transcript clone으로 반복될 수 있으므로 같은 key 중 네 bucket 합이 가장 큰 완전한 vector를 채택한다.

```text
input_tokens
+ cache_creation_input_tokens
+ cache_read_input_tokens
+ output_tokens
```

`requestId`가 빠진 row는 같은 `message.id`에 알려진 request ID가 정확히 하나일 때만 합친다. 후보가 여러 개면 추측하지 않고 `no-req` 임시 후보로 처리하며 summary에 품질 flag를 남긴다.

response candidate는 해당 session을 재집계하는 동안 임시 staging에서만 비교하고 winner의 token을 사용자 요청 summary에 합산한다. 후보는 영속화하지 않는다. winner가 있던 파일이 삭제되면 남은 session 원본 전체를 다시 읽어 차선 후보를 새로 선택하므로 별도 candidate table 없이 복구할 수 있다.

### 5.2 Codex current adapter

현재 로컬 Codex CLI 0.147.0 JSONL에서 다음 구조를 확인했다.

```text
type = token_usage_record
payload:
  session_id
  thread_id
  turn_id
  root_turn_id
  response_id
  usage
  turn_token_usage
  thread_token_usage
```

`usage`는 response별 증가량이고 `turn_token_usage`와 `thread_token_usage`는 누계 snapshot이다. 현재 adapter는 다음을 사용한다.

```text
response_key = session_id + thread_id + turn_id + response_id
tokens       = payload.usage
검산         = turn 마지막 Σ usage == 마지막 turn_token_usage
```

`turn_token_usage`와 `thread_token_usage`를 response마다 합산하면 누계를 반복해서 더하게 되므로 금지한다.

turn 시간은 현재 `task_complete.duration_ms`를 최우선으로 사용한다. `task_started`와 `task_complete`에는 `turn_id`가 있고, `task_started`에는 `root_turn_id`도 존재한다.

### 5.3 Codex legacy adapter

구형 로그에 `token_usage_record`가 없고 `event_msg/token_count`만 있으면 다음 순서로 해석한다.

1. `last_token_usage`가 있으면 해당 response의 정확한 사용량으로 사용한다.
2. 없으면 `total_token_usage`의 각 component에 대해 이전 high-water와의 양수 delta를 사용한다.
3. total/last 전체 숫자 vector signature가 같으면 replay로 보고 0 delta 처리한다.
4. counter가 감소하면 음수를 만들지 않고 `counter-regression` 품질 flag를 남긴다.

### 5.4 Codex session과 subagent

```text
session_id = session tree root id
agent_id = thread_id
agent_role = parent_thread_id가 없으면 main, 있으면 subagent
```

`thread.sessionId`는 live session tree의 root를 식별하고 fork/child thread는 별도 thread id를 가진다. parent/ancestor thread filter도 별도로 제공된다.

현재 JSONL의 `session_meta.parent_thread_id`, `forked_from_id`, `thread_source`와 turn의 `root_turn_id`를 우선 사용한다. 단순히 “내 turn id와 parent id가 다르다”는 조건으로 subagent를 판정하지 않는다.

파일의 첫 `session_meta`가 소유 thread를 정한다. fork 로그 안에 복제된 다른 thread의 부모 `session_meta`는 소유 식별자·프로젝트·lineage를 덮어쓰지 않는다. 같은 thread의 반복 metadata는 기존 부모·fork·프로젝트 정보를 유지하면서 제공된 제목 등을 갱신한다.

예외로, 파일 전체에 `root_turn_id`가 없는 구형 subagent는 `thread_id`를 독립 `session_id`로 사용하고 자체 `turn_id`로 요청을 구분한다. 요청 식별자가 없는 usage-only 기록은 thread에 하나의 안정적인 요청 id를 부여한다. 해당 thread의 token·시간을 자체 대화에 집계하고 `standalone-subagent` 품질 flag를 남긴다. 원래 부모·fork 정보는 복제 이력의 중복 검증에 사용하며, 명시적인 `root_turn_id`가 있는 subagent는 부모 요청 합산을 유지한다.

forked child가 부모의 token prefix를 복제한 구형 로그는 verified lineage prefix만 제외한다. 부모를 찾을 수 없으면 임의로 차감하지 않고 `missing-parent`를 표시한다.

## 6. turn 시간 계산

provider별 우선순위를 둔다.

### Claude

```text
1순위: system/subtype=turn_duration의 durationMs
2순위: root prompt 시작부터 대응 Stop/완료 marker까지 (`stop_hook_summary.preventedContinuation=false` 포함)
3순위: 마지막 root assistant timestamp - 최초 외부 user timestamp
```

`turn_duration`은 공개 transcript schema 계약이 아니고 버전에 따라 없을 수 있다. 없다고 parse 실패로 처리하지 않는다.

`stop_hook_summary`는 `preventedContinuation`이 명시적으로 `false`일 때 완료로 사용한다. `true`이면 이전 assistant의 `end_turn` 뒤에도 작업이 계속되므로 진행 중으로 되돌리고, 이어서 나오는 구간별 `turn_duration`으로 완료시키지 않는다. 해당 필드가 없으면 메시지 시각 fallback을 유지한다. `isApiErrorMessage=true`인 assistant는 정상 완료가 아닌 실패다. 실패 이후 같은 요청의 재시도가 성공하면 완료로 전환하며, root/main의 최신 상태 시각을 기준으로 판정한다. subagent 실패는 root 요청의 상태를 변경하지 않는다.

### Codex

```text
1순위: task_complete.duration_ms
2순위: task_complete.completed_at - task_started.started_at
3순위: task_complete timestamp - task_started timestamp
4순위: 마지막 agent message timestamp - user message timestamp
```

main/root의 최신 lifecycle 결과가 `turn_aborted`이면 완료되지 않은 대화로 보고 요청 summary를 저장하지 않으며 요청 목록·turn 수·token 총량·평균에서 제외한다. 중단 이전 누적 token 카운터는 이후 요청의 high-water delta 계산에 유지한다. 같은 root를 다시 시작해 완료한 경우 최신 결과로 판정하고, subagent의 중단은 완료한 main/root 요청을 제외시키지 않는다.

공통 품질 값:

```text
duration_source = explicit | lifecycle | message_span | unavailable
duration_quality = exact | derived | approximate | missing
```

### subagent 시간 집계

subagent 정보는 파싱 중 token 귀속을 확인할 때만 사용한다. subagent별 시간·실행 결과는 저장하지 않고 root 요청의 시간에는 main/root 값 하나만 반영한다.

```text
root_duration_ms = main/root turn의 duration_ms

root_total_tokens =
  main turn tokens
  + Σ descendant subagent turn tokens
```

병렬 subagent 시간이 중첩되므로 duration 합은 실제 사용자 대기 시간을 과장한다. main turn 완료 뒤에도 계속되는 background subagent 시간은 “사용자 요청 응답 시간”에서 의도적으로 제외한다.

## 7. token field 정규화

Anthropic과 OpenAI는 cache token 의미가 다르다.

- Anthropic: 총 input은 `input_tokens + cache_creation_input_tokens + cache_read_input_tokens`다.
- 현재 Codex: `total_tokens = input_tokens + output_tokens`이고 `cached_input_tokens`, `cache_write_input_tokens`는 input의 세부 항목이다.
- reasoning output은 output의 세부 항목이므로 총합에 다시 더하지 않는다.

parser 내부 공통 field는 다음 의미로 고정한다.

| Column | 의미 |
|---|---|
| `input_tokens` | cache를 포함한 정규화된 총 input |
| `uncached_input_tokens` | cache read/write가 아닌 input |
| `cache_write_input_tokens` | Claude cache creation / Codex cache write |
| `cache_read_input_tokens` | Claude cache read / Codex cached input |
| `output_tokens` | 총 output |
| `reasoning_output_tokens` | output 중 reasoning 부분집합 |
| `total_tokens` | `input_tokens + output_tokens` |

정규화 공식:

```text
Claude:
  input_tokens = raw.input_tokens
               + raw.cache_creation_input_tokens
               + raw.cache_read_input_tokens

  uncached_input_tokens = raw.input_tokens
  cache_write_input_tokens = raw.cache_creation_input_tokens
  cache_read_input_tokens = raw.cache_read_input_tokens

Codex:
  input_tokens = raw.input_tokens
  cache_write_input_tokens = raw.cache_write_input_tokens
  cache_read_input_tokens = raw.cached_input_tokens
  uncached_input_tokens = max(
    0,
    input_tokens - cache_write_input_tokens - cache_read_input_tokens
  )

Both:
  total_tokens = input_tokens + output_tokens
```

summary에는 `input_tokens`, `output_tokens`, `cache_write_input_tokens`, `cache_read_input_tokens`, `total_tokens`를 저장한다. 입력 총량은 cache를 포함하고, 화면의 Input은 cache read/write를 뺀 값이다. 공식 문서의 용어에 맞춰 화면에서는 `Input / Output / Cache Write / Cache Read` 순서로 표시한다. Claude의 cache creation과 Codex의 cache write는 Cache Write, Claude의 cache read와 Codex의 cached input은 Cache Read에 대응한다. [OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Claude Prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching).

schema v4는 이전 summary의 cache component를 NULL로 유지해 미확인 수치를 0으로 표시하지 않는다. parser version 변경으로 다음 조회 시 원본을 다시 집계하며, 일부 summary가 재계산되지 않은 집계에서는 cache 열과 Input을 —로 표시한다. reasoning은 output에 포함하며 별도 summary column으로 저장하지 않는다.

## 8. SQLite schema

DB 위치는 `ExtensionContext.globalStorageUri` 아래로 한다. 영속 table은 파일 처리 상태를 담는 `manifest`, 이름을 관리하는 `projects`·`sessions`, 조회 수치를 담는 `turn_summary`, 모델·비용 수치를 담는 `turn_model_usage`·`turn_costs`, 사용자가 지정한 결제 방식을 담는 `session_billing`, Skill 통계의 횟수를 담는 `turn_capability_usage`다. 전체 prompt·response·tool 본문, agent별 실행 결과, response candidate와 scan 이력은 저장하지 않는다. 사용자 요청 제목은 명시적인 UI 요구에 따라 최대 80자의 한 줄만 turn_summary에 저장한다. 세션 제목 metadata는 이름 테이블에만 저장한다.

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE manifest (
  id                  INTEGER PRIMARY KEY,                   -- 경로 이동에도 유지하는 내부 파일 id
  provider            TEXT NOT NULL,                          -- claude / codex
  source_root         TEXT NOT NULL,                          -- 정규화된 소속 로그 루트; 삭제 범위 구분
  path                TEXT NOT NULL,                          -- 정규화된 JSONL 파일 경로
  session_id          TEXT,                                   -- 마지막 정상 summary의 논리 session
  size_bytes          INTEGER NOT NULL DEFAULT 0,             -- 마지막 정상 반영에 사용한 읽기 범위 크기(byte)
  mtime_ms            INTEGER NOT NULL DEFAULT 0,             -- 읽기 범위를 정할 때의 파일 수정 시각(epoch ms)
  dev                 TEXT,                                   -- 장치 식별자; inode와 묶어서 비교
  inode               TEXT,                                   -- 장치 내 파일 식별자; 신뢰 가능한 경우 이동 감지
  parser_version      INTEGER NOT NULL DEFAULT 0,             -- 마지막 정상 반영한 parser 버전; 미처리는 0
  capabilities_collected INTEGER NOT NULL DEFAULT 0           -- Skill 횟수까지 정상 집계했으면 1; OFF 처리·이전 DB는 0
                        CHECK(capabilities_collected IN (0,1)),
  last_seen_scan_id   TEXT,                                   -- 마지막 존재 확인 scan ID; 파싱 실패에도 갱신
  processing_status   TEXT NOT NULL DEFAULT 'processing'      -- 최근 시도의 상태; 자동 재처리 대기 상태가 아님
                        CHECK(processing_status IN ('processing', 'done', 'error', 'interrupted')),
  processing_position TEXT,                                   -- 최근 단계와 위치; 예: parse: byte=8192
  recorded_at         TEXT NOT NULL,                          -- 상태·위치·오류를 기록한 시각(UTC)
  last_error          TEXT,                                   -- 최근 오류 원인; 정상 처리하면 NULL
  UNIQUE(provider, path)                                      -- 묶음별 파일 조회용 유일 key
);

CREATE INDEX idx_manifest_identity
  ON manifest(provider, dev, inode);                         -- Windows 제외: 전체 적재 없이 이동 후보 조회

CREATE INDEX idx_manifest_root_id
  ON manifest(provider, source_root, id);                    -- 루트별 미방문 파일을 id 순서로 조회

CREATE INDEX idx_manifest_session
  ON manifest(provider, session_id, id);                    -- 재집계할 session의 원본 파일 page 조회

CREATE TABLE projects (
  project_key        TEXT PRIMARY KEY,
  project_name       TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE sessions (
  provider           TEXT NOT NULL,
  session_id         TEXT NOT NULL,
  session_name       TEXT,                                    -- 제목이 없으면 NULL; 이름 중복 허용
  PRIMARY KEY(provider, session_id)
) WITHOUT ROWID;

CREATE TABLE turn_summary (
  id                 INTEGER PRIMARY KEY,                   -- 내부 summary id
  provider           TEXT NOT NULL,                          -- claude / codex
  project_key        TEXT NOT NULL REFERENCES projects(project_key), -- 프로젝트 집계용 경로 식별자
  session_id         TEXT NOT NULL,                          -- 대화 또는 session tree root의 논리 id
  root_turn_id       TEXT NOT NULL,                          -- 외부 사용자 요청 id; subagent까지 합산한 한 행
  started_at_ms      INTEGER,                                -- 요청 시작 시각(epoch ms); 알 수 없으면 NULL
  completed_at_ms    INTEGER,                                -- root 요청 종료 시각(epoch ms); 진행 중이면 NULL
  duration_ms        INTEGER CHECK(duration_ms >= 0),         -- main/root 경과 시간; 알 수 없으면 NULL
  duration_quality   TEXT NOT NULL                           -- 시간 값의 근거 품질
                       CHECK(duration_quality IN ('exact', 'derived', 'approximate', 'missing')),
  input_tokens       INTEGER NOT NULL CHECK(input_tokens >= 0),  -- cache를 포함한 정규화 input 합계
  output_tokens      INTEGER NOT NULL CHECK(output_tokens >= 0), -- 정규화 output 합계
  cache_write_input_tokens INTEGER CHECK(cache_write_input_tokens >= 0), -- 입력 중 캐시 생성; 이전 summary는 NULL
  cache_read_input_tokens INTEGER CHECK(cache_read_input_tokens >= 0), -- 입력 중 캐시 재사용; 이전 summary는 NULL
  total_tokens       INTEGER NOT NULL                        -- main + subagent의 중복 제거 후 총량
                       CHECK(total_tokens = input_tokens + output_tokens),
  status             TEXT NOT NULL                           -- 성공한 요청 / 진행 중 요청 / 실패한 요청
                       CHECK(status IN ('completed', 'in_progress', 'failed')),
  quality_flags      TEXT,                                   -- 누락·근사값 등 품질 경고 목록
  diagnostic_file_id INTEGER REFERENCES manifest(id)         -- 최근 문제 또는 확인할 원본 파일
                       ON DELETE SET NULL,
  diagnostic_offset  INTEGER,                                -- 해당 원본의 문제 byte 위치; 알 수 없으면 NULL
  last_error         TEXT,                                   -- 최근 summary 생성 문제; 수치 보존 시 이유 표시
  updated_at         TEXT NOT NULL,                          -- 이 summary를 마지막 정상 교체한 시각(UTC)
  UNIQUE(provider, session_id, root_turn_id),                 -- 사용자 요청당 한 행; agent row는 만들지 않음
  FOREIGN KEY(provider, session_id) REFERENCES sessions(provider, session_id)
);

CREATE INDEX idx_summary_period
  ON turn_summary(started_at_ms, provider);                  -- 날짜·월별 집계를 위한 시작 시각 범위 조회

CREATE INDEX idx_summary_project_period
  ON turn_summary(provider, project_key, started_at_ms);     -- 특정 provider·프로젝트의 날짜·월별 집계 조회

```

조회 인덱스는 날짜 범위와 provider·프로젝트·날짜 범위를 유지한다. 세션 조회·교체는 `UNIQUE(provider, session_id, root_turn_id)`의 앞 두 키를 사용하고 별도 `idx_summary_session`은 두지 않는다. 세션으로 좁힌 요청의 `id`순 페이지 조회에는 임시 정렬이 추가될 수 있지만, 주 사용처인 평균·프로젝트·월간 집계를 위해 중복 인덱스의 저장·쓰기 비용을 유지하지 않는다. 전체 이력의 평균·월별 집계는 대상 요청을 읽어 계산하며 평균용 인덱스·캐시·사전 집계는 추가하지 않는다. manifest의 루트·세션 인덱스는 증분 수집에 유지하고, 이동 탐지에 사용하는 identity 인덱스는 Windows에서 제거하며 Linux·macOS에서는 유지한다.

SQLite 조회 계획용 통계는 DB 열기에서 `PRAGMA main.optimize=0x10002`, 첫 스캔 완료와 이후 24시간 이상 지난 스캔 완료 및 연결 종료에서 `PRAGMA main.optimize`로 수집한다. `main`만 지정하여 TEMP 파싱 테이블은 분석하지 않는다. 새 인덱스 생성·기존 인덱스 정리 뒤에도 열기 시 통계 수집이 적용되며, 다른 운영체제에서 복사한 같은 schema version의 DB도 열 때 identity 인덱스를 현재 플랫폼에 맞춘다. 통계 수집은 선택적 유지보수여서 실패가 스캔·연결 정리를 실패시키지 않고 다음 실행 시점에 다시 시도한다. `PRAGMA optimize`는 평균 결과 캐시가 아니라 필요한 `ANALYZE`를 선택하는 SQLite 기능이다. [SQLite 권고](https://www.sqlite.org/lang_analyze.html).

표시 이름은 projects·sessions에만 저장한다. 이름에는 UNIQUE 제약을 두지 않는다. 이름이 같은 프로젝트는 project_key로, 같은 프로젝트 안의 같은 세션명도 (provider, session_id)로 구분한다. 조회 시 이름을 연결하고 집계 기준은 기존 ID를 유지한다. 이름을 찾지 못하면 ‘이름 없는 세션’으로 표시한다. 원본 제목을 사용하며 첫 prompt를 제목으로 복사하지 않는다.

Claude는 main JSONL의 custom-title을 ai-title보다 우선한다. Codex는 읽기 전용 state_N.sqlite의 threads.name/title을 session_index.jsonl의 thread_name보다 우선하고 session_meta 제목을 보완 경로로 사용한다. metadata는 디스크 TEMP에 묶음 처리하며 통계 화면 진입 시 제목만 바뀐 세션도 갱신한다. metadata를 읽을 수 없으면 기존 제목을 유지한다. 프로젝트명·세션명 필터는 클릭해 이름 목록을 열고 스크롤해 선택하는 방식으로 제공하며, 선택 즉시 표·도표를 ID와 제공자로 정확히 조회한다. 목록이나 세션별 행에는 프로젝트명과 세션 시작 시각을 함께 표시하고 tooltip으로 전체 경로·ID를 확인한다.

schema v1·v2는 기존 이름을 projects로 옮기고 요청 ID·통계·manifest 참조를 보존한 채 전환한다. 세션 제목은 다음 scan에서 채운다. 이름 metadata와 summary 교체는 같은 transaction에 반영하며, 참조하는 summary가 없어진 이름 행은 정리한다. `root_turn_id`는 요청 식별자다. schema v9에서 미사용 `turn_index` 컬럼과 순번 생성·저장 코드를 제거했으며, 현재 schema v10은 별도 세션 인덱스를 제거하고 Windows의 identity 인덱스도 제거한다. 기존 DB를 열 때 하나의 transaction에서 필요한 컬럼·인덱스만 정리하여 요청 ID·제목·시각·토큰·진단 참조와 모델·비용·Skill 횟수를 보존한다. 실패하면 컬럼·인덱스·schema version까지 원상 복구하며 이 전환 자체로 원본을 다시 스캔하지 않는다. 사용자 요청별 표는 DB 행 `id`순이고 모델별은 같은 요청 안에서 `model`순을 추가한다. 논리 session에 속하는 모든 파일을 읽어야 재집계할 수 있으므로 summary를 파일 하나의 자식 row로 두거나 삭제 cascade하지 않는다.

### 8.1 사용자에게 보여 줄 turn summary

한 행은 외부 사용자 요청 한 개다. main/subagent response를 중복 제거하고 token을 합산한 뒤 저장하며 duration은 main/root 값 하나만 저장한다.

| Column | 설명 |
|---|---|
| `provider` | `claude` 또는 `codex` |
| `project_name` | projects에서 조회한 표시 이름; 저장·집계 key는 `project_key` |
| `session_name` | sessions에서 조회한 표시 이름; 중복 허용 |
| `session_id` | 대화 session 또는 session tree root |
| `root_turn_id` | 사용자 요청 식별자 |
| `started_at_ms` | 요청 시작 시각; 일·월 귀속 기준 |
| `duration_ms` | main/root 요청의 경과 시간; 모르면 NULL |
| `duration_quality` | exact / derived / approximate / missing |
| `input_tokens` | main과 subagent를 합친 cache 포함 총 input |
| `cache_write_input_tokens` | 중복 제거 후 캐시 생성 입력 합계; 화면의 Cache Write |
| `cache_read_input_tokens` | 중복 제거 후 캐시 재사용 입력 합계; 화면의 Cache Read |
| `output_tokens` | main과 subagent를 합친 총 output |
| `total_tokens` | input + output |
| `status` | 완료 / 진행 중 / 실패; 완료 요청만 평균 계산 |
| `quality_flags` | 품질 경고; 상세 오류는 원본 파일·offset과 함께 표시 |

모델별 토큰 누계와 충전 API 추정 비용을 함께 제공한다. Skill 구역의 서브에이전트 역할별 생성 횟수 외에 agent별 토큰·시간 분석은 제공하지 않는다. cache component는 중복 제거한 response에서 저장·집계하고 reasoning은 output에 포함한다.

schema v5는 기존 요청·manifest·이름을 보존하며 다음 table을 추가한다.

| Table | 저장 단위와 내용 |
|---|---|
| `turn_model_usage` | `(turn_id, model)`별 input·output·cache write/read, `estimated_cost_usd`, `pricing_version`. 요청 참조 삭제 시 함께 삭제한다. |
| `turn_costs` | 요청별 `billing_mode`, nullable `cost_usd`, `unknown_costs`, `pricing_version`. 구독은 0, API는 확인한 모델 비용 합계, 미확인은 NULL이다. |
| `session_billing` | `(provider, session_id)`별 사용자가 지정한 구독/API/미확인 방식. 요청 재집계 후에도 유지하고 해당 세션이 사라지면 함께 삭제한다. |

Claude는 `message.model`, Codex는 usage record의 model 또는 해당 turn_context의 model을 사용한다. Claude의 0토큰 오류 안내(`isApiErrorMessage` 또는 `<synthetic>`)는 usage 후보에서 제외하고 요청 상태는 계속 처리한다. `<synthetic>`에 예상 밖의 양수 토큰이 있으면 모델 식별자만 미상으로 두고 토큰은 보존한다. response 중복 제거 후 main/subagent의 모델별 토큰을 합산하므로 모델별 합계는 요청·제공자 총량과 같다. 모델 정보가 없는 0토큰 snapshot은 모델별 행·횟수를 만들지 않으며 실제 모델명이 있는 0토큰 응답은 유지한다. 모델을 확인할 수 없는 양수 토큰은 별도 모델 미상 그룹으로 남기고 과거 모델을 추정하지 않는다. parser version 13은 다음 통계 갱신에서 변경 없는 원본도 한 번 재파싱해 이전 오류 안내 집계를 교체한다.

원본의 명시적 `billing_mode`·`auth_mode`만 결제 방식 근거로 사용하고, 현재 로그인 방식으로 과거 기록을 분류하지 않는다. 명시적 근거가 없거나 한 요청에서 서로 다른 방식이 섞이면 미확인으로 남긴다. 사용자는 통계 창에서 세션을 선택한 뒤 세션 전체의 결제 방식을 지정할 수 있으며, 이 선택은 원본 metadata보다 우선한다. 변경은 기존 창 간 refresh lock을 사용한 worker DB transaction으로 비용만 갱신하며 원본을 다시 읽지 않는다.

요금은 로컬 대화 기록의 모델·토큰을 [Anthropic 표준 단가](https://platform.claude.com/docs/en/about-claude/pricing)와 [OpenAI 표준 단가](https://developers.openai.com/api/docs/pricing)로 계산한 추정 USD 비용이다. 단가 버전은 `2026-10-07-standard-text`다. Input에서 cache write/read를 뺀 뒤 각 component를 한 번씩 계산한다. 미지원 모델·cache 구성·cache write 단가는 NULL로 남기고 확인한 비용과 미확인 건수를 함께 표시한다. 구독은 사용자의 지시에 따라 추가 사용 비용 0원이며 구독 결제액 자체를 합산하지 않는다. 실제 청구액·충전 잔액 조회, 로컬 기록에 없는 다른 API 호출, 도구 요금·할인·빠른 처리·긴 문맥·캐시 보관 기간별 추가 요금은 포함하지 않는다.

### 8.1.1 Skill 사용 횟수 저장과 조회

Skill 통계의 집계 대상·기간/비율 기준·분류별 사용 기준에 관한 부연설명은 네 분류 표·페이지 버튼 다음의 맨 아래에 표시한다. 별도 스킬 사용 횟수 도표와 분류·지표 선택은 표시하지 않는다.

통계를 `토큰 / Skill` 구역으로 전환한다. Skill은 스킬·서브에이전트·플러그인·모델을 각각 별도 표로 표시하고 토큰과 같은 제공자·프로젝트·세션·기간 필터를 사용한다. 토큰의 일·월별 조회 단위는 Skill 구역에서 숨기며, 선택 범위 전체의 횟수를 보여 준다. 기간은 요청 시작일 기준이고 날짜 필터가 있으면 시작 시각 미상 요청은 제외한다. 구역 선택은 Webview state에 보존한다.

Skill은 각 표 안의 비율 막대에서 상대 사용량을 표시한다. worker는 분류별 `chartRows`를 최대 20개씩 함께 반환해 표 페이지와 무관한 최다 사용 횟수 기준을 유지한다. 첫 표 페이지에서는 이미 조회한 행을 재사용하며 이후 페이지에서도 해당 분류 전체 횟수의 비율 분모를 유지한다. 빈 결과는 각 표에 기록 없음 안내를 표시한다. 이전 Webview state의 Skill 도표 분류·지표 값은 사용하지 않는다.

`agentTracker.usage.skillsEnabled`는 기본 true로 사용자 지시 여부와 관계없이 AI의 호출 기록을 포함한다. 지시·자율 여부를 프롬프트 본문으로 추정하거나 구분 저장하지 않는다. OFF에서는 진행 중인 수집을 취소하고 worker의 Skill 호출 인식·모델 응답 횟수 합산과 Skill 조회를 중단한다. 토큰·모델별 토큰·API 비용·quota 기능은 유지한다. Skill 화면은 기존 표를 비우고 OFF 안내와 설정 열기 버튼을 제공한다.

OFF 동안 토큰을 갱신할 때는 영향 session의 기존 요청별 Skill 횟수를 디스크 TEMP에 보존하고 같은 요청 식별자에 다시 연결한다. 사라진 요청은 기존 삭제 규칙을 따른다. schema v7은 manifest에 `capabilities_collected`를 추가하며 토큰만 처리한 파일은 0, Skill까지 처리한 파일은 1로 정상 metadata와 함께 저장한다. 이전 DB의 요청·토큰·비용·횟수는 유지하고 새 field는 0으로 둔다. ON으로 돌아오면 정상 파일도 이 값이 0이면 재파싱하여 원본에 남은 OFF 기간 호출을 복구한다. 집계를 교체하므로 이전 횟수에 중복 가산하지 않는다. 열린 통계 창은 즉시 갱신하고 닫힌 창에서는 다음 진입까지 기다린다. 설정 전환은 quota를 조회하지 않는다.

schema v6의 `turn_capability_usage`는 `(turn_id, category, name)`을 기본 키로 양수 `usage_count`를 저장한다. 요청 삭제 시 cascade하고 session 교체·원본 삭제·통계 계산 데이터 삭제에 함께 반영한다. 이전 DB의 요청·토큰·비용은 유지하며 parser version 12의 다음 갱신에서 원본을 한 번 재파싱한다. 호출 인자·명령·스킬 파일 경로·본문·호출 ID는 영속화하지 않는다.

| 분류 | 사용 1회의 기준과 표시 이름 |
|---|---|
| 스킬 | Claude `Skill`의 skill 이름 또는 `Read`·셸 읽기 호출의 `SKILL.md` 상위 폴더. 플러그인 cache 경로에서 소속을 확인하면 `plugin:skill`로 표시한다. |
| 서브에이전트 | Claude `Agent`·`Task`, Codex `spawn_agent`의 생성 호출. 명시적 `subagent_type`·`agent_type`별로 표시하고 없는 역할은 `default`로 둔다. 대기·메시지 전달은 생성 횟수에 더하지 않는다. |
| 플러그인 | 플러그인 스킬 호출·읽기 또는 `mcp__server__tool` 호출. 스킬은 확인한 플러그인 이름, 외부 도구는 MCP 서버 namespace를 이름으로 사용한다. 일반 도구 호출은 포함하지 않는다. |
| 모델 | 기존 token response 중복 제거 결과의 응답 수. main·descendant의 각 모델을 사용하고 실제 토큰이 있지만 모델이 없는 응답은 미상으로 표시한다. Claude의 0토큰 오류 안내와 모델 정보가 없는 0토큰 snapshot은 제외한다. 실제 모델명이 있는 0토큰 응답은 유지하며 구형 Codex는 중복 누계 snapshot을 제거한 사용량 event를 1회로 센다. |

Codex `response_item`의 function/custom tool 호출과 `exec` 안의 정적인 `tools.method(...)`를 읽는다. exec은 코드에 등장하는 호출마다 1회로 세므로 실제 조건·반복·중간 오류에 따른 실행 횟수는 복원하지 않는다. transcript의 JavaScript를 실행하지 않으며 지원하지 않는 동적 호출이나 원본에 없는 실행은 추측하지 않는다. 도구 출력·스킬 목록·검색·일반 본문 언급은 호출로 세지 않는다. tool call identity·thread·분류·이름으로 디스크 TEMP에서 중복 제거하고 요청별 이름·횟수만 합산한다. 검증된 fork prefix 안의 동일 호출은 제외하고 같은 root의 새 호출은 유지한다. 중단된 Codex root의 횟수는 token summary와 함께 제외하며, 재집계 실패 시 이전 정상 횟수를 유지한다.

각 표는 `(provider, name)`별로 미상 이름을 후순위에 두고 횟수 내림차순·제공자·이름순으로 100개씩 조회한다. 전체 횟수와 비율은 해당 분류의 필터 전체를 대상으로 계산한다. `비율 = 해당 행 사용 횟수 / 해당 분류 전체 사용 횟수 × 100`이며 페이지의 일부 행만 분모로 삼지 않는다. 모든 표의 ‘전체 비율’ 열은 숫자와 상대 막대를 함께 표시한다. 분류별 최다 사용 항목이 막대 전체를 채우며 `막대 길이 = 해당 행 사용 횟수 / 해당 분류의 최다 사용 횟수`다. 최댓값은 필터 전체의 이름별 횟수 집계에서 페이지와 독립적으로 조회하므로 미상 항목이 마지막 페이지에 있어도 유지한다. 막대는 Codex 파랑·Claude 주황이며 접근성 설명에 전체 비율·횟수와 최다 사용 대비 비율을 포함한다. 각 분류의 페이지는 독립적이고 조회 조건을 바꾸면 모두 첫 페이지로 돌아간다. 구역 전환·필터·페이지 이동은 worker DB만 조회하며 원본 스캔을 시작하지 않는다.

### 8.2 일·월·프로젝트·session별 총량과 turn 평균

모든 조회 단위는 선택한 제공자·프로젝트·세션·기간 조건으로 조회하고, 그 결과에서 모델 미상·시각 미상인 행을 후순위로 정렬한 뒤 페이지를 나눈다. 모델별의 빈 문자열과 null은 모두 미상으로 취급하며, 시각 미상은 일·월의 기간과 요청별 시작 시각에 적용한다. 같은 우선순위 안에서는 기존 정렬을 유지하고 요청 통계는 DB 행 id순을 사용한다. 도표도 같은 페이지를 사용하며 날짜·프로젝트·세션 묶음을 유지한 채 같은 묶음의 미상 모델을 마지막 막대로 표시한다. 시각 미상 기간과 미상 모델만 있는 묶음은 뒤쪽에 배치한다. 전체·사용자 요청별 도표는 미상 행을 뒤쪽에 표시한다. 필터·집계 값과 빈 사용량 제외 정책은 유지한다.

`claude.cleanupPeriodDays`는 기본 null로 기존 Claude 설정을 유지한다. 사용자가 1 이상의 정수 일수를 입력하면 설정한 Claude 데이터 홈의 `settings.json`에서 `cleanupPeriodDays`만 바꾸고 다른 키를 보존한다. 임시 파일을 원자적으로 교체하며 JSON 해석 실패·동시 변경·권한 오류에서는 원본을 덮어쓰지 않고 제어된 오류 안내를 표시한다. null로 돌리면 Claude에 반영한 값은 유지하고 이후 쓰기를 중단한다. 확장 시작과 기간·데이터 홈 설정 변경 시 반영하며 원본 로그를 직접 삭제하거나 통계를 스캔하지 않는다. 실제 정리는 Claude Code가 수행한다. [설정 근거](https://code.claude.com/docs/en/settings-reference#cleanupperioddays).

조회 조건 옆 `초기화`는 토큰 구역, 조회 단위 일별, 기간 제한 없음, 제공자·프로젝트·세션 전체, 표·Skill 분류별 첫 페이지, 토큰 도표 총 토큰·제공자별 집계로 즉시 조회한다. 열린 이름 목록과 저장된 통계 구역·조회 단위·도표 선택도 초기화한다. DB 기록과 세션 결제 방식, 확장 설정의 API 비용 표시 여부는 유지한다.

제공자 필터 바로 오른쪽의 `제공자별 / 모델별` 토글은 도표와 하단 표의 집계 기준을 함께 바꾸며 별도 누계 구역은 표시하지 않는다. `chartBy`는 Webview state에 보존하고 worker의 도표·표·표 행 수 조회에 적용한다. 기준 전환 시 표의 첫 페이지로 돌아간다. 모델별 표는 제공자 열을 모델 열로 바꾸며 사용자 요청별은 모델/프로젝트 열로 표시한다. 도표·표에는 제공자 이름을 앞세우지 않고 모델명을 직접 표시하며 Claude의 `claude-opus-5-5` 같은 식별자는 `opus5.5` 형식으로 줄인다. 원본 모델 식별자는 DB와 집계 키에서 유지한다.

모델별 도표와 표는 `turn_model_usage`와 요청을 연결한 같은 모델별 토큰 원천을 사용한다. 모델을 확인할 수 없는 기록은 모두 ‘미상’으로 표시한다. 내부의 `model=null`은 모델·토큰 기록 없음, 빈 문자열은 실제 토큰의 모델 미상으로 구분하며 제공자별 조회는 model field를 생략한다. `usage.excludeEmptyUsage`는 기본 true이며 모델 정보와 토큰 사용량이 모두 없는 요청만 도표 전체와 평균·시간 표본에서 제외한다. 하단 표의 행·전체/완료 요청 수·토큰 총량은 유지한다. 확인된 모델의 0토큰 기록과 모델 미상의 양수 토큰은 포함한다. Extension Host가 설정을 조회에 적용하며 설정 변경은 저장된 DB만 조회한다. 표는 조회 단위별 `(provider,model,기간/프로젝트/세션)`으로 모든 모델을 개별 집계하며 사용자 요청별은 `(요청,model)` 행을 100개씩 표시한다. 도표는 현재 표 페이지의 모델을 개별 표시하고 미상도 같은 페이지 경계를 따른다. 빈 사용량은 페이지 선택 후 도표에서 제외하며 다음 페이지의 항목을 앞당겨 채우지 않는다. 여러 모델을 사용한 요청은 각 모델의 요청 수에 포함되며 모델별 평균 토큰은 해당 모델의 완료 요청별 토큰, 평균 시간은 해당 모델을 포함한 완료 요청 전체의 시간이다.

사용자 요청별 표는 순번 없이 요청 제목과 세션명을 표시하고, 도표 축에는 짧은 제목·시작 시각을 표시한다. 제목이 없으면 세션명, 둘 다 없으면 ‘제목 없음’을 표시한다. 툴팁·상세 정보·접근성 설명에도 `요청 N` 순번을 표시하지 않으며 원래 요청 ID는 보존한다. schema v8의 `request_title`은 원본 사용자 메시지에서 추출한 최대 80자의 한 줄이며 이미지·도구 출력·응답 본문은 포함하지 않는다. 프로젝트·세션별 도표는 각 대상을 가로 축에 나란히 놓고 같은 대상의 모델 막대를 묶는다. 기간·프로젝트·세션과 요청/세션 셀은 최대 5줄로 표시하고 넘치는 내용은 말줄임표로 접는다. 원래 이름·요청 제목·식별자는 마우스 안내에 보존하고 이름 선택 동작을 유지한다. Windows의 drive·UNC 프로젝트 경로는 구분자를 정규화하고 대소문자를 통일하여 같은 경로가 프로젝트·모델 행으로 중복되지 않게 한다. POSIX 경로의 대소문자는 구분한다. parser version 13은 기존 원본을 다음 통계 진입에서 한 번 재집계하여 이전 경로와 요청 제목을 반영한다.

`agentTracker.usage.showApiCosts`는 확장 설정의 boolean이며 기본 false다. 켜면 여섯 조회 단위의 토큰 표에 비용 열과 세션 결제 방식·추정 안내를 표시한다. Extension Host가 설정을 조회 조건의 `includeCosts`에 적용하고 Webview의 개별 비용 요청으로 덮어쓰지 않는다. 비용 표시 여부는 설정 state로 전달하며 Webview state에는 저장하지 않는다. 설정 변경·필터·초기화·결제 방식 지정은 원본 재스캔 없이 저장된 DB만 조회·갱신한다.

수치는 제공자별에서는 `turn_summary`, 모델별에서는 `turn_model_usage`를 연결한 요청·모델 행에 filter와 `GROUP BY`를 적용해 조회하고 이름은 projects·sessions에서 연결한다. 이름 목록에서 선택한 project_key·session_id·provider로 조회하므로 중복 제목이 합쳐지지 않는다. 일·월은 configured timezone의 시작·끝 경계를 UTC millisecond로 변환한 뒤 `started_at_ms`에 적용한다. 한 요청의 token과 duration은 시작 시점의 일·월에 귀속하고 날짜 경계에서 나누지 않는다. timezone 변경은 조회 경계를 바꾸며 원본 재파싱은 요구하지 않는다.

이름 목록은 통계가 저장된 전체 프로젝트·세션을 대상으로 하고 날짜·표 페이지·선택된 세션 조건을 적용하지 않는다. 활성 제공자와 제공자 필터를 따르며 세션 목록에는 선택된 프로젝트 조건만 추가한다. 프로젝트는 project_key당 한 항목, 세션은 provider·project_key·session_id당 한 항목으로 이름순 정렬한다. 목록을 열 때 worker가 100개씩 조회하고 아래로 스크롤하면 다음 묶음을 표시한다. Extension Host는 한 묶음만 전달하고 Webview는 열린 목록의 이름 metadata만 누적하며 닫으면 해제한다. 선택은 표의 첫 페이지부터 적용하고 ‘전체 프로젝트’·‘전체 세션’으로 해제한다. 프로젝트를 바꾸면 기존 세션 선택을 해제하며 세션을 고르면 프로젝트·제공자도 맞춘다. 목록 조회와 선택은 원본 재스캔을 시작하지 않는다.

```sql
SELECT
  provider,
  project_key,
  session_id,
  SUM(total_tokens) AS total_tokens,
  COUNT(*) AS turn_count,
  SUM(CASE WHEN status = 'completed' THEN total_tokens END) * 1.0
    / NULLIF(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0)
      AS avg_tokens_per_turn,
  AVG(CASE WHEN status = 'completed' THEN duration_ms END)
      AS avg_duration_ms,
  COUNT(CASE WHEN status = 'completed' AND duration_ms IS NOT NULL THEN 1 END)
      AS turns_with_duration
FROM turn_summary
WHERE started_at_ms >= :period_start_ms
  AND started_at_ms < :period_end_ms
GROUP BY provider, project_key, session_id;
```

위 예시는 기간 내 project/session별 조회다. 전체·일·월·project·session 조회는 필요한 filter와 grouping만 선택한다. token 총량에는 진행 중·실패한 요청에서 확인한 값도 포함하되 `turn_aborted`로 중단된 Codex root 요청은 제외한다. turn 평균 token·시간은 성공적으로 완료한 요청만 대상으로 한다. duration 누락은 0으로 채우지 않고 평균에서 제외하며 유효 시간 표본 수를 함께 표시한다. 시각을 알 수 없는 요청은 전체/project/session 총량에는 포함하되 일·월 조회에서는 '시각 미상'으로 별도 표시한다. 일·월별 표는 제공자·모델과 관계없이 시각 미상 행을 전체 결과의 끝으로 정렬한 뒤 페이지를 나눈다.

schema version 2는 기존 `turn_summary`의 행·id·manifest 참조를 보존하며 `failed` 상태를 추가한다. parser version 4는 변경되지 않은 원본도 다음 통계 갱신에서 재파싱해 기존 시간과 실패 분류를 보정한다.

### 8.3 사용량 도표

사용량 통계 표 위의 총 토큰·평균 토큰 도표는 `Input / Output / Cache Write / Cache Read`를 각각 VS Code 테마의 파랑·주황·보라·초록으로 구분해 쌓은 누적 막대로 표시한다. 제공자에 관계없이 같은 토큰 항목은 같은 색상을 사용하며 모든 구간은 불투명하게 표시한다. 도표 위의 토큰 구성 범례는 이 순서의 이름과 막대에 적용한 색상을 함께 표시하고 좁은 화면에서는 줄바꿈한다. 구성이 미확인인 막대가 있으면 회색 ‘구성 미확인’을 범례에 추가한다. 제공자별·모델별의 총 토큰·평균 토큰 도표에서 같은 범례를 사용하며, 평균 시간·요청 수와 빈 결과에서는 범례를 비우고 숨긴다. 총 토큰 막대는 항목별 총량, 평균 토큰 막대는 항목별 완료 요청 평균을 쌓는다. Input은 cache read/write를 제외한 화면 표시 값을 사용한다. 별도의 ‘토큰 구성’ 지표는 두지 않는다.

월간·프로젝트별을 포함한 모든 조회 단위에서 모델별 도표와 토큰 표의 모델명 앞에 8px 정사각형을 표시한다. Claude는 주황 `#d97757`, Codex는 기존 VS Code 테마 파랑이며 미상 모델에도 해당 제공자 색상을 사용한다. 도표의 정사각형은 세로 막대의 회전된 모델명과 함께 배치하고 가로 막대에서는 모델명 왼쪽에 둔다. 모델명의 접근성 설명과 표의 마우스 안내로 제공자도 확인할 수 있다. 평균 시간·요청 수는 기존 테마 파랑 단일 막대를 사용한다. 각 토큰 조각에 마우스를 올리면 해당 항목명·토큰 수 또는 평균과 조회 대상이 SVG 툴팁과 상세 정보에 표시된다. 조각을 벗어나거나 막대 전체에 키보드 초점을 옮기면 전체 값·구성을 표시한다. 이 동작은 렌더링된 값으로 처리하고 worker 조회나 원본 재스캔을 시작하지 않는다. 구성이 미확인인 경우 전체 값을 중립색 막대로 표시하고 ‘총 토큰 (구성 미확인)’ 또는 ‘평균 토큰 (구성 미확인)’을 안내하며 미확인 항목을 0으로 채우거나 임의로 배분하지 않는다.

도표는 기존 필터와 집계 기준을 공유하고 `총 토큰 / 평균 토큰 / 평균 시간 / 요청 수` 순서로 지표를 선택한다. 요청 수는 완료·진행 중·실패 요청을 합친 전체 요청 수이며 완료 수를 상세 정보에 함께 표시한다. 평균 토큰은 완료 요청 수, 평균 시간은 유효한 시간을 가진 완료 요청 수를 표본으로 사용한다. 사용자 요청별 조회에서는 `총 토큰 / 소요 시간`만 선택하고 각 요청의 개별 값을 표시한다.

평균 토큰의 input/output/cache 평균은 합계 평균과 같은 완료 요청 표본에서 SQL로 계산하며 빈 사용량 제외 설정도 동일하게 적용한다. 캐시 구성은 표본 중 한 요청이라도 미확인 값이 있으면 해당 평균을 null로 보존해 막대 전체를 회색으로 표시한다. 진행 중·실패 요청의 미확인 구성은 평균에 영향을 주지 않는다. 완료 표본이 없으면 평균을 ‘—’로 표시하고 막대를 그리지 않으며, 확인된 0토큰 평균은 0으로 표시한다. 새 DB 열이나 원본 재집계 없이 저장된 요청·모델 행을 사용한다.

조회 단위에 따라 다음 모양과 범위를 사용한다.

| 조회 단위 | 표현과 범위 |
|---|---|
| 일·월 | 현재 표 페이지의 기간을 합치지 않고 세로 막대로 표시하며 같은 기간의 제공자·모델을 나란히 배치한다. 시각 미상은 현재 페이지에 있을 때 맨 오른쪽에 표시한다. |
| 프로젝트 | 현재 표 페이지의 프로젝트를 가로 축에 나란히 배치하고 같은 프로젝트의 모델 막대를 묶는다. 모든 도표 지표에서 같은 배치를 사용한다. |
| 세션 | 현재 표 페이지의 세션을 가로 축에 나란히 배치하고 토큰 구성은 세로 막대에 쌓는다. 같은 세션의 모델 막대는 묶고 세션명·프로젝트명을 표시한다. |
| 전체 | 현재 표 페이지의 제공자별·모델별 가로 막대. |
| 사용자 요청 | 현재 표 페이지의 요청·모델 행을 표 순서의 세로 막대로 표시하고 순번 없이 짧은 요청 제목·시작 시각을 명시한다. |

worker는 조회한 표 페이지의 행을 재사용해 도표를 만들며 모든 조회 단위·집계 기준·지표에서 같은 100행 경계를 사용한다. 예를 들어 표의 1–100행과 101–200행은 각각 해당 행으로 도표를 구성한다. 별도 상위 항목·최근 요청 제한, 기간 묶음과 기타 모델 합산은 사용하지 않는다. 빈 사용량 제외 설정은 페이지 선택 후 적용하되 표의 행·총량·요청 수와 페이지 범위는 유지한다. 도표의 요청 수·완료 수는 빈 사용량 제외 후의 집계이며 평균은 해당 표 행의 완료 요청 표본을 그대로 사용한다. 도표 아래와 표 아래에 같은 범위·이전/다음 버튼을 표시하고 양쪽 버튼이 같은 페이지를 이동한다. 긴 도표는 해당 영역 안에서 가로 스크롤하며 같은 대상의 모델 수에 맞춰 폭을 확보하고 모델 이름을 막대 아래에 표시한다. 막대의 호버·키보드 초점으로 정확한 수치·구성·평균 표본을 표시하며 외부 도표 라이브러리는 사용하지 않는다.

## 9. 데이터 확인 화면

별도 diagnostics table이나 처리 이력 table은 만들지 않는다. 기본 통계에는 품질 표시를 붙이고, 사용량 통계 화면 맨 아래에는 `데이터 확인` 하이퍼링크만 표시한다. 링크를 클릭하면 별도의 `Agent Tracker 데이터 확인` Webview에서 다음 현재 상태를 조회한다. 이미 열려 있는 데이터 확인 Webview는 다시 표시하고 첫 페이지부터 조회한다. 데이터 확인은 제공자 추적 설정을 따르며, 창 열기·`다시 조회`·페이지 이동은 저장된 DB 결과만 읽고 원본 스캔·검증·재집계를 시작하지 않는다. 통계 갱신이 끝나면 열려 있는 데이터 확인 Webview도 갱신한다. 통계 기능을 끄거나 제공자 구성이 바뀌면 두 Webview를 함께 닫는다.

| 대상 | 표시할 정보 |
|---|---|
| manifest | 제공자·원본 경로·session과 진단 네 항목: 상태, 처리 단계·위치, 기록 시각, 오류 |
| turn summary | project·session·사용자 요청 id, 마지막 정상 갱신 시각, 품질 경고, 문제 원본 파일·offset·원인 |
| 실행 중 worker | 현재 scan/재집계 진행 상태와 중단 원인; 파일에 연결할 수 없는 루트 접근 오류도 여기에 표시 |

진단은 사용자의 issue 보고를 위한 최근 기록이다. 처리 위치 문자열을 자동 재개 지점으로 사용하지 않고, 전체 시도 이력·agent 실행 내역·response 본문도 보관하지 않는다. 이전 정상 summary를 유지한 session은 해당 실패를 표시하여 최신 값으로 오인하지 않게 한다.

`확인이 필요한 요청`은 `turn_summary`에 저장된 요청 중 `last_error` 또는 비어 있지 않은 `quality_flags`가 있는 목록이다. 경고만으로 통계에서 제외하지 않으며, 재집계 실패 시 이전 정상 summary를 통계에 유지한다. 소요 시간이 없는 요청은 시간 평균의 표본에서 제외하고, 중단된 Codex 요청은 기존 집계 규칙에 따라 저장·집계하지 않는다. 새 파일의 첫 파싱이 실패해 정상 summary가 없다면 manifest에 파일 오류만 기록된다. 원본 재검증은 다음 사용량 통계 화면 진입에서 수행하고, 변경 없는 정상 session은 본문을 다시 읽지 않고 재사용한다.

manifest의 processing_status = done은 이번 통계 처리가 끝났다는 뜻이다. agent의 대화 요청 완료 여부는 turn_summary.status로 구분하므로 실행 중인 요청도 정상적으로 조회할 수 있다.

## 10. 메모리와 성능

Extension Host 메모리에 유지하는 값:

- Claude/Codex 최신 quota snapshot
- 진행 중인 single-flight 상태
- 사용량·데이터 확인 Webview마다 현재 보이는 제한된 한 page의 row
- worker가 보내는 작은 진행 상태와 현재 조회 page·제한된 제공자별·모델별 도표 결과

누계 worker는 최대 `n`개 파일의 metadata·manifest diff와 byte 예산 내 parser/정규화 row buffer만 유지한다. 변경 session의 중복 제거·연결·합산 작업은 디스크 staging에 기록하고 session 교체 후 폐기한다. 한 session이 커도 파일 목록·response 후보·summary를 메모리에 한꺼번에 올리지 않는다. 디렉터리 순회·파싱·DB 반영 사이에는 backpressure를 적용하여 다음 묶음이 무제한 대기열에 쌓이지 않게 한다.

메모리에 유지하지 않는 값:

- 전체 JSONL 본문
- 전체 prompt/response/tool content
- 모든 기간의 materialized aggregate map
- 전체 파일 경로 목록과 전체 manifest map
- 전체 변경 파일의 파싱 결과 및 전체 삭제 대상 목록

파일 수를 `F`, 한 파일의 metadata 크기를 `S`, 순회 상태 크기를 `D`, 처리 중인 JSONL 한 줄 크기를 `L`, row buffer 예산을 `R`, DB cache 예산을 `C`라고 하면 작업 메모리의 관리 대상은 `n × S + D + L + R + C`다. 파일 수가 늘어도 전체 manifest 때문에 `F × S`만큼 증가하지 않도록 한다. `n`만 제한해도 한 줄이나 DB cache는 커질 수 있으므로 큰 JSONL 줄 처리 방식과 SQLite cache·임시 작업의 메모리도 별도로 측정·제한한다.

SQLite query는 기간과 project/session filter를 먼저 적용하고 turn_summary는 page 단위로 가져온다. 기본 page size는 100으로 한다.

요청 제목은 component 재집계 때 `component_events(root_id,id) WHERE is_main=1 AND request_title IS NOT NULL` TEMP partial index로 탐색한다. provider·session 조건을 유지하며 가장 먼저 기록된 메인 제목을 선택한다. 인덱스는 component 테이블 재생성·staging 종료 시 사라지고 영속 DB에는 추가하지 않는다. 별도 JS 제목 Map을 만들지 않으며 준비된 요청도 100행씩 읽는다. `prepareSummaries`는 영속 교체 transaction 전에 실행하고 실제 `replaceSessions`의 BEGIN IMMEDIATE/COMMIT 구간과 별도로 측정한다. FILE TEMP는 page cache를 사용하므로 전체 process 메모리의 고정 상한으로 해석하지 않는다. 제목 탐색의 복잡도 모델과 실제 고정 원본의 구현 전후 transaction 기록은 [측정 보고서](RequestTitleTransactions.md)에 둔다.

SQLite 자체보다 주의할 부분은 VS Code extension 배포 방식이다.

- native SQLite binding은 OS/architecture/Electron ABI별 packaging이 필요하다.
- 동기 binding을 Extension Host에서 대량 실행하면 UI를 막을 수 있다.
- WASM SQLite는 배포는 쉽지만 DB page cache가 JS/WASM memory에 더 올라갈 수 있다.

권장 구현은 **worker thread 안의 native SQLite binding**이다. MVP에서 지원 OS를 좁힐 수 없다면 prebuilt binary 제공 여부를 먼저 검증한다.

### 10.1 자원 비용 계산과 실측 기준

15분마다 짧게 실행하는 App Server의 시간 평균 추가 메모리는 다음으로 비교한다. Extension Host·Webview 등 공통 비용은 제외하고 동일한 계정·실행 환경·조회 주기를 기준으로 측정한다.

```text
평균 추가 메모리 ≈ 실행 중 평균 child process 메모리 × 실행 시간 / 900초
```

설명용 가정으로 실행 중 평균 100 MiB, 실행 시간 2초이면 평균 추가 메모리는 약 0.22 MiB다. 실행 순간에는 100 MiB를 차지하며 이는 실측값이 아니다. peak RSS, 시간 평균 RSS와 CPU 시간을 서로 다른 지표로 기록한다. 8시간의 기본 15분 주기는 약 32회의 실행이며 최초·복귀·수동 조회 및 실패 재시도로 횟수가 추가될 수 있다.

파일 수를 F, 전체 본문을 B, 영향 session의 현재 원본 합계를 B_affected라 하면 읽기 단계의 기준은 metadata 전수조사 O(F)와 session 재집계 O(B_affected)다. 이름 metadata 조회 비용도 별도로 발생한다. append가 1 MiB여도 해당 session 원본이 200 MiB라면 약 200 MiB를 다시 읽는다. 변경 byte만 읽는 O(ΔB)나 전체 스캔 대비 고정 배수의 속도 개선을 주장하지 않는다.

구현 후 필요한 비교 항목:

- App Server: cold/warm 시작·handshake 시간, 전체 조회 지연, token 갱신 시 추가 지연, CPU 시간, child peak/평균 RSS, 정상·timeout·취소 후 잔여 process 여부.
- JSONL: 파일 수·전체 byte·변경 byte·영향 session 원본 byte, metadata 확인 시간, 실제 body read byte, metadata 묶음과 session 교체의 commit 시간, staging disk 사용량, 삭제 판정·재집계 시간, worker peak RSS, 작업 후 Extension Host에 남는 집계·snapshot 크기. `n`과 byte 예산을 고정한 상태에서 파일 수 증가 및 큰 파일 하나가 peak RSS에 미치는 영향을 따로 비교한다.
- 조건: 최초 구축, 변경 없음, append, truncate/replace, 삭제, 계정 변경, WSL 등 실제 지원 환경을 구분한다. 기능과 데이터 크기가 다른 worker와 App Server의 RSS 숫자만 단독 비교하지 않는다.
- 정확도: 같은 계정의 서버 quota와 JSONL 관측값의 값·시각을 비교한다. 과거 token 집계는 full rebuild와 증분 결과를 비교하며 이를 서버 quota 일치 검증으로 대신하지 않는다.

SQLite 사용 자체가 고정 메모리를 보장하지 않는다. worker의 discovery 목록·중복 검증 작업량·DB page cache도 측정하고, corpus 전체를 host에 반환하지 않도록 batch/page 경계를 지킨다.

JSONL reader는 바이트별 JS 처리 대신 일반 줄의 직접 파싱과 연속 Buffer 구간 처리를 사용한다. 읽은 원본 byte N에 대한 시간 O(N), chunk C와 보관 줄 한도 K에 대한 reader 보조 공간 O(C + min(L,K))는 유지한다. 이미지 검사에는 C 이내의 임시 Latin-1 문자열을 사용하며, row 객체·adapter·DB 메모리는 별도다. 파싱의 규모는 JSONL 행 수·원본/보관 byte·최대 줄 크기로 비교한다. 동일한 RAM 입력으로 I/O·adapter·DB를 제외한 적용 전후 브랜치 측정은 [파싱 전용 보고서](JsonlParsingBranches-2026-10-09.md)에 둔다. 이전 reader+adapter 및 전체 갱신 측정은 [기존 트레이드오프 보고서](JsonlReaderTradeoff.md)에 원본 그대로 보존한다. parser version과 집계 결과를 유지하므로 이 최적화만으로 정상 파일 전체를 강제 재파싱하지 않는다.

## 11. 검증 및 시뮬레이션

### 11.1 로컬 형식 검증

사용자 환경에서 본문을 출력하지 않고 최신 파일의 구조만 검사했다.

- Claude: 최신 12개 파일의 usage row 1,495개에서 `message.id + requestId` 중복 identity group이 562개였다. Claude dedup은 실제로 필요하다.
- Claude: 검사한 전체 30개 파일에는 `turn_duration` row가 없었다. 따라서 `turn_duration`만 믿는 시간 계산은 실패한다.
- Claude: user row는 `promptId`를 가지고 있었고, 한 promptId가 tool-result를 포함한 여러 user row에 반복되었다. `type=user`가 아니라 promptId로 root 요청을 묶어야 한다.
- Codex CLI 0.147.0: 최신 12개 파일에서 `token_usage_record` 451개와 turn group 47개를 확인했다.
- Codex: 47개 turn 모두 `Σ payload.usage == 마지막 payload.turn_token_usage`가 성립했다.
- Codex: 검사 범위에서 response identity 중복은 0개였지만 parser의 response identity 검증은 재생·복제에 대비해 유지한다.
- Codex: `task_complete.duration_ms`, `turn_id`, `root_turn_id`, `parent_thread_id`가 존재했다.

이 결과는 현재 로컬 버전의 관찰값이지 provider의 영구 schema 보장은 아니다. parser adapter와 `parser_version`이 필요한 이유다.

### 11.2 중복과 subagent 예시

입력:

```text
main r1 partial  = 1,000 tokens
main r1 final    = 1,200 tokens  // 같은 response key, winner
main r2          =   300 tokens
subagent A       =   400 tokens, 8초
subagent B       =   600 tokens, 7초
main/root time   = 10초
```

결과:

```text
main tokens       = 1,200 + 300 = 1,500
subagent tokens   = 400 + 600   = 1,000
root total tokens = 2,500
root duration     = 10초

잘못된 duration 합 = 10 + 8 + 7 = 25초
```

### 11.3 cache 정규화 예시

Claude:

```text
raw input=100, cache creation=300, cache read=600, output=50
normalized input=1,000
total=1,050
```

Codex:

```text
raw input=1,000, cached input=600, output=100, reasoning output=40
normalized input=1,000
total=1,100
```

Codex total을 `input + cached + output`으로 계산하면 cache를 이중 집계하므로 잘못이다. reasoning 40도 output 100에 포함된 부분집합이므로 다시 더하지 않는다.

### 11.4 manifest 변경 예시

다른 session과 중복이 없는 예시다. T는 DB query의 결과이며 메모리 전역 누계를 유지하지 않는다.

```text
초기 DB 합계 T = 10,000
session S의 전체 기여량 = 1,500

S의 파일에 append +200:
  S의 main/subagent 원본 전체를 다시 읽고 dedup
  S의 summary 전체 교체 → T = 10,200

S의 파일 truncate 후 session 기여량이 900:
  S의 현재 원본 전체 재집계
  S의 summary 전체 교체 → T = 10,200 - 1,700 + 900 = 9,400

S의 마지막 파일 삭제:
  전체 순회 후 부재 확인
  S의 summary 삭제와 관련 manifest 삭제를 함께 commit
  T = 9,400 - 900 = 8,500

S 파일 중 하나 파싱 실패:
  기존 S summary와 정상 metadata 유지
  manifest에 processing_status / processing_position / recorded_at / last_error 기록
  같은 실행에서 자동 재시도하지 않음
```

중복 winner 파일이 삭제되었어도 남은 원본에서 후보를 다시 비교한다. 따라서 파일별 기여량을 단순 차감하지 않고 session 전체를 재집계한다.

## 12. 실패와 품질 표시

데이터가 애매할 때 임의로 정확한 값처럼 만들지 않는다.

```text
missing-request-id
missing-root-turn
missing-parent-agent
counter-regression
component-clamped
duration-missing
duration-approximate
partial-line
parse-error
unsupported-schema
```

Webview는 기간 합계와 함께 다음 coverage를 표시한다.

```text
files discovered / parsed / failed
turns exact / approximate / missing duration
processing / error / interrupted files with recorded position and time
summaries with source error / stale values
last successful session update
```

## 13. 구현 순서

각 기능을 구현할 때 fixture 기반 테스트를 함께 작성한다. 상세 검증 항목과 자동 실행·패키징 정책은 [CI/CD 계획](./CI-CD.md)에서 관리한다.

1. VS Code extension scaffold와 StatusBar/Webview command
2. `QuotaService`와 provider adapter interface
3. 짧은 Codex App Server 실행, handshake, account/read, rateLimits read, 모든 경로의 종료 처리
4. Claude quota adapter와 조회 실패 fallback
5. SQLite worker와 migration
6. 묶음 manifest scanner, scan ID 기반 부재 판정과 실행 중 임시 작업 목록
7. Claude parser/dedup/root prompt mapping
8. Codex current parser와 legacy fallback
9. 임시 staging에서 사용자 요청 합산, session 단위 turn_summary 교체
10. 일·월·프로젝트·세션 총량 및 turn 평균 Webview, 파일·summary 디버깅
11. GitHub Actions CI 연결과 릴리스 VSIX 패키징; 대용량 benchmark는 정기·수동 workflow로 실행

## 14. 완료 조건

- extension 활성화만으로 JSONL 전체 scan이 발생하지 않는다.
- 조회 중 provider notification은 수신 즉시 반영하고 활성 창의 정기 조회는 제공자별 기본 15분 간격으로 수행한다. 조회 사이 Codex App Server는 상주하지 않는다.
- 상태바 사용량 항목 안에서 Claude는 왼쪽, Codex는 오른쪽이고, 바로 위 툴팁에서 quota·reset·마지막 성공 갱신 시각을 볼 수 있다.
- 클릭하면 Markdown Quota 카드가 뜨고 제공자별 새로 고침·상세/압축 설정·확장 관리·사용량 통계 링크를 사용할 수 있다. 패치한 로컬 VS Code에서는 자동 호버 억제, 클릭 유지·재클릭 닫기, 닫은 뒤 재호버 억제와 바깥 클릭·Esc 후 재열기를 실제 UI에서 검증한다.
- 누계 refresh에서 변경 없는 session의 파일 body는 다시 읽지 않는다.
- 전체 경로·manifest·파싱 결과를 메모리에 적재하지 않고 n개·byte 예산·DB 조회 page 경계를 지킨다.
- 영속 table은 manifest·projects·sessions·turn_summary·turn_model_usage·turn_costs·session_billing·turn_capability_usage이고, session summary·모델별 토큰·비용·Skill 횟수와 이름·정상 metadata·삭제는 함께 commit한다. 부재 판정은 전체 순회 성공 후 수행한다.
- 오류·중단은 네 진단 항목으로 기록하고 자동 재시도하지 않는다. 다음 화면 진입·수동 새로 고침에서 새로 조사한다.
- append/rewrite/delete 후 full rebuild 결과와 증분 결과가 같다.
- Claude response duplicate와 Codex cumulative snapshot이 이중 집계되지 않는다.
- root turn token에는 descendant가 포함되고 duration에는 포함되지 않는다.
- 일·월·프로젝트·세션 총량과 완료 turn 평균 token·시간을 summary query로 계산하고 누락 시간은 0으로 채우지 않는다.
- schema drift와 부분 coverage가 조용히 숨겨지지 않고 Diagnostics에 표시된다.
- 현재 quota를 로컬 token 합계로 역산하지 않는다. quota 갱신은 과거 JSONL 통계 스캔을 유발하지 않는다.
