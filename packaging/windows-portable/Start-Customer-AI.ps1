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

function Test-ContainerRunning([string]$Name) {
  $state = & docker inspect -f '{{.State.Running}}' $Name 2>$null
  return $state -eq 'true'
}

function Ensure-DockerServices {
  $postgresUp = Test-ContainerRunning 'customer-ai-postgres'
  $redisUp = Test-ContainerRunning 'customer-ai-redis'
  if ($postgresUp -and $redisUp) {
    Write-Host 'Docker: reusing existing customer-ai-postgres and customer-ai-redis.' -ForegroundColor DarkGray
    return
  }
  Push-Location $Root
  try { docker compose up -d } finally { Pop-Location }
  if (-not (Test-ContainerRunning 'customer-ai-postgres') -or -not (Test-ContainerRunning 'customer-ai-redis')) {
    throw 'Docker services failed to start. Check Docker Desktop.'
  }
}

function Test-PortListening([int]$Port) {
  $portMatches = netstat -ano | Select-String -Pattern "127\.0\.0\.1:$Port\s+.*LISTENING"
  return [bool]$portMatches
}

function Ensure-OpenClawGateway {
  $portableTokenFile = Join-Path $Root 'openclaw\data\.openclaw\gateway-token.txt'
  $gatewayAlreadyRunning = Wait-Http 'http://127.0.0.1:18789/' 2
  if ($gatewayAlreadyRunning) {
    if (Test-Path -LiteralPath $portableTokenFile) {
      Write-Host 'OpenClaw: reusing portable gateway already running.' -ForegroundColor DarkGray
      return
    }
    # Reuse dev OpenClaw when pnpm dev already started the gateway on this machine.
    $devOpenClawRoots = @(
      (Join-Path $Root '..\OpenClaw-USB-Portable'),
      'F:\OpenClaw-USB-Portable'
    )
    foreach ($devRoot in $devOpenClawRoots) {
      $devToken = Join-Path $devRoot 'data\.openclaw\gateway-token.txt'
      if (-not (Test-Path -LiteralPath $devToken)) { continue }
      Ensure-Dir @((Split-Path -Parent $portableTokenFile))
      Copy-Item -LiteralPath $devToken -Destination $portableTokenFile -Force
      Write-Host "OpenClaw: reusing existing gateway on 18789 (token from $devRoot)." -ForegroundColor DarkGray
      return
    }
    throw 'Port 18789 is used by another OpenClaw instance. Stop the dev OpenClaw before starting this package.'
  }
  Start-Process -FilePath 'powershell' -ArgumentList @(
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    ('"' + (Join-Path $Root 'openclaw\Start-OpenClaw.ps1') + '"'), '-NoBrowser'
  ) -WorkingDirectory (Join-Path $Root 'openclaw') -WindowStyle Hidden | Out-Null
}

function Ensure-PortAvailable([int]$Port, [string]$Hint) {
  if (Test-PortListening $Port) {
    throw "Port $Port is already in use. $Hint"
  }
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

Ensure-DockerServices

Ensure-OpenClawGateway
if (-not (Wait-Http 'http://127.0.0.1:18789/' 90)) { throw 'OpenClaw failed to start. Check openclaw\data\logs.' }

Ensure-PortAvailable 8787 'Stop the dev RAG service (pnpm dev) before starting the portable package.'
Ensure-PortAvailable 3001 'Stop the dev API service (pnpm dev) before starting the portable package.'

Start-AppProcess 'rag-service' (Join-Path $Root 'app\rag-service\dist\main.js') (Join-Path $Root 'app\rag-service')
if (-not (Wait-Http 'http://127.0.0.1:8787/health' 60)) { throw 'RAG service failed to start. Check data\logs.' }
# Extension mode: real Chrome login + local WebSocket, no Playwright relogin.
$env:RPA_MOCK_MODE = 'extension'
Start-AppProcess 'api' (Join-Path $Root 'app\backend\dist\main.js') (Join-Path $Root 'app\backend')
if (-not (Wait-Http 'http://127.0.0.1:3001/health' 60)) { throw 'API service failed to start. Check data\logs.' }

Start-Process 'http://127.0.0.1:3001/guide' | Out-Null
Write-Host 'Guide:          http://127.0.0.1:3001/guide' -ForegroundColor Green
Write-Host 'Customer AI workspace is running.' -ForegroundColor Green
Write-Host 'Knowledge Base: http://127.0.0.1:8787/kb-admin'
Write-Host 'API:            http://127.0.0.1:3001/health'
Write-Host 'OpenClaw:       http://127.0.0.1:18789/'
Write-Host 'RPA Extension:  extensions\customer-ai-rpa'
