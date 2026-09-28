# Push this project to a GitHub repository you already created.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\push-to-github.ps1 https://github.com/<user>/<repo>.git
# ASCII-only on purpose (see scripts\launch.ps1 for the reason).

param(
  [Parameter(Mandatory = $true)][string]$RemoteUrl
)

$ErrorActionPreference = 'Stop'

function T([string]$b64) {
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
}

# local development branch name (kept as base64 so the script stays ASCII-only)
$devBranch = T '5oiR55qE5pS554mI'

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $projectRoot

Write-Host "project : $projectRoot"
Write-Host "remote  : $RemoteUrl"

if (-not (git rev-parse --is-inside-work-tree 2>$null)) {
  throw "not a git repository: $projectRoot"
}

$existing = git remote get-url origin 2>$null
if ($LASTEXITCODE -eq 0 -and $existing) {
  Write-Host "origin exists -> updating URL"
  git remote set-url origin $RemoteUrl
} else {
  git remote add origin $RemoteUrl
}

# make sure the published default branch carries the latest version
git checkout main
git merge --ff-only $devBranch

Write-Host ""
Write-Host "pushing main / $devBranch / tags ..."
Write-Host "(a GitHub sign-in window may pop up - complete it to continue)"
git push -u origin main
git push origin $devBranch
git push origin --tags

Write-Host ""
Write-Host "done. repository:"
git remote -v
git log --oneline --decorate -1
