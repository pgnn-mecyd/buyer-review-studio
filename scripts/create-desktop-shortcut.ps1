# Create (or refresh) the desktop shortcut that starts this tool.
# Usage: powershell -ExecutionPolicy Bypass -File scripts\create-desktop-shortcut.ps1
# NOTE: ASCII-only source. Non-ASCII strings are carried as base64 UTF-8 so the
#       script behaves the same under Windows PowerShell 5.1 and PowerShell 7.

$ErrorActionPreference = 'Stop'

function From-B64([string]$b64) {
  return [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($b64))
}

# name: "买家评论生成器.lnk"  /  launcher: "启动.cmd"
$shortcutName = (From-B64 '5Lmw5a626K+E6K6655Sf5oiQ5Zmo') + '.lnk'
$launcherName = From-B64 '5ZCv5YqoLmNtZA=='
$description  = From-B64 '5Lmw5a626K+E6K6655Sf5oiQ5Zmo77ya5pys5Zyw572R6aG15bel5YW377yM5Y+M5Ye75Y2z5Y+v5ZCv5Yqo'

$projectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$launcher = Join-Path $projectRoot $launcherName
if (-not (Test-Path -LiteralPath $launcher)) {
  throw "launcher not found: $launcher"
}

# Resolve the real desktop folder from the registry (it may be redirected, e.g. D:\桌面)
$shellFolders = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders'
$desktop = (Get-ItemProperty -Path $shellFolders).Desktop
$desktop = [System.Environment]::ExpandEnvironmentVariables($desktop)
if (-not (Test-Path -LiteralPath $desktop)) {
  $desktop = [System.Environment]::GetFolderPath('Desktop')
}

$iconPath = Join-Path $projectRoot 'assets\app.ico'
$shortcutPath = Join-Path $desktop $shortcutName

$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($shortcutPath)
$link.TargetPath = $launcher
$link.WorkingDirectory = $projectRoot
$link.Description = $description
if (Test-Path -LiteralPath $iconPath) { $link.IconLocation = "$iconPath,0" }
$link.WindowStyle = 1
$link.Save()

Write-Output ("shortcut: " + $shortcutPath)
Write-Output ("target  : " + $link.TargetPath)
Write-Output ("icon    : " + $link.IconLocation)
