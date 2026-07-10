@REM @file packaging/windows-portable/Stop-Customer-AI.bat
@REM @module 数据库、共享包与交付
@REM @description 便携包双击停止入口。
@REM @see 联动关注：Stop-Customer-AI.ps1。
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Stop-Customer-AI.ps1"
pause
