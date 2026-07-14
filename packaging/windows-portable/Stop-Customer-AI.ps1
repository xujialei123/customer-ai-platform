# @file packaging/windows-portable/Stop-Customer-AI.ps1
# @module 数据库、共享包与交付
# @description 停止本项目相关进程，不误杀无关服务。
# @see 联动关注：端口占用清理。
#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$PidDir = Join-Path $Root 'data\.pids'

# Stop only processes started by this portable package via pid files.
foreach ($name in @('meituan-rpa', 'api', 'rag-service')) {
  $pidFile = Join-Path $PidDir "$name.pid"
  if (-not (Test-Path -LiteralPath $pidFile)) { continue }
  try {
    $processId = [int]((Get-Content -LiteralPath $pidFile -Encoding utf8 | Select-Object -First 1).Trim())
    if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
      & taskkill.exe /PID $processId /T /F | Out-Null
    }
  } finally {
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }
}

$stopOpenClaw = Join-Path $Root 'openclaw\Stop-OpenClaw.ps1'
if (Test-Path -LiteralPath $stopOpenClaw) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $stopOpenClaw
}
# 不执行 docker compose stop：Postgres/Redis 容器名固定，可能与开发环境共用；停止会误伤共享数据库。
Write-Host 'Customer AI app processes stopped. Docker Postgres/Redis were left running.' -ForegroundColor Green
