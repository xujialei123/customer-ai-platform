@REM @file packaging/windows-portable/Doctor-Customer-AI.bat
@REM @module 数据库、共享包与交付
@REM @description 便携包双击诊断入口。
@REM @see 联动关注：Doctor-Customer-AI.ps1。
@echo off
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0Doctor-Customer-AI.ps1"
pause
