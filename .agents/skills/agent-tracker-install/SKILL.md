---
name: agent-tracker-install
description: Windows에서 Agent Tracker 프로젝트를 빌드하고 VSIX로 패키징하여 로컬 VS Code에 설치하거나 업데이트한다. 이 프로젝트를 VS Code에 적용, 재설치 또는 패키징해 달라는 요청에 사용한다.
---

# Agent Tracker 설치

사용자가 요청한 Agent Tracker 소스를 로컬 VS Code에 설치한다. 설치·업데이트 요청이나 이 스킬의 호출이 있으면 아래 스크립트를 실행한다. 스킬 자체를 작성·수정해 달라는 요청에서는 실제 설치 대신 `-PackageOnly`로 검증한다.

## 실행

기본 프로젝트 경로는 이 스킬이 들어 있는 Agent Tracker 저장소 루트다. 스크립트가 자신의 위치를 기준으로 루트를 계산하므로 실행한 작업 폴더에 의존하지 않는다. 사용자가 다른 Agent Tracker 프로젝트 경로를 명시한 경우에만 `-ProjectPath "프로젝트 경로"`를 전달한다. 대상 `package.json`의 `name: agent-tracker`를 확인하고 다른 프로젝트를 대신 설치하지 않는다.

스킬 폴더의 [scripts/install.ps1](scripts/install.ps1)을 실행한다. 아래 명령은 저장소 루트에서 실행하는 예시다. 다른 작업 폴더에서는 현재 읽고 있는 `SKILL.md`의 위치를 기준으로 스크립트의 절대 경로를 사용한다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\.agents\skills\agent-tracker-install\scripts\install.ps1"
```

스크립트는 Node.js와 VS Code 요구 버전을 확인하고, `npm.cmd ci`와 `npm.cmd run package`를 수행한다. `vscode:prepublish`가 빌드를 수행하므로 별도로 빌드하지 않는다. `package.json`의 현재 버전으로 VSIX 경로를 결정하고, 패키지의 확장 ID·버전·실행 파일·화면 자산을 확인한 뒤 `code.cmd --install-extension ... --force`로 설치한다. 마지막으로 설치 목록에서 같은 ID와 버전을 확인한다.

- 패키징만 요청한 경우 `-PackageOnly`를 추가한다.
- 사용자가 VS Code 프로필을 지정했다면 `-Profile "프로필 이름"`을 추가한다. 기본은 VS Code CLI의 기본 프로필이다. 지정 프로필의 존재 여부가 불명확하면 읽기 전용으로 확인한다. CLI는 없는 프로필을 새로 만들 수 있다.
- 의존성이 이미 설치되어 있고 `package.json`과 `package-lock.json`이 변경되지 않았음을 확인한 경우 `-SkipDependencies`로 `npm ci`를 생략할 수 있다. 기본 실행에서는 잠금 파일에 맞춰 설치한다.

실패한 단계에서 중단하고 오류를 해결한다. 패키징이 실패했으면 남아 있는 예전 VSIX를 설치하지 않는다. 동일 명령을 원인 해결 없이 반복하지 않는다.

## 완료 보고

확장 ID·버전, VSIX 파일 경로, 실제 설치 확인 결과를 간단히 보고한다. `-PackageOnly`는 설치 완료로 표현하지 않는다.

열려 있는 VS Code 창에는 `Ctrl+Shift+P` → `Developer: Reload Window` 실행 후 `Agent Tracker: 대시보드 열기`를 안내한다. VS Code CLI에는 창 새로 고침 명령이 없으므로 이를 실행했다고 보고하지 않는다. 설치 목록 확인은 실제 확장 활성화나 대시보드 동작 확인과 구분한다. Claude/Codex 로그인이나 데이터 경로는 사용자가 문제를 보고한 경우에만 확인한다.
