param([int]$SampleMilliseconds = 50)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$OutputEncoding = [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::Out.WriteLine('{"event":"ready","method":"windows-working-set"}')
[Console]::Out.Flush()
$quotaTargetText = [Console]::In.ReadLine()
$quotaTargetPid = 0
if (-not [int]::TryParse($quotaTargetText, [ref]$quotaTargetPid) -or $quotaTargetPid -le 0) { exit 0 }
$quotaWatch = [System.Diagnostics.Stopwatch]::StartNew()
while ($true) {
  try {
    $quotaProcess = Get-Process -Id $quotaTargetPid -ErrorAction Stop
    $quotaProcess.Refresh()
    $quotaSample = @{
      event = 'sample'
      offsetMs = $quotaWatch.Elapsed.TotalMilliseconds
      rssBytes = [long]$quotaProcess.WorkingSet64
      osPeakRssBytes = [long]$quotaProcess.PeakWorkingSet64
      cpuMs = $quotaProcess.TotalProcessorTime.TotalMilliseconds
    }
    [Console]::Out.WriteLine(($quotaSample | ConvertTo-Json -Compress))
    [Console]::Out.Flush()
    $quotaProcess.Dispose()
  } catch {
    [Console]::Out.WriteLine('{"event":"ended"}')
    [Console]::Out.Flush()
    exit 0
  }
  Start-Sleep -Milliseconds $SampleMilliseconds
}
