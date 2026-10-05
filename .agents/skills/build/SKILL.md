---
name: build
description: "Agent Tracker의 TypeScript VS Code 확장을 빌드하고 VSIX로 패키징하여 로컬 VS Code에 설치한다. 이 프로젝트에서 빌드, 재빌드, 빌드 후 설치를 요청하거나 $build를 호출할 때 사용한다."
---

# Build

사용자가 이 프로젝트의 빌드를 요청하면 TypeScript 빌드, VSIX 생성, 로컬 VS Code 설치까지 실행한다. 사용자가 설치하지 말라고 명시하면 빌드·패키징까지만 수행한다.

## 실행

이 스킬이 있는 저장소의 루트에서 실행한다. `package.json`의 이름이 `agent-tracker`인지 확인하고 현재 `engines`, `scripts`, `publisher`, `name`, `version`을 읽는다. 현재 요구사항은 Node.js 22.15 이상, VS Code 1.101 이상이다.

Windows PowerShell에서는 `npm.cmd`, `code.cmd`를 사용한다. `code.cmd`가 PATH에 없으면 다음 위치에서 찾아 절대 경로로 호출한다.

- 사용자 설치: `$env:LOCALAPPDATA\Programs\Microsoft VS Code\bin\code.cmd`
- 시스템 설치: `$env:ProgramFiles\Microsoft VS Code\bin\code.cmd`

아래는 Windows의 기본 실행 순서다. 각 단계가 실패하면 다음 단계로 진행하지 말고 원인을 해결한다. 빌드나 패키징이 실패했을 때 기존 VSIX를 설치하지 않는다.

```powershell
$ErrorActionPreference = 'Stop'
$package = Get-Content -Encoding UTF8 -LiteralPath package.json | ConvertFrom-Json
if ($package.name -ne 'agent-tracker') { throw 'Agent Tracker 저장소 루트에서 실행하세요.' }
$vsixPath = Join-Path (Get-Location).Path "$($package.name)-$($package.version).vsix"
$codeCommand = (Get-Command code.cmd -ErrorAction Stop).Source

npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw '의존성 설치 실패' }

npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'TypeScript 빌드 실패' }

npm.cmd run package
if ($LASTEXITCODE -ne 0) { throw 'VSIX 생성 실패' }
if (-not (Test-Path -LiteralPath $vsixPath -PathType Leaf)) { throw '생성된 VSIX를 찾을 수 없습니다.' }

& $codeCommand --install-extension $vsixPath --force
if ($LASTEXITCODE -ne 0) { throw 'VS Code 확장 설치 실패' }

$installed = & $codeCommand --list-extensions --show-versions
if ($LASTEXITCODE -ne 0) { throw '설치된 확장 조회 실패' }
$expected = "$($package.publisher).$($package.name)@$($package.version)"
if ($installed -notcontains $expected) { throw "설치 버전 확인 실패: $expected" }
Write-Output "설치 완료: $expected"
```

`npm run package`는 `vscode:prepublish`를 통해 다시 빌드한다. VSIX 이름과 확장 ID는 항상 현재 `package.json`에서 구하고 버전을 임의로 올리지 않는다. 아이콘 폰트는 저장소에 포함되어 있으므로 일반 빌드에 Python이나 폰트 재생성은 필요하지 않다.

macOS/Linux에서는 같은 순서로 `npm`, `code`를 사용한다. 사용자가 Insiders나 특정 VS Code 프로필을 지정하면 해당 CLI와 동일한 프로필 옵션을 설치 및 버전 확인에 모두 사용한다.

## 클릭 토글을 포함한 로컬 설치

사용자가 내장 클릭 토글 설치를 요청한 경우 VSIX 설치 후 `scripts/vscode/statusbar-toggle.cjs`도 적용한다. 확장 활성화나 일반 패키징에서는 VS Code 코어를 수정하지 않는다. Windows에서는 위에서 설치에 사용한 CLI를 그대로 지정해 다른 설치를 패치하지 않도록 한다.

```powershell
npm.cmd run patch:vscode -- --cli $codeCommand
if ($LASTEXITCODE -ne 0) { throw 'VS Code 클릭 토글 패치 실패' }
npm.cmd run patch:vscode -- --check --cli $codeCommand
if ($LASTEXITCODE -ne 0) { throw '클릭 토글 패치 확인 실패' }
```

다른 플랫폼이나 CLI 구조에서는 동일한 설치의 `--executable` 또는 `--app-root`를 지정한다. 경로를 개인 계정이나 특정 버전으로 고정하지 않는다. 스크립트가 원본·checksum을 백업하고 구현 구조를 검사한다. 지원하지 않는 구조나 무결성 오류면 임의로 수정하지 않고 패치 실패를 보고한다. 적용 원리와 `npm run restore:vscode` 복원 방법은 [StatusBarPopup.md](../../../docs/StatusBarPopup.md)를 참고한다. VS Code 업데이트 뒤 클릭 토글을 다시 설치할 때도 이 단계를 실행한다.

## 완료 보고

빌드·패키징·설치 결과, VSIX 경로, 확인된 확장 버전을 짧게 보고한다. 클릭 토글을 요청받았으면 패치 결과와 업데이트 뒤 재적용 필요성도 보고한다. 코어 패치를 적용·갱신·복원했다면 모든 VS Code 창을 완전히 종료하고 다시 실행하도록 안내한다. `Developer: Reload Window`만으로는 메인 프로세스의 이전 checksum 기준값이 갱신되지 않아 설치 손상 경고가 날 수 있다. 일반 VSIX 설치만 했다면 `Developer: Reload Window`로 반영한다. CLI를 찾을 수 없거나 설치가 실패하면 생성된 VSIX 경로와 실패 원인을 보고하고, 설치 완료로 표현하지 않는다.
