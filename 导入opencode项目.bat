@echo off
chcp 65001 >nul
title Kilo Workbench - Import from opencode
cd /d "%~dp0"
node import-opencode.js
pause
