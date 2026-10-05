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
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "Command failed (exit $LASTEXITCODE): $FilePath $($Arguments -join ' ')"
    }
}

function Get-MinimumVersion {
    param([string]$Engine)
    if ($Engine -notmatch '^(?:>=|\^)?(\d+\.\d+\.\d+)$') {
        throw "Unsupported engine range: $Engine. Check package.json before installing."
    }
    return [version]$Matches[1]
}

function Read-ArchiveManifest {
    param($Archive)
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

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::OpenRead($vsixPath)
    try {
        $packaged = Read-ArchiveManifest $archive
        if ($packaged.name -ne $manifest.name -or $packaged.publisher -ne $manifest.publisher -or $packaged.version -ne $manifest.version) {
            throw 'The VSIX identity or version differs from the source manifest.'
        }
        $mainPath = 'extension/' + (($packaged.main -replace '^\./', '') -replace '\\', '/')
        foreach ($entryPath in @($mainPath, 'extension/dist/src/summary/worker.js', 'extension/media/dashboard.js', 'extension/media/dashboard.css')) {
            $entry = $archive.GetEntry($entryPath)
            if ($null -eq $entry -or $entry.Length -eq 0) {
                throw "Required runtime file is missing or empty in the VSIX: $entryPath"
            }
        }
    } finally {
        $archive.Dispose()
    }

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
