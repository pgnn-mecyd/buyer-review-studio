@echo off
rem ASCII-only on purpose: cmd.exe parses batch files using the console codepage,
rem which differs between Explorer (OEM/GBK) and a UTF-8 terminal.
rem All Chinese output lives in scripts\launch.ps1 (base64-encoded strings).
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\launch.ps1"