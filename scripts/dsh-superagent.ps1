<#
Manage the local dsh-superagent service (one DSH profile, default "superagent") on Windows.
The POSIX Python script next to it cannot run here (fcntl, tmux, ps), so this is the Windows equivalent.

  status   exit 0 running normally, 1 not running/duplicated/unreachable/runtime error,
           2 a part reports an error, 3 running but waiting for setup
  start    launch the profile in the background, wait for it to become ready
  stop     stop it
  restart  stop then start
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][ValidateSet('start','stop','status','restart')][string]$Action = 'status',
  [string]$ProfileName = $(if ($env:DSH_SUPERAGENT_PROFILE) { $env:DSH_SUPERAGENT_PROFILE } else { 'superagent' }),
  [string]$Url = $(if ($env:DSH_SUPERAGENT_URL) { $env:DSH_SUPERAGENT_URL } else { 'http://127.0.0.1:3082' }),
  [int]$TimeoutSeconds = 90,
  [string]$StateDir = $(if ($env:DSH_SUPERAGENT_STATE_DIR) { $env:DSH_SUPERAGENT_STATE_DIR } else { Join-Path $env:USERPROFILE '.dsh\state\superagent' }),
  # GitHub identity of the service. When the token file exists its contents become GH_TOKEN for the whole service
  # process, so the orchestrator, its Sources and every Executor session act as that token's account, never as the
  # person signed in interactively. A GH_CONFIG_DIR holding its own hosts.yml (a separate "gh auth login") is the
  # fuller separation and wins over the token file.
  [string]$GitHubTokenFile = $(if ($env:DSH_SUPERAGENT_GH_TOKEN_FILE) { $env:DSH_SUPERAGENT_GH_TOKEN_FILE } else { Join-Path $env:USERPROFILE '.dsh\secrets\superagent-gh-token.txt' }),
  [string]$GhConfigDir = $(if ($env:DSH_SUPERAGENT_GH_CONFIG_DIR) { $env:DSH_SUPERAGENT_GH_CONFIG_DIR } else { '' }),
  [switch]$RespectStop
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$artifacts = Join-Path $root '.artifacts'
$control = Join-Path (Join-Path $artifacts 'control') (Join-Path 'profiles' $ProfileName)
New-Item -ItemType Directory -Force -Path $control | Out-Null
$stopMarker = Join-Path $control 'manually-stopped'
$pidFile = Join-Path $control 'service.pid'
$auditLog = Join-Path $control 'audit.log'

# Appends one line per invocation: who ran which action, with which parameters, and how it ended.
function Write-Audit([string]$message) {
  $line = (Get-Date -Format 'o') + ' pid=' + $PID + ' user=' + $env:USERNAME + ' action=' + $Action +
    " profile=$ProfileName url=$Url ghConfigDir=$GhConfigDir respectStop=$RespectStop " + $message
  try { Add-Content -Path $auditLog -Value $line -Encoding UTF8 } catch { }
}
# The exit line also carries a one-line health snapshot whenever the state was read, so audit.log doubles as a
# health trail at whatever cadence the scheduled task runs (every 10 minutes here).
function Exit-With([int]$code) {
  $health = ''
  if ($script:LastState -and $script:LastState.health) {
    $parts = $script:LastState.health.PSObject.Properties | ForEach-Object { $_.Name + ':' + $_.Value.state }
    $health = ' health=' + ($parts -join ',')
  }
  Write-Audit ('exit=' + $code + $health)
  exit $code
}
Write-Audit 'invoked'
# Any terminating error still has to leave a trace: the audit trail must never show a run that vanished.
trap { Write-Audit ('error=' + $_.Exception.Message); exit 1 }


function Get-ServiceProcesses {
  $found = @()
  # The host runs the profile inside "DeepSeek Harness.exe" on Windows, not node.exe,
  # and a cmd.exe wrapper may carry the same command line: keep host processes only.
  foreach ($p in Get-CimInstance Win32_Process -ErrorAction SilentlyContinue) {
    if ($p.Name -notmatch '^(node|DeepSeek Harness)\.exe$') { continue }
    $line = $p.CommandLine
    if (-not $line) { continue }
    # The main DSH service for this profile; skip `dsh plugin` invocations.
    if ($line -notmatch "--profile[= ]+$([regex]::Escape($ProfileName))(\s|$)") { continue }
    if ($line -match '\splugin(\s|$)') { continue }
    $found += [int]$p.ProcessId
  }
  return $found
}

