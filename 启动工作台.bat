@echo off
chcp 65001 >nul
title Kilo Workbench
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process node -ArgumentList 'server.js' -WorkingDirectory '%~dp0' -WindowStyle Hidden"
start " " http://localhost:7788
