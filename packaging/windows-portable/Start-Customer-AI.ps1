# @file packaging/windows-portable/Start-Customer-AI.ps1
# @module 数据库、共享包与交付
# @description 便携环境检查与一键启动全部服务（路径与 Docker 均按通用规则发现，不写死本机盘符）。
# @see 联动关注：Docker/便携 Node/RAG/API/扩展状态页。
#Requires -Version 5.1
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath (Split-Path -Parent $MyInvocation.MyCommand.Path)).Path
$NodeExe = Join-Path $Root 'runtime\node-win-x64\node.exe'
$PidDir = Join-Path $Root 'data\.pids'
$LogDir = Join-Path $Root 'data\logs'
$PostgresContainer = 'customer-ai-postgres'
$RedisContainer = 'customer-ai-redis'
$env:CUSTOMER_AI_ROOT = $Root
$env:COMPOSE_PROJECT_NAME = 'customer-ai'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Resolve-DockerCli {
  $cmd = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $candidates = @(
    (Join-Path ${env:ProgramFiles} 'Docker\Docker\resources\bin\docker.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\resources\bin\docker.exe')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  if ($candidates.Count -gt 0) { return $candidates[0] }
  return 'docker'
}

function Resolve-DockerDesktopExe {
  $candidates = [System.Collections.Generic.List[string]]::new()
  $dockerRoots = @(
    (Join-Path ${env:ProgramFiles} 'Docker\Docker'),
    (Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker'),
    (Join-Path $env:LOCALAPPDATA 'Docker')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($dockerRoot in $dockerRoots) {
  $found = Get-ChildItem -LiteralPath $dockerRoot -Recurse -Filter 'Docker Desktop.exe' -ErrorAction SilentlyContinue |
    Select-Object -First 1 -ExpandProperty FullName
    if ($found) { $candidates.Add($found) }
  }

  $candidates.Add((Join-Path ${env:ProgramFiles} 'Docker\Docker\Docker Desktop.exe'))
  $candidates.Add((Join-Path ${env:ProgramFiles(x86)} 'Docker\Docker\Docker Desktop.exe'))
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Docker\Docker Desktop.exe'))

  foreach ($path in ($candidates | Select-Object -Unique)) {
    if ($path -and (Test-Path -LiteralPath $path)) { return $path }
  }
  return $null
}

$DockerExe = Resolve-DockerCli
$DockerBin = Split-Path -Parent $DockerExe
if ($DockerBin) { $env:PATH = "$DockerBin;$env:PATH" }

function Invoke-Docker {
  param([string[]]$DockerArgs)
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    & $DockerExe @DockerArgs 2>&1 | Out-Null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $oldPreference
  }
}

function Ensure-Dir([string[]]$Paths) {
  foreach ($path in $Paths) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
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
  return (Invoke-Docker -DockerArgs @('info')) -eq 0
}

function Start-DockerDesktop {
  if (Test-DockerReady) { return $true }

  # Prefer "docker desktop start" when CLI exists but daemon is not ready.
  if ($DockerExe -and (Test-Path -LiteralPath $DockerExe)) {
    $code = Invoke-Docker -DockerArgs @('desktop', 'start')
    if ($code -eq 0) {
      Write-Host 'Docker: started via "docker desktop start".' -ForegroundColor Yellow
      return $true
    }
  }

  $desktopExe = Resolve-DockerDesktopExe
  if (-not $desktopExe) { return $false }

  Write-Host "Docker: launching $desktopExe" -ForegroundColor Yellow
  try {
    Start-Process -FilePath $desktopExe -WindowStyle Minimized -ErrorAction Stop | Out-Null
  } catch {
    Start-Process -FilePath $desktopExe -ErrorAction Stop | Out-Null
  }
  return $true
}

function Wait-DockerReady([int]$Seconds = 180) {
  for ($index = 0; $index -lt $Seconds; $index += 2) {
    if (Test-DockerReady) { return $true }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Show-DockerManualHint {
  $desktopExe = Resolve-DockerDesktopExe
  $desktopHint = if ($desktopExe) { $desktopExe } else { 'Docker Desktop from Start menu' }
  Write-Host ''
  Write-Host 'Docker is not ready yet. You can start it manually:' -ForegroundColor Yellow
  Write-Host "  1. Open Docker Desktop: $desktopHint"
  Write-Host '  2. Wait until the whale icon shows Running (may take 1-3 minutes).'
  Write-Host '  3. Leave this window open; the script will continue automatically.'
  Write-Host ''
}

function Ensure-DockerReady {
  if (Test-DockerReady) { return }

  Write-Host 'Docker not ready, trying to start automatically...' -ForegroundColor Yellow
  $null = Start-DockerDesktop
  if (Wait-DockerReady 120) { return }

  Show-DockerManualHint
  Write-Host 'Waiting for Docker (up to 10 minutes)...' -ForegroundColor Yellow
  if (Wait-DockerReady 600) { return }

  throw (@(
    'Docker Desktop is still not ready.',
    '',
    'Please start Docker Desktop manually, wait until Running, then run Start-Customer-AI.bat again.',
    'This package needs Docker for PostgreSQL (5433) and Redis (6379).'
  ) -join [Environment]::NewLine)
}

function Test-ContainerExists([string]$Name) {
  return (Invoke-Docker -DockerArgs @('inspect', $Name)) -eq 0
}

function Test-ContainerRunning([string]$Name) {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    $state = & $DockerExe inspect -f '{{.State.Running}}' $Name 2>$null
    return $state -eq 'true'
  } finally {
    $ErrorActionPreference = $oldPreference
  }
}

function Start-AppProcess([string]$Name, [string]$Entry, [string]$WorkingDirectory) {
  $pidFile = Join-Path $PidDir "$Name.pid"
  if (Test-Path -LiteralPath $pidFile) {
    $oldPid = [int]((Get-Content -LiteralPath $pidFile -Encoding utf8 | Select-Object -First 1).Trim())
    if (Get-Process -Id $oldPid -ErrorAction SilentlyContinue) {
      Write-Host ("Restarting {0} (PID {1}) to reload .env..." -f $Name, $oldPid) -ForegroundColor DarkGray
      & taskkill.exe /PID $oldPid /T /F | Out-Null
      Start-Sleep -Seconds 1
    }
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
  }

  $env:CUSTOMER_AI_ROOT = $Root
  $entryArgument = '"' + $Entry.Replace('"', '\"') + '"'
  $process = Start-Process -FilePath $NodeExe -ArgumentList $entryArgument -WorkingDirectory $WorkingDirectory `
    -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $LogDir "$Name.out.log") `
    -RedirectStandardError (Join-Path $LogDir "$Name.err.log")
  [IO.File]::WriteAllText($pidFile, [string]$process.Id, $utf8NoBom)
}

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

function Show-PackagedSendConfig {
  $autoReply = Read-PackagedEnvValue 'AUTO_REPLY_ENABLED'
  $rpaAutoSend = Read-PackagedEnvValue 'RPA_AUTO_SEND_ENABLED'
  $meituanAllow = Read-PackagedEnvValue 'MEITUAN_RPA_ALLOWED_CUSTOMERS'
  Write-Host ("Config (.env): AUTO_REPLY_ENABLED={0}  RPA_AUTO_SEND_ENABLED={1}" -f $(if ($autoReply) { $autoReply } else { 'false' }), $(if ($rpaAutoSend) { $rpaAutoSend } else { 'false' })) -ForegroundColor $(if ($rpaAutoSend -eq 'true') { 'Green' } else { 'Yellow' })
  if ($meituanAllow) {
    Write-Host ("Meituan allowlist: {0}" -f $meituanAllow) -ForegroundColor DarkGray
  }
  if ($rpaAutoSend -ne 'true') {
    Write-Host 'Meituan/Douyin auto-click needs RPA_AUTO_SEND_ENABLED=true in .env, then Stop + Start this package.' -ForegroundColor Yellow
  }
}

function Ensure-DockerServices {
  $postgresRunning = Test-ContainerRunning $PostgresContainer
  $redisRunning = Test-ContainerRunning $RedisContainer
  if ($postgresRunning -and $redisRunning) {
    Write-Host "Docker: reusing $PostgresContainer and $RedisContainer." -ForegroundColor DarkGray
    return
  }

  # Reuse existing stopped containers before compose up (avoids name conflicts).
  $toStart = @()
  if ((Test-ContainerExists $PostgresContainer) -and -not $postgresRunning) { $toStart += $PostgresContainer }
  if ((Test-ContainerExists $RedisContainer) -and -not $redisRunning) { $toStart += $RedisContainer }
  if ($toStart.Count -gt 0) {
    Write-Host ("Docker: starting existing containers: {0}" -f ($toStart -join ",")) -ForegroundColor DarkGray
    $code = -1
    for ($attempt = 1; $attempt -le 5; $attempt++) {
      $code = Invoke-Docker -DockerArgs (@('start') + @($toStart))
      if ($code -eq 0) { break }
      Start-Sleep -Seconds 3
    }
    if ($code -ne 0) { throw ("Docker start failed for: {0}" -f ($toStart -join ",")) }
  }

  $postgresRunning = Test-ContainerRunning $PostgresContainer
  $redisRunning = Test-ContainerRunning $RedisContainer
  if ($postgresRunning -and $redisRunning) { return }

  # First-time setup: compose up with fixed project name.
  Push-Location $Root
  try {
    $code = Invoke-Docker -DockerArgs @('compose', 'up', '-d')
    if ($code -ne 0) {
      $postgresRunning = Test-ContainerRunning $PostgresContainer
      $redisRunning = Test-ContainerRunning $RedisContainer
      if ($postgresRunning -and $redisRunning) {
        Write-Host 'Docker: compose reported conflict but required containers are running; continuing.' -ForegroundColor DarkGray
        return
      }
      throw 'Docker compose up failed. Check Docker Desktop and docker-compose.yml.'
    }
  } finally { Pop-Location }

  if (-not (Test-ContainerRunning $PostgresContainer) -or -not (Test-ContainerRunning $RedisContainer)) {
    throw 'Docker services failed to start. Check Docker Desktop.'
  }
}

function Test-PortListening([int]$Port) {
  $pattern = ":$Port\s+.*LISTENING"
  return [bool](netstat -ano | Select-String -Pattern $pattern)
}

function Show-OpenClawManualHint {
  $startScript = Join-Path $Root 'openclaw\Start-OpenClaw.ps1'
  Write-Host ''
  Write-Host 'OpenClaw gateway (port 18789) is not reachable yet. You can start it manually:' -ForegroundColor Yellow
  Write-Host "  1. Run: $startScript"
  Write-Host '  2. Or start your own OpenClaw instance on http://127.0.0.1:18789/'
  Write-Host '  3. Leave this window open; the script will continue when the gateway is up.'
  Write-Host ''
}

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

function Test-NeedsLocalOpenClaw {
  $provider = (Read-PackagedEnvValue 'LLM_PROVIDER')
  if ([string]::IsNullOrWhiteSpace($provider)) { $provider = 'agnes' }
  return ($provider.Trim().ToLowerInvariant() -eq 'openclaw')
}

function Ensure-OpenClawGateway {
  if (-not (Test-NeedsLocalOpenClaw)) {
    Write-Host 'LLM: direct provider configured; OpenClaw not required.' -ForegroundColor DarkGray
    return
  }

  $gatewayUrl = 'http://127.0.0.1:18789/'
  if (Wait-Http $gatewayUrl 2) {
    Write-Host 'OpenClaw: gateway already reachable on port 18789.' -ForegroundColor DarkGray
    return
  }

  # 交付包不再捆绑 openclaw/；若仍配置 LLM_PROVIDER=openclaw，只等待客户自备网关。
  $startScript = Join-Path $Root 'openclaw\Start-OpenClaw.ps1'
  if (Test-Path -LiteralPath $startScript) {
    Write-Host 'OpenClaw: trying to start automatically...' -ForegroundColor Yellow
    Start-Process -FilePath 'powershell.exe' -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $startScript, '-NoBrowser'
    ) -WorkingDirectory (Join-Path $Root 'openclaw') -WindowStyle Hidden | Out-Null
    if (Wait-Http $gatewayUrl 90) { return }
  }

  Show-OpenClawManualHint
  throw (@(
    'This portable package does not include OpenClaw.',
    'Set LLM_PROVIDER=agnes (or custom) in .env / guide page, or start your own OpenClaw on 18789,',
    'then run Start-Customer-AI.bat again.'
  ) -join [Environment]::NewLine)
}

function Ensure-PortAvailable([int]$Port, [string]$Hint) {
  if (Test-PortListening $Port) {
    throw "Port $Port is already in use. $Hint"
  }
}

Ensure-Dir @($PidDir, $LogDir, (Join-Path $Root 'data\sessions'))
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Portable Node is missing. Rebuild the delivery package.' }

Ensure-DockerReady

Ensure-DockerServices

Ensure-OpenClawGateway

Ensure-PortAvailable 8787 'Stop the dev RAG service (pnpm dev) before starting the portable package.'
Ensure-PortAvailable 3001 'Stop the dev API service (pnpm dev) before starting the portable package.'

Show-PackagedSendConfig

Start-AppProcess 'rag-service' (Join-Path $Root 'app\rag-service\dist\main.js') (Join-Path $Root 'app\rag-service')
if (-not (Wait-Http 'http://127.0.0.1:8787/health' 60)) { throw 'RAG service failed to start. Check data\logs\rag-service.err.log' }

$env:RPA_MOCK_MODE = 'extension'
Start-AppProcess 'api' (Join-Path $Root 'app\backend\dist\main.js') (Join-Path $Root 'app\backend')
if (-not (Wait-Http 'http://127.0.0.1:3001/health' 60)) { throw 'API service failed to start. Check data\logs\api.err.log' }

Start-Process 'http://127.0.0.1:3001/guide' | Out-Null
Write-Host 'Guide:          http://127.0.0.1:3001/guide' -ForegroundColor Green
Write-Host 'Handoff:        http://127.0.0.1:3001/handoff' -ForegroundColor Green
Write-Host 'Customer AI workspace is running.' -ForegroundColor Green
Write-Host 'Knowledge Base: http://127.0.0.1:8787/kb-admin'
Write-Host 'API:            http://127.0.0.1:3001/health'
if (Test-NeedsLocalOpenClaw) {
  Write-Host 'OpenClaw:       http://127.0.0.1:18789/'
} else {
  Write-Host 'LLM:            direct (Agnes / OpenAI-compatible; OpenClaw skipped)'
}
Write-Host 'RPA Extension:  extensions\customer-ai-rpa'
Write-Host 'API logs:       data\logs\api.out.log'