function Get-State {
  try {
    $r = Invoke-WebRequest -Uri "$Url/orchestrator/api/state" -Headers @{ 'x-orchestrator-request' = '1' } -UseBasicParsing -TimeoutSec 4
    return ($r.Content | ConvertFrom-Json)
  } catch { return $null }
}

# The GitHub CLI this machine uses for the service's identity checks.
$ghCli = @($env:DSH_SUPERAGENT_GH_CLI, (Join-Path $env:ProgramFiles 'GitHub CLI\gh.exe'), 'gh') |
  Where-Object { $_ -and ($_ -eq 'gh' -or (Test-Path $_)) } | Select-Object -First 1

# Hands the service its GitHub identity through the environment, which Start-Process passes to the child: a
# GH_CONFIG_DIR of its own (a separate 'gh auth login') or, failing that, GH_TOKEN read from a token file. Without
# either, the service inherits the interactive login of the person running it.
function Get-GitHubIdentity {
  if ($GhConfigDir) {
    if (Test-Path (Join-Path $GhConfigDir 'hosts.yml')) {
      $env:GH_CONFIG_DIR = $GhConfigDir
      $env:GH_PROMPT_DISABLED = '1'
      return @{ account = Get-GhAccount; via = "GH_CONFIG_DIR $GhConfigDir" }
    }
    Write-Warning "$GhConfigDir has no hosts.yml; falling back to the token file or the interactive login."
  }
  if (Test-Path $GitHubTokenFile) {
    $token = (Get-Content $GitHubTokenFile -Raw).Trim()
    if ($token) {
      $env:GH_TOKEN = $token
      $env:GH_PROMPT_DISABLED = '1'
      return @{ account = Get-GhAccount; via = "token $GitHubTokenFile" }
    }
    Write-Warning "$GitHubTokenFile is empty; falling back to the interactive login."
  }
  return @{ account = ''; via = 'interactive gh login' }
}

# The login the environment's credentials belong to, or empty when gh cannot tell.
function Get-GhAccount {
  if (-not $ghCli) { return '' }
  try { return ((& $ghCli api user --jq .login 2>$null) | Out-String).Trim() } catch { return '' }
}

# What the next start would use, without touching the environment.
function Get-GitHubIdentityView {
  # What the running service was started with; the parameters describe only the next start.
  $record = Join-Path $control 'identity.json'
  if (Test-Path $record) {
    try {
      $saved = Get-Content $record -Raw | ConvertFrom-Json
      if ($saved.via) {
        return @{ via = $saved.via; account = $saved.account; isolated = ($saved.via -ne 'interactive gh login') }
      }
    } catch { }
  }
  if ($GhConfigDir -and (Test-Path (Join-Path $GhConfigDir 'hosts.yml'))) { return @{ via = "GH_CONFIG_DIR $GhConfigDir"; isolated = $true } }
  if (Test-Path $GitHubTokenFile) { return @{ via = "token $GitHubTokenFile"; isolated = $true } }
  return @{ via = 'interactive gh login'; isolated = $false }
}

function Get-Outcome($pids, $state) {
  if ($pids.Count -ne 1 -or $null -eq $state) { return 1 }
  if (-not $state.health.runtime -or @('ready','paused') -notcontains $state.health.runtime.state) { return 1 }
  if ($state.setup.problem) { return 3 }
  $errors = @()
  foreach ($name in $state.health.PSObject.Properties.Name) {
    if ($name -eq 'runtime') { continue }
    if ($state.health.$name.state -eq 'error') { $errors += $name }
  }
  if ($errors.Count -gt 0) { return 2 }
  return 0
}

