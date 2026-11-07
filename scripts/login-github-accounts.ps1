<#
.SYNOPSIS
  Sign this machine's two GitHub identities back in: your own (default config dir) and the agent's bot account
  (its own GH_CONFIG_DIR, token stored in that directory's hosts.yml so the two never fight over the OS keyring).

.DESCRIPTION
  Run it in your own PowerShell window: gh prints a one-time code and opens the browser, and you finish there.
  Step 1 signs you in as yourself - the browser already has that session, so it is just the code.
  Step 2 signs in the bot account: use a private/incognito window for it, or sign out of GitHub first.
  Run it with -Only bot (or -Only me) to redo just one of them.
#>
[CmdletBinding()]
param(
  [ValidateSet('both','me','bot')][string]$Only = 'both',
  [string]$GhConfigDir = 'C:\Users\Dell\.dsh\gh\superagent',
  [string]$GhCli = 'C:\Program Files\GitHub CLI\gh.exe',
  [string]$Control = (Join-Path $PSScriptRoot 'dsh-superagent.ps1')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $GhCli)) { $GhCli = (Get-Command gh -ErrorAction Stop).Source }
New-Item -ItemType Directory -Force -Path $GhConfigDir | Out-Null

function Connect-Account([string]$label, [string]$ConfigDir) {
  Write-Output ''
  Write-Output ("=== " + $label + " ===")
  if ($ConfigDir) { $env:GH_CONFIG_DIR = $ConfigDir } else { Remove-Item Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue }
  $extra = @()
  if ($ConfigDir) { $extra += '--insecure-storage' }
  & $GhCli auth login --hostname github.com --git-protocol https --web --scopes 'repo,workflow' @extra
  if ($LASTEXITCODE -ne 0) { throw "gh auth login failed for $label" }
  $login = (& $GhCli api user --jq .login | Out-String).Trim()
  Write-Output ("$label is signed in as: $login")
  return $login
}

$mine = $null; $bot = $null
if ($Only -in @('both','me'))  { $mine = Connect-Account 'your own account' '' }
if ($Only -in @('both','bot')) { $bot  = Connect-Account 'the agent bot account' $GhConfigDir }

if ($bot -and $mine -and $bot -eq $mine) {
  Write-Warning "Both identities are $bot - the bot step signed in as you. Log out of GitHub in the browser (or use a private window) and rerun with -Only bot."
}

Write-Output ''
Write-Output 'Next: attach-agent-account.ps1 invites the bot to the sandbox repository, then restarts the service as the bot.'
if ($bot) { Write-Output ('bot config dir: ' + $GhConfigDir) }
