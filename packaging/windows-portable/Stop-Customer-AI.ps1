#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
$Root = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$PidDir = Join-Path $Root 'data\.pids'

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
