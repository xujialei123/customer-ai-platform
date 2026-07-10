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

# 只停止本便携包通过 pid 文件启动的进程，避免误杀客服自己打开的 Chrome 或平台页面。
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

& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'openclaw\Stop-OpenClaw.ps1')
Push-Location $Root
try { docker compose stop | Out-Null } finally { Pop-Location }
Write-Host 'Customer AI stopped. Database volumes and login profiles were preserved.' -ForegroundColor Green
