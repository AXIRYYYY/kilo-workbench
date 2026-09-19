@echo off
chcp 65001 >nul
title Kilo Workbench - Stop
cd /d "%~dp0"
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 7788 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
rem 监控台已并入工作台服务（同一进程）；下面这行只是顺手清掉可能残留的旧版 Python 监控台（端口 4719）
powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 4719 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }"
echo 工作台与监控台服务已关闭。
pause
