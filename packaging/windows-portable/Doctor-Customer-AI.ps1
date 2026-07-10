# @file packaging/windows-portable/Doctor-Customer-AI.ps1
# @module 数据库、共享包与交付
# @description 检查端口、OpenClaw、RAG、API 和扩展文件完整性。
# @see 联动关注：端口变化时同步文档。
#Requires -Version 5.1
[CmdletBinding()]
param()

$Root = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$checks = @(
  @{ Name = 'Portable Node'; Path = Join-Path $Root 'openclaw\app\runtime\node-win-x64\node.exe' },
  @{ Name = 'API'; Path = Join-Path $Root 'app\backend\dist\main.js' },
  @{ Name = 'RAG'; Path = Join-Path $Root 'app\rag-service\dist\main.js' },
  @{ Name = 'OpenClaw'; Path = Join-Path $Root 'openclaw\Start-OpenClaw.ps1' },
  @{ Name = 'RPA Extension'; Path = Join-Path $Root 'extensions\customer-ai-rpa\manifest.json' },
  @{ Name = 'Config'; Path = Join-Path $Root '.env' }
)
foreach ($check in $checks) {
  $ok = Test-Path -LiteralPath $check.Path
  Write-Host ("{0,-14} {1}" -f $check.Name, $(if ($ok) { 'OK' } else { 'MISSING' })) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}

& docker info *> $null
if ($LASTEXITCODE -eq 0) { Write-Host 'Docker         OK' -ForegroundColor Green } else { Write-Host 'Docker         NOT READY' -ForegroundColor Red }
foreach ($service in @(
  @{ Name = 'OpenClaw'; Url = 'http://127.0.0.1:18789/' },
  @{ Name = 'RAG'; Url = 'http://127.0.0.1:8787/health' },
  @{ Name = 'API'; Url = 'http://127.0.0.1:3001/health/openclaw' },
  @{ Name = 'RPA Extension'; Url = 'http://127.0.0.1:3001/rpa/extension/status' }
)) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $service.Url -TimeoutSec 3
    Write-Host ("{0,-14} HTTP {1}" -f $service.Name, $response.StatusCode) -ForegroundColor Green
  } catch {
    Write-Host ("{0,-14} NOT RUNNING" -f $service.Name) -ForegroundColor Yellow
  }
}
