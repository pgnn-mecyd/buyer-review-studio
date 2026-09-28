# Launcher for the buyer-review tool.
# ASCII-only source: all Chinese text is carried as base64 UTF-8, so the script
# behaves the same no matter which codepage cmd.exe / PowerShell picked.
# It is started by the ASCII-only launcher in the project root (launch.cmd)

$ErrorActionPreference = 'Continue'

function T([string]$b64) {
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
}

$msgTitle    = T '5Lmw5a626K+E6K6655Sf5oiQ5bel5YW3'
$msgNoNode   = T 'W+mUmeivr10g5rKh5pyJ5om+5YiwIE5vZGUuanPvvIzor7flhYjlronoo4UgTm9kZS5qcyAxOCDmiJbmm7Tpq5jniYjmnKzvvJpodHRwczovL25vZGVqcy5vcmcv'
$msgRunning  = T '5pyN5Yqh5bey57uP5Zyo6L+Q6KGM77yM5q2j5Zyo5omT5byA5rWP6KeI5ZmoIGh0dHA6Ly8xMjcuMC4wLjE6ODc4Nw=='
$msgInstall  = T '6aaW5qyh6L+Q6KGM77yM5q2j5Zyo5a6J6KOF5L6d6LWW77yI6ZyA6KaB6IGU572R77yM5aSn57qmIDEtMiDliIbpkp/vvIkuLi4='
$msgStarting = T '5q2j5Zyo5ZCv5Yqo5pyN5Yqh77yM5rWP6KeI5Zmo5Lya6Ieq5Yqo5omT5byAIGh0dHA6Ly8xMjcuMC4wLjE6ODc4Nw=='
$msgStopped  = T '5pyN5Yqh5bey5YGc5q2i44CC5oyJ5Zue6L2m6ZSu5YWz6Zet56qX5Y+j44CC'
$msgDepsFail = T 'W+mUmeivr10g5L6d6LWW5a6J6KOF5aSx6LSl77yM6K+35qOA5p+l572R57uc5ZCO6YeN6K+V44CC'

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location -LiteralPath $projectRoot

try { $host.UI.RawUI.WindowTitle = $msgTitle } catch { }

function Wait-BeforeClose {
  Write-Host ''
  Write-Host $msgStopped
  try { Read-Host | Out-Null } catch { Start-Sleep -Seconds 3 }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host $msgNoNode
  Wait-BeforeClose
  exit 1
}

function Test-ServiceAlive {
  try {
    $response = Invoke-WebRequest -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 2 -UseBasicParsing
    return ($response.StatusCode -eq 200)
  } catch {
    return $false
  }
}

# Already running? Just open the browser, do not start a second instance.
if (Test-ServiceAlive) {
  Write-Host $msgRunning
  Start-Process 'http://127.0.0.1:8787'
  exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\exceljs'))) {
  Write-Host $msgInstall
  & npm install --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) {
    Write-Host $msgDepsFail
    Wait-BeforeClose
    exit 1
  }
}

Write-Host $msgStarting
Start-Process 'http://127.0.0.1:8787'
& node server.js

Wait-BeforeClose
exit 0
