#requires -Version 5.1
<#
  Patrol for the running dsh-superagent instance.

  Read-only: it never starts, stops, restarts or reconfigures anything. It asks the
  management API for health, flow counters, the ticket list and the executor queue,
  checks that the port is listening and that no stale lock is left behind, then
  appends one line per run to patrol.log.

  Exit codes:
    0  healthy
    1  the service is not running
    2  running but a component reports a problem, or the API does not answer
    3  running and healthy, but something needs a person (ticket awaiting review,
       executor queue backing up)
#>
param(
  [string]$ProfileName = 'superagent',
  [string]$Url = 'http://127.0.0.1:3082',
  [string]$StateDir = 'C:\Users\Dell\.dsh\state\superagent',
  [string]$LogPath,
  [int]$QueueWarn = 2,
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not $LogPath) { $LogPath = Join-Path $root ('.artifacts\control\profiles\' + $ProfileName + '\patrol.log') }
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $LogPath) | Out-Null

function Write-Patrol([string]$line) {
  $stamp = (Get-Date).ToString('o')
  Add-Content -LiteralPath $LogPath -Value ($stamp + ' ' + $line) -Encoding UTF8
}

function Get-Api([string]$path) {
  $headers = @{ 'x-orchestrator-request' = '1'; 'Host' = ([uri]$Url).Authority }
  Invoke-RestMethod -Uri ($Url.TrimEnd('/') + $path) -Headers $headers -TimeoutSec 20 -Method Get
}

$notes = New-Object System.Collections.Generic.List[string]
$code = 0

$listener = Get-NetTCPConnection -LocalPort ([uri]$Url).Port -State Listen -ErrorAction SilentlyContinue
$lock = Test-Path ($StateDir + '.lock')
if (-not $listener) {
  $code = 1
  $notes.Add('port not listening')
} else {
  $notes.Add('pid=' + ($listener | Select-Object -First 1).OwningProcess)
  try {
    $state = Get-Api '/orchestrator/api/state'
    $overview = Get-Api '/orchestrator/api/overview'
    $tickets = Get-Api '/orchestrator/api/tickets'

    $bad = @()
    foreach ($part in $state.health.PSObject.Properties) {
      $v = $part.Value
      if ($v -and $v.state -and $v.state -notin @('ready', 'paused', 'idle', 'disabled')) {
        $bad += ($part.Name + '=' + $v.state + ($(if ($v.code) { '(' + $v.code + ')' } else { '' })))
      }
    }
    if ($bad.Count -gt 0) { $code = 2; $notes.Add('components: ' + ($bad -join ', ')) }
    else { $notes.Add('components ok') }

    if ($overview.problems -and $overview.problems.Count -gt 0) {
      $code = 2
      $notes.Add('problems: ' + (($overview.problems | ForEach-Object { $_.kind }) -join ','))
    }

    $flow = $overview.flow
    $notes.Add("flow received=$($flow.received) triggers=$($flow.triggers) judged=$($flow.judged) accepted=$($flow.accepted) evaluating=$($flow.evaluating)")

    $exec = $overview.executor
    $notes.Add("executor running=$($exec.running) queued=$($exec.queued) idle=$($exec.idle)")
    if ([int]$exec.queued -ge $QueueWarn) { if ($code -lt 2) { $code = 3 }; $notes.Add('queue backing up') }

    $waiting = @($tickets.items | Where-Object { $_.stage -eq 'person' })
    $notes.Add("tickets open=$(@($tickets.items).Count) awaiting-person=$($waiting.Count)")
    if ($waiting.Count -gt 0) {
      if ($code -lt 2) { $code = 3 }
      $notes.Add('awaiting: ' + (($waiting | ForEach-Object { ([string]$_.id).Substring(0, 8) + '/' + $_.action }) -join ','))
    }
  } catch {
    $code = 2
    $notes.Add('api error: ' + $_.Exception.Message)
  }
}

if ($lock) {
  if ($listener) { $notes.Add('lock held (expected while running)') }
  else { $notes.Add('STALE lock left behind'); $code = 1 }
}

$line = 'exit=' + $code + ' ' + ($notes -join ' | ')
Write-Patrol $line
if (-not $Quiet) { Write-Output $line }
exit $code
