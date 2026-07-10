# @file packaging/windows-portable/Start-Customer-AI.ps1
# @module 数据库、共享包与交付
# @description 便携环境检查与一键启动全部服务。
# @see 联动关注：Docker/OpenClaw/RAG/API/扩展状态页。
#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$NodeExe = Join-Path $Root 'openclaw\app\runtime\node-win-x64\node.exe'
$PidDir = Join-Path $Root 'data\.pids'
$LogDir = Join-Path $Root 'data\logs'
$DockerBin = 'C:\Program Files\Docker\Docker\resources\bin'
$DockerDesktop = 'C:\Program Files\Docker\Docker\Docker Desktop.exe'
$env:CUSTOMER_AI_ROOT = $Root
$env:PATH = "$DockerBin;$env:PATH"
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Ensure-Dir([string[]]$Paths) {
  foreach ($path in $Paths) {
    if (-not (Test-Path -LiteralPath $path)) { New-Item -ItemType Directory -Path $path -Force | Out-Null }
  }
}

function Wait-Http([string]$Url, [int]$Seconds = 60) {
  for ($index = 0; $index -lt $Seconds; $index += 1) {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return $true }
    } catch {}
    Start-Sleep -Seconds 1
  }
  return $false
}

function Test-DockerReady {
  & docker info *> $null
  return $LASTEXITCODE -eq 0
}

function Start-AppProcess([string]$Name, [string]$Entry, [string]$WorkingDirectory) {
  $pidFile = Join-Path $PidDir "$Name.pid"
  if (Test-Path -LiteralPath $pidFile) {
    $oldPid = [int]((Get-Content -LiteralPath $pidFile -Encoding utf8 | Select-Object -First 1).Trim())
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) { return }
  }

  $entryArgument = '"' + $Entry.Replace('"', '\"') + '"'
  $process = Start-Process -FilePath $NodeExe -ArgumentList $entryArgument -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "$Name.out.log") `
    -RedirectStandardError (Join-Path $LogDir "$Name.err.log")
  [IO.File]::WriteAllText($pidFile, [string]$process.Id, $utf8NoBom)
}

Ensure-Dir @($PidDir, $LogDir, (Join-Path $Root 'data\sessions'))
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Portable Node is missing. Rebuild the delivery package.' }

if (-not (Test-DockerReady)) {
  if (Test-Path -LiteralPath $DockerDesktop) {
    Start-Process -FilePath $DockerDesktop -WindowStyle Hidden | Out-Null
    for ($index = 0; $index -lt 90; $index += 1) {
      Start-Sleep -Seconds 2
      if (Test-DockerReady) { break }
    }
  }
}
if (-not (Test-DockerReady)) { throw 'Docker Desktop is not ready. Install and start Docker Desktop.' }

Push-Location $Root
try { docker compose up -d } finally { Pop-Location }

$portableTokenFile = Join-Path $Root 'openclaw\data\.openclaw\gateway-token.txt'
$gatewayAlreadyRunning = Wait-Http 'http://127.0.0.1:18789/' 2
if ($gatewayAlreadyRunning -and -not (Test-Path -LiteralPath $portableTokenFile)) {
  throw 'Port 18789 is used by another OpenClaw instance. Stop it before starting this package.'
}
if (-not $gatewayAlreadyRunning) {
  Start-Process -FilePath 'powershell' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    ('"' + (Join-Path $Root 'openclaw\Start-OpenClaw.ps1') + '"'), '-NoBrowser'
  ) -WorkingDirectory (Join-Path $Root 'openclaw') -WindowStyle Hidden | Out-Null
}
if (-not (Wait-Http 'http://127.0.0.1:18789/' 90)) { throw 'OpenClaw failed to start. Check openclaw\data\logs.' }
Start-Process 'http://127.0.0.1:18788/' | Out-Null

Start-AppProcess 'rag-service' (Join-Path $Root 'app\rag-service\dist\main.js') (Join-Path $Root 'app\rag-service')
if (-not (Wait-Http 'http://127.0.0.1:8787/health' 60)) { throw 'RAG service failed to start. Check data\logs.' }
# 便携包默认走 Chrome 扩展 + 本地 WebSocket。这样客服使用自己的真实 Chrome 登录态，
# 不需要 Playwright 重新登录，也能避开平台对自动化浏览器的风控。
$env:RPA_MOCK_MODE = 'extension'
Start-AppProcess 'api' (Join-Path $Root 'app\backend\dist\main.js') (Join-Path $Root 'app\backend')
if (-not (Wait-Http 'http://127.0.0.1:3001/health' 60)) { throw 'API service failed to start. Check data\logs.' }

Start-Process 'http://127.0.0.1:8787/kb-admin' | Out-Null
Start-Process 'http://127.0.0.1:3001/rpa/extension/status' | Out-Null
Start-Process (Join-Path $Root 'docs\project-flow.html') | Out-Null
Write-Host 'Customer AI workspace is running.' -ForegroundColor Green
Write-Host 'Knowledge Base: http://127.0.0.1:8787/kb-admin'
Write-Host 'API:            http://127.0.0.1:3001/health'
Write-Host 'OpenClaw:       http://127.0.0.1:18789/'
Write-Host 'RPA Extension:  extensions\customer-ai-rpa'
