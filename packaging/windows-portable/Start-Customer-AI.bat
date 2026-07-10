@REM @file packaging/windows-portable/Start-Customer-AI.bat
@REM @module 数据库、共享包与交付
@REM @description 便携包双击启动入口（调用 PowerShell）。
@REM @see 联动关注：Start-Customer-AI.ps1。
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Customer-AI.ps1"
pause
