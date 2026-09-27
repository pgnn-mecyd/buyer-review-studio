@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 买家评论生成工具

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 Node.js，请先安装 Node.js 18 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\exceljs" (
  echo 首次运行，正在安装依赖（需要联网，大约 1-2 分钟）...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [错误] 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

echo 正在启动服务，浏览器会自动打开 http://127.0.0.1:8787
start "" http://127.0.0.1:8787
node server.js

echo.
echo 服务已停止。按任意键关闭窗口。
pause >nul
