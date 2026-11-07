<#
.SYNOPSIS
  Give the dsh-superagent service a GitHub identity of its own, then restart it with that identity.

.DESCRIPTION
  The orchestrator, its Sources and every Executor Session push and open pull requests as whatever account the
  service's gh is signed in to. With no setup that is the person's own account. This script stores a token in
  C:\Users\Dell\.dsh\secrets\superagent-gh-token.txt and the control script exports it as GH_TOKEN to the whole
  service process, so the agent acts as that token's account and can reach nothing else.

  A fine-grained token that names only the sandbox repository is the smallest blast radius. A token of a second,
  dedicated account additionally separates the actor; a GH_CONFIG_DIR with its own 'gh auth login' (see
  -GhConfigDir in dsh-superagent.ps1) is the fullest separation.

.EXAMPLE
  ./set-superagent-identity.ps1 -Token ghp_xxx
  ./set-superagent-identity.ps1 -Clear
#>
[CmdletBinding()]
param(
  [string]$Token,
  [string]$TokenFile = $(if ($env:DSH_SUPERAGENT_GH_TOKEN_FILE) { $env:DSH_SUPERAGENT_GH_TOKEN_FILE } else { Join-Path $env:USERPROFILE '.dsh\secrets\superagent-gh-token.txt' }),
  [string]$Repository = 'xielhz/superagent-sandbox',
  [string]$GhCli = $(if ($env:DSH_SUPERAGENT_GH_CLI) { $env:DSH_SUPERAGENT_GH_CLI } else { 'C:\Program Files\GitHub CLI\gh.exe' }),
  [switch]$Clear
)
$ErrorActionPreference = 'Stop'
$control = Join-Path $PSScriptRoot 'dsh-superagent.ps1'

if ($Clear) {
  Remove-Item $TokenFile -Force -ErrorAction SilentlyContinue
  Write-Output "Token removed: $TokenFile"
  & $control restart | Out-Null
  Write-Output 'Service restarted on the interactive gh login.'
  exit 0
}

if (-not $Token) {
  if ([Console]::IsInputRedirected) { throw 'Pass -Token, or run this where a prompt can be answered.' }
  $secure = Read-Host -AsSecureString 'Paste the GitHub token'
  $Token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
$Token = $Token.Trim()
if (-not $Token) { throw 'The token is empty.' }

# Validate before storing anything: nothing is written when the token is wrong.
$env:GH_TOKEN = $Token
$env:GH_PROMPT_DISABLED = '1'
$login = ((& $GhCli api user --jq .login 2>&1) | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $login) { throw "GitHub rejected the token: $login" }
Write-Output "Token belongs to: $login"

$push = ((& $GhCli api "repos/$Repository" --jq .permissions.push 2>&1) | Out-String).Trim()
if ($push -ne 'true') { Write-Warning "This token cannot push to $Repository (permissions.push=$push); the Source check will fail." }

New-Item -ItemType Directory -Force -Path (Split-Path -Parent $TokenFile) | Out-Null
[System.IO.File]::WriteAllText($TokenFile, $Token, (New-Object System.Text.UTF8Encoding($false)))
# Keep the file to this account only.
$acl = Get-Acl $TokenFile
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRule($rule) | Out-Null }
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule(
  [System.Security.Principal.WindowsIdentity]::GetCurrent().Name, 'FullControl', 'Allow')))
Set-Acl -Path $TokenFile -AclObject $acl
Write-Output "Token stored: $TokenFile"

& $control restart | Out-Null
Write-Output "Service restarted; the agent now acts as $login."
& $control status | Out-String | Write-Output