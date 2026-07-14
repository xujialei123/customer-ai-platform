# @file packaging/windows-portable/Doctor-Customer-AI.ps1
# @module 数据库、共享包与交付
# @description 检查端口、LLM/OpenClaw、RAG、API 和扩展文件完整性。
# @see 联动关注：端口变化时同步文档。
#Requires -Version 5.1
[CmdletBinding()]
param()

$Root = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path

function Read-PackagedEnvValue([string]$Name) {
  $path = Join-Path $Root '.env'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
  $pattern = "(?m)^\s*$([regex]::Escape($Name))\s*=\s*(.*)$"
  $match = [regex]::Match($text, $pattern)
  if (-not $match.Success) { return $null }
  $raw = $match.Groups[1].Value.Trim()
  if (($raw.StartsWith('"') -and $raw.EndsWith('"')) -or ($raw.StartsWith("'") -and $raw.EndsWith("'"))) {
    return $raw.Substring(1, $raw.Length - 2)
  }
  return $raw
}

$provider = (Read-PackagedEnvValue 'LLM_PROVIDER')
if ([string]::IsNullOrWhiteSpace($provider)) { $provider = 'agnes' }
$needsOpenClaw = ($provider.Trim().ToLowerInvariant() -eq 'openclaw')

$checks = @(
  @{ Name = 'Portable Node'; Path = Join-Path $Root 'openclaw\app\runtime\node-win-x64\node.exe' },
  @{ Name = 'API'; Path = Join-Path $Root 'app\backend\dist\main.js' },
  @{ Name = 'RAG'; Path = Join-Path $Root 'app\rag-service\dist\main.js' },
  @{ Name = 'RPA Extension'; Path = Join-Path $Root 'extensions\customer-ai-rpa\manifest.json' },
  @{ Name = 'Config'; Path = Join-Path $Root '.env' }
)
if ($needsOpenClaw) {
  $checks += @{ Name = 'OpenClaw'; Path = Join-Path $Root 'openclaw\Start-OpenClaw.ps1' }
}
foreach ($check in $checks) {
  $ok = Test-Path -LiteralPath $check.Path
  Write-Host ("{0,-14} {1}" -f $check.Name, $(if ($ok) { 'OK' } else { 'MISSING' })) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}
Write-Host ("LLM Provider  {0}" -f $provider) -ForegroundColor Cyan

& docker info 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  Write-Host 'Docker         OK' -ForegroundColor Green
  foreach ($name in @('customer-ai-postgres', 'customer-ai-redis')) {
    $state = & docker inspect -f '{{.State.Running}}' $name 2>$null
    if ($state -eq 'true') { Write-Host ("{0,-14} running" -f $name) -ForegroundColor Green }
    elseif ($state) { Write-Host ("{0,-14} stopped" -f $name) -ForegroundColor Yellow }
    else { Write-Host ("{0,-14} missing" -f $name) -ForegroundColor Yellow }
  }
} else { Write-Host 'Docker         NOT READY' -ForegroundColor Red }

$services = @(
  @{ Name = 'RAG'; Url = 'http://127.0.0.1:8787/health' },
  @{ Name = 'API'; Url = 'http://127.0.0.1:3001/health' },
  @{ Name = 'LLM'; Url = 'http://127.0.0.1:3001/health/llm' },
  @{ Name = 'RPA Extension'; Url = 'http://127.0.0.1:3001/rpa/extension/status' }
)
if ($needsOpenClaw) {
  $services = @(
    @{ Name = 'OpenClaw'; Url = 'http://127.0.0.1:18789/' }
  ) + $services
}
foreach ($service in $services) {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri $service.Url -TimeoutSec 3
    Write-Host ("{0,-14} HTTP {1}" -f $service.Name, $response.StatusCode) -ForegroundColor Green
  } catch {
    Write-Host ("{0,-14} NOT RUNNING" -f $service.Name) -ForegroundColor Yellow
  }
}
