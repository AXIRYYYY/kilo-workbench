@echo off
chcp 65001 >nul
title Kilo Workbench - Import desktop shortcuts
cd /d "%~dp0"
node import-desktop-links.js
pause
