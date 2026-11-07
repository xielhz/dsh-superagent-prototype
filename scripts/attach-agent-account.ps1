<#
.SYNOPSIS
  Finish the agent's own GitHub identity: check the bot login in a dedicated GH_CONFIG_DIR, invite it to the sandbox
  repository with Write access, and restart the service so that every Source and Executor session acts as the bot.

.EXAMPLE
  .\attach-agent-account.ps1                    # invite + restart
  .\attach-agent-account.ps1 -CheckOnly         # just report the bot login and the invitation state
#>
[CmdletBinding()]
param(
  [string]$Repo = 'xielhz/superagent-sandbox',
  [string]$GhConfigDir = 'C:\Users\Dell\.dsh\gh\superagent',
  [string]$GhCli = 'C:\Program Files\GitHub CLI\gh.exe',
  [string]$Control = (Join-Path $PSScriptRoot 'dsh-superagent.ps1'),
  [string]$Permission = 'push',
  [switch]$CheckOnly
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $GhCli)) { $GhCli = (Get-Command gh -ErrorAction Stop).Source }

function Get-BotLogin {
  $env:GH_CONFIG_DIR = $GhConfigDir
  $login = (& $GhCli api user --jq .login 2>$null | Out-String).Trim()
  if (-not $login) { throw "No bot login in $GhConfigDir. Run: `$env:GH_CONFIG_DIR='$GhConfigDir'; gh auth login" }
  return $login
}

function Get-PersonLogin {
  Remove-Item Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue
  $login = (& $GhCli api user --jq .login 2>$null | Out-String).Trim()
  if (-not $login) { throw 'No interactive gh login; sign in as the repository owner first.' }
  return $login
}

$bot = Get-BotLogin
$owner = ($Repo -split '/')[0]
$person = Get-PersonLogin
Write-Output ("bot: $bot")
Write-Output ("act as: $person (owner of $Repo)")

$permissionNow = Remove-Item Env:GH_CONFIG_DIR -ErrorAction SilentlyContinue; (& $GhCli api "repos/$Repo/collaborators/$bot/permission" --jq .permission 2>$null | Out-String).Trim()
Write-Output ("current permission of $bot on $Repo : " + ($(if ($permissionNow) { $permissionNow } else { 'none' })))

if (-not $CheckOnly -and $permissionNow -ne $Permission -and $permissionNow -ne 'admin' -and $permissionNow -ne 'maintain') {
  & $GhCli api -X PUT "repos/$Repo/collaborators/$bot" -f permission=$Permission --jq .html_url
  Write-Output 'Invitation sent. Accept it while signed in as the bot: https://github.com/' + $Repo + '/invitations'
  Write-Output 'Then run this script again (without -CheckOnly) to restart the service as the bot.'
  exit 0
}
if ($CheckOnly) { exit 0 }

Write-Output 'restarting the service as the bot...'
& $Control stop | Out-Null
& $Control start -GhConfigDir $GhConfigDir
Write-Output ('control exit code: ' + $LASTEXITCODE)