function Show-Status {
  $pids = @(Get-ServiceProcesses)
  $state = if ($pids.Count -gt 0) { Get-State } else { $null }
  $script:LastState = $state
  $report = [ordered]@{
    pids             = $pids
    cwd              = $root
    url              = $Url
    manually_stopped = (Test-Path $stopMarker)
    github_identity  = Get-GitHubIdentityView
    health           = if ($state) { $state.health } else { $null }
    setup            = if ($state) { $state.setup.problem } else { $null }
    feishu           = if ($state) { $state.setup.feishuProblem } else { $null }
  }
  $report | ConvertTo-Json -Depth 8
  # The report is stdout; the exit code travels separately.
  $script:Outcome = Get-Outcome $pids $state
}

function Start-Service {
  $pids = @(Get-ServiceProcesses)
  if ($pids.Count -gt 1) { throw "Multiple dsh-superagent processes found; refusing to start another." }
  if ($pids.Count -eq 0) {
    if (Get-State) { throw "An existing orchestrator answers at $Url; refusing duplicate startup." }
    Remove-Item ($StateDir + '.lock') -Recurse -Force -ErrorAction SilentlyContinue
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $log = Join-Path $artifacts "dsh-superagent-$ProfileName-$stamp-$PID.log"
    New-Item -ItemType File -Force -Path $log | Out-Null
    $identity = Get-GitHubIdentity
    $identity | ConvertTo-Json -Compress | Set-Content -Path (Join-Path $control 'identity.json') -Encoding UTF8
    if ($identity.account) { Write-Output ("GitHub identity: " + $identity.account + " via " + $identity.via) }
    else { Write-Output ("GitHub identity: " + $identity.via) }
    # A scheduled task starts without the interactive PATH, which is where `dsh` lives: resolve it first.
    $dshBin = 'D:\Program Files\DS harness\resources\runtime\cli\bin'
    $dshCmd = Join-Path $dshBin 'dsh.cmd'
    $dshExe = $(if (Test-Path $dshCmd) { $dshCmd } else { 'dsh' })
    $command = '"' + $dshExe + '" --profile ' + $ProfileName + ' --no-open >> "' + $log + '" 2>&1'
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/d','/s','/c',"`"$command`"" -WindowStyle Hidden | Out-Null
    Write-Output "Log: $log"
  } else {
    Write-Output "dsh-superagent already running (PID $($pids[0])); no duplicate started."
  }
  Remove-Item $stopMarker -Force -ErrorAction SilentlyContinue
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $current = Get-State
    if ($current -and $current.health.runtime -and @('ready','paused') -contains $current.health.runtime.state) {
      Show-Status
      return $script:Outcome
    }
    Start-Sleep -Seconds 1
  }
  Show-Status | Out-Null
  throw "Startup health check timed out; inspect the log. Any running process was left intact."
}

function Stop-Service([bool]$Intentional = $true) {
  $pids = @(Get-ServiceProcesses)
  if ($pids.Count -gt 1) { throw "Multiple dsh-superagent processes found; refusing to choose one." }
  if ($Intentional) { Set-Content -Path $stopMarker -Value (Get-Date -Format 'o') }
  foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue }
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-ServiceProcesses).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 500 }
  # A forced stop leaves the orchestrator's proper-lockfile directory behind, and the next start then fails
  # with "Lock file is already being held" until it goes stale: clear it once no service process is left.
  if ((Get-ServiceProcesses).Count -eq 0) { Remove-Item ($StateDir + '.lock') -Recurse -Force -ErrorAction SilentlyContinue }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
  if ($Intentional) { Write-Output 'dsh-superagent stopped. Automatic recovery is paused until start/restart.' }
  else { Write-Output 'dsh-superagent stopped.' }
}

switch ($Action) {
  'status'  { Show-Status; Exit-With $script:Outcome }
  'start'   {
    if ($RespectStop -and (Test-Path $stopMarker)) { Write-Output 'Intentional stop is active; automatic recovery skipped.'; Exit-With 0 }
    Start-Service | Out-Null; Exit-With $script:Outcome
  }
  'stop'    { Stop-Service $true; Exit-With 0 }
  'restart' {
    if ($RespectStop -and (Test-Path $stopMarker)) { Write-Output 'Intentional stop is active; automatic recovery skipped.'; Exit-With 0 }
    Stop-Service $false
    Start-Service | Out-Null; Exit-With $script:Outcome
  }
}