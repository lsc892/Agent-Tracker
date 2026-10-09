---
name: quota-qa
description: Agent Tracker의 Claude·Codex 구독 quota를 실제 로그인 계정으로 조회하고 서버 응답과 확장의 사용률·초기화 시각·표시 값을 대조한다. 실제 quota QA, 실계정 사용량 검증, quota 값이 맞는지 확인해 달라는 요청에 사용한다.
---

# Agent Tracker 실제 quota QA

실제 계정 QA 요청에 사용한다. 이 스킬을 추가·수정해 달라는 요청에 검증까지 포함되면 실제 QA도 실행한다. 일반 코드 검사와 CI는 실제 계정을 호출하지 않는다.

## 실행

이 스킬이 있는 Agent Tracker 저장소 루트에서 실행한다. 다른 작업 폴더에서 호출했다면 스킬의 실제 위치를 기준으로 저장소를 찾고 `package.json`의 `name`이 `agent-tracker`인지 확인한다. 사용자가 다른 프로젝트를 지정하면 그 Agent Tracker 저장소를 사용한다.

```powershell
npm.cmd run test:quota:live
```

기본은 두 제공자를 모두 한 번 조회한다. Claude는 현재 CLI 로그인 credential로 OAuth usage API를 조회하고, Codex는 `app-server`의 `initialize` → `initialized` → `account/read` → `account/rateLimits/read`를 호출한다. 이 명령이 컴파일도 수행한다.

- VS Code에 별도 `claude.dataHome`·`codex.dataHome`·`codex.executable`을 설정한 경우 동일한 값을 전달한다. 기본은 `CLAUDE_CONFIG_DIR`·`CODEX_HOME`·PATH이며, 해당 환경 변수가 없으면 사용자 홈의 `.claude`·`.codex`를 사용한다.
- 제공자별 요청은 `--provider=claude` 또는 `--provider=codex`를 전달한다. 기본 `both`에서 한 제공자가 실패해도 다른 제공자를 확인한다.
- 경로와 timeout 옵션은 다음 예시처럼 `--` 뒤에 전달한다. 공백이 있는 인자는 전체를 따옴표로 감싼다.

```powershell
npm.cmd run test:quota:live -- "--codex-executable=C:\path\codex.exe" "--codex-home=C:\path\.codex" "--claude-home=C:\path\.claude" --timeout-ms=30000
```

실행 도구는 [tools/quota/live-qa.cjs](../../../tools/quota/live-qa.cjs)다. 직접 실행할 때는 먼저 현재 소스를 컴파일하고 `node tools/quota/live-qa.cjs --real`을 사용한다. `--real` 없는 직접 실행은 실제 계정을 호출하지 않는다.

## 판정과 후속 조치

`tests/results/quota-live.json`과 종료 코드를 확인한다. 종료 코드 0은 선택한 모든 제공자의 서버 응답과 제품 provider 결과가 일치했다는 뜻이다. 같은 응답에서 사용률, `current/maximum`, 기간, 초기화 시각, Codex reset credit 요약을 독립 계산으로 대조하고, 상태 표시줄 formatter의 사용/남음 반올림·잔량 막대도 검사한다. Codex는 실제 App Server와 관찰 프로세스가 모두 종료됐는지 확인한다.

인증 오류·429·timeout·형식 불일치는 실패이며 skip이나 통과로 바꾸지 않는다. 429에는 `retryAfterMs`가 있으면 함께 보고하고 이번 실행을 멈춘다. 원인 해결 없이 재호출하지 않는다. 인증 실패는 해당 CLI 재로그인을 안내하고, 로그인·계정 변경·refresh token 교체를 대신 수행하지 않는다.

결과에는 quota 수치·초기화 시각·검사 상태만 남긴다. credential 파일, Authorization 헤더, 계정 ID·이메일, 임의의 서버 오류 본문을 출력하거나 보고서에 복사하지 않는다. 임시 관찰 파일은 자동 삭제되며 결과 파일은 Git 제외 경로에 둔다.

이 QA는 실제 서버 값과 현재 소스의 조회·표시 로직을 확인한다. 설치된 VS Code 창이나 제공자 웹 화면을 관찰하지 않는다. 별도 UI 대조를 요청받으면 같은 계정·기간·갱신 시각·사용/남음 모드로 새로고침한 화면을 비교하고 추가로 확인한 범위만 보고한다. 토큰 수로 구독 quota를 역산하거나 짧은 추론 후 반드시 정수 사용률이 증가한다고 판정하지 않는다.

완료 보고에는 제공자별 통과/실패, 확인한 사용률·초기화 시각, 결과 경로, 남은 검증 범위를 간단히 적는다. 스킬·QA 도구만 바꾼 작업은 기능 의사결정 일지에 추가하지 않는다. 제품 기능을 고쳤다면 저장소의 `AGENTS.md` 지침을 따른다.
