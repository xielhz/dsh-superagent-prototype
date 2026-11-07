<#
.SYNOPSIS
  Keep the superagent service up: start it if it is not running, honouring an intentional stop.

.DESCRIPTION
  The scheduled task calls this at logon and every few minutes. `start` refuses a duplicate (it also refuses
  when another orchestrator answers on the port), and `-RespectStop` leaves a manually stopped service down,
  so this is safe to run repeatedly: a crash is recovered, a deliberate stop is not undone.
#>
[CmdletBinding()]
param(
  [string]$ProfileName = 'superagent',
  [string]$Url = 'http://127.0.0.1:3082',
  [string]$GhConfigDir = 'C:\Users\Dell\.dsh\gh\superagent',
  [int]$TimeoutSeconds = 90
)
$ErrorActionPreference = 'Stop'
$log = Join-Path (Join-Path (Split-Path -Parent $PSScriptRoot) '.artifacts') 'watchdog.log'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $log) | Out-Null
function Write-Log([string]$message) {
  $line = (Get-Date -Format 'o') + ' ' + $message
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Output $line
}
# A scheduled task starts without the interactive PATH, which is where dsh lives.
$dshBin = 'D:\Program Files\DS harness\resources\runtime\cli\bin'
if ((Test-Path (Join-Path $dshBin 'dsh.cmd')) -and ($env:PATH -notlike ('*' + $dshBin + '*'))) {
  $env:PATH = $dshBin + ';' + $env:PATH
}
$control = Join-Path $PSScriptRoot 'dsh-superagent.ps1'
$startArgs = @{ ProfileName = $ProfileName; Url = $Url; TimeoutSeconds = $TimeoutSeconds; RespectStop = $true }
if ($GhConfigDir -and (Test-Path (Join-Path $GhConfigDir 'hosts.yml'))) { $startArgs['GhConfigDir'] = $GhConfigDir }
$output = & $control start @startArgs 2>&1 | Out-String
Write-Log ('exit=' + $LASTEXITCODE + ' ' + ($output -replace '\s+', ' ').Trim())
exit 0
