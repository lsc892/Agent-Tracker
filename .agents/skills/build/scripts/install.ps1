[CmdletBinding()]
param(
    [string]$ProjectPath,
    [string]$Profile,
    [switch]$PackageOnly,
    [switch]$SkipDependencies
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Invoke-CheckedCommand {
    param([string]$FilePath, [string[]]$Arguments)
    # [실행 정책] 외부 명령의 종료 코드가 0이 아니면 후속 단계를 중단한다.
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $FilePath $($Arguments -join ' ')"
    }
}

function Get-MinimumVersion {
    param([string]$Engine)
    # [버전 정책] manifest의 최소 버전을 숫자 세 부분으로 읽어 비교에 사용한다.
    if ($Engine -notmatch '^(?:>=|\^)?(\d+\.\d+\.\d+)$') {
        throw "Unsupported engine range: $Engine. Check package.json before installing."
    }
    return [version]$Matches[1]
}

function Read-ArchiveManifest {
    param($Archive)
    # [검증 정책] VSIX 안에서 확장 manifest를 읽고 사용한 스트림은 항상 해제한다.
    $entry = $Archive.GetEntry('extension/package.json')
    if ($null -eq $entry) {
        throw 'The VSIX does not contain extension/package.json.'
    }
    $reader = [System.IO.StreamReader]::new($entry.Open())
    try {
        return ($reader.ReadToEnd() | ConvertFrom-Json)
    } finally {
        $reader.Dispose()
    }
}

# [프로젝트 정책] 경로를 생략하면 스크립트에서 저장소 위치를 구하고 manifest와 잠금 파일을 확인한다.
if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    $ProjectPath = Join-Path $PSScriptRoot '..\..\..\..'
}
$projectRoot = (Resolve-Path -LiteralPath $ProjectPath).ProviderPath
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.name -ne 'agent-tracker') {
    throw "Not an Agent Tracker project: $projectRoot"
}
if ($manifest.version -notmatch '^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$') {
    throw "Unexpected extension version: $($manifest.version)"
}
if (-not $manifest.scripts.package -or -not $manifest.scripts.'vscode:prepublish') {
    throw 'The package and vscode:prepublish scripts are required.'
}
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package-lock.json') -PathType Leaf)) {
    throw 'package-lock.json is required for npm ci.'
}

# [버전 정책] 설치 전에 Node 버전을 확인하고 패키징 전용 모드가 아니면 VS Code도 검사한다.
$nodePath = (Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$npmPath = (Get-Command npm.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$nodeOutput = & $nodePath --version
if ($LASTEXITCODE -ne 0) { throw 'Could not read the Node.js version.' }
$nodeVersion = [version]($nodeOutput.Trim() -replace '^v', '')
$nodeMinimum = Get-MinimumVersion $manifest.engines.node
if ($nodeVersion -lt $nodeMinimum) {
    throw "Node.js $nodeMinimum or newer is required; found $nodeVersion."
}

$profileArguments = @()
if ($Profile) { $profileArguments = @('--profile', $Profile) }
$codePath = $null
if (-not $PackageOnly) {
    $codePath = (Get-Command code.cmd -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
    $codeOutput = @(& $codePath --version)
    if ($LASTEXITCODE -ne 0 -or $codeOutput.Count -eq 0) {
        throw 'Could not read the VS Code version.'
    }
    $codeVersion = [version]($codeOutput[0].Trim() -replace '-.*$', '')
    $codeMinimum = Get-MinimumVersion $manifest.engines.vscode
    if ($codeVersion -lt $codeMinimum) {
        throw "VS Code $codeMinimum or newer is required; found $codeVersion."
    }
}

$extensionId = "$($manifest.publisher).$($manifest.name)"
$vsixPath = Join-Path $projectRoot "$($manifest.name)-$($manifest.version).vsix"
Push-Location -LiteralPath $projectRoot
try {
    # [의존성 정책] 생략 옵션은 기존 빌드 도구를 확인하고 기본 경로는 잠금 파일로 npm ci를 실행한다.
    if ($SkipDependencies) {
        foreach ($tool in @('tsc.cmd', 'vsce.cmd')) {
            if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules\.bin\$tool") -PathType Leaf)) {
                throw 'Build dependencies are missing. Run again without -SkipDependencies.'
            }
        }
    } else {
        Write-Host 'Installing locked dependencies...'
        Invoke-CheckedCommand $npmPath @('ci')
    }

    Write-Host "Building and packaging $extensionId@$($manifest.version)..."
    Invoke-CheckedCommand $npmPath @('run', 'package', '--', '--out', $vsixPath)
    if (-not (Test-Path -LiteralPath $vsixPath -PathType Leaf)) {
        throw "Packaging did not produce $vsixPath"
    }

    # [검증 정책] VSIX의 manifest가 원본과 일치하고 확장 진입점·Worker·화면 자산이 들어 있는지 확인한다.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($vsixPath)
    try {
        $packaged = Read-ArchiveManifest $archive
        if ($packaged.name -ne $manifest.name -or $packaged.publisher -ne $manifest.publisher -or $packaged.version -ne $manifest.version) {
            throw 'The VSIX identity or version differs from the source manifest.'
        }
        $mainPath = 'extension/' + (($packaged.main -replace '^\./', '') -replace '\\', '/')
        foreach ($entryPath in @($mainPath, 'extension/dist/src/summary/client/worker.js', 'extension/media/dashboard.js', 'extension/media/diagnostics.js', 'extension/media/dashboard.css')) {
            $entry = $archive.GetEntry($entryPath)
            if ($null -eq $entry -or $entry.Length -eq 0) {
                throw "Required runtime file is missing or empty in the VSIX: $entryPath"
            }
        }
    } finally {
        $archive.Dispose()
    }

    # [설치 정책] 일반 모드에서는 선택한 프로필에 설치한 뒤 같은 프로필의 목록에서 버전을 확인한다.
    if ($PackageOnly) {
        Write-Host "Package verified: $vsixPath"
    } else {
        Write-Host 'Installing into VS Code...'
        $installArguments = @('--install-extension', $vsixPath, '--force') + $profileArguments
        Invoke-CheckedCommand $codePath $installArguments
        $listArguments = @('--list-extensions', '--show-versions') + $profileArguments
        $installed = @(& $codePath @listArguments)
        if ($LASTEXITCODE -ne 0) { throw 'Could not verify installed extensions.' }
        $expected = "$extensionId@$($manifest.version)"
        if (-not ($installed | Where-Object { $_.Trim() -ieq $expected })) {
            throw "VS Code did not report the expected installed extension: $expected"
        }
        Write-Host "Installed and verified: $expected"
        Write-Host 'In an open VS Code window, run Developer: Reload Window, then open the Agent Tracker dashboard.'
    }

    [pscustomobject]@{
        Extension = $extensionId
        Version = $manifest.version
        Vsix = $vsixPath
        Installed = (-not [bool]$PackageOnly)
        Profile = $(if ($Profile) { $Profile } else { '(default)' })
    }
} finally {
    Pop-Location
}
