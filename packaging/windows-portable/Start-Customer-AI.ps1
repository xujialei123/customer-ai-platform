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

function Test-DockerImagePresent([string]$ImageRef) {
  return (Invoke-Docker -DockerArgs @('image', 'inspect', $ImageRef)) -eq 0
}

# Load bundled image tars from runtime\docker-images when local images are missing.
# This is how handoff packages start without Docker Hub access.
function Ensure-BundledDockerImages {
  $dir = Join-Path $Root 'runtime\docker-images'
  $specs = @(
    @{ Ref = 'pgvector/pgvector:pg16'; File = 'pgvector-pg16.tar' },
    @{ Ref = 'redis:7-alpine'; File = 'redis-7-alpine.tar' }
  )
  $missing = [System.Collections.Generic.List[string]]::new()
  foreach ($spec in $specs) {
    if (Test-DockerImagePresent $spec.Ref) {
      Write-Host ("Docker: image ready {0}" -f $spec.Ref) -ForegroundColor DarkGray
      continue
    }
    $tarPath = Join-Path $dir $spec.File
    if (-not (Test-Path -LiteralPath $tarPath)) {
      $missing.Add($spec.Ref) | Out-Null
      continue
    }
    Write-Host ("Docker: loading bundled {0} ..." -f $spec.File) -ForegroundColor Yellow
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $loadOut = & $DockerExe load -i $tarPath 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $oldPreference
    if ($code -ne 0) {
      Write-Host '--- docker load output ---' -ForegroundColor Red
      foreach ($line in @($loadOut)) { Write-Host ("  {0}" -f $line) -ForegroundColor DarkYellow }
      throw ("Failed to docker load {0}" -f $spec.File)
    }
    if (-not (Test-DockerImagePresent $spec.Ref)) {
      throw ("Loaded {0} but image {1} still missing. Tar may be corrupt." -f $spec.File, $spec.Ref)
    }
    Write-Host ("Docker: loaded {0}" -f $spec.Ref) -ForegroundColor Green
  }
  if ($missing.Count -gt 0) {
    Write-Host ('Docker: no bundled tar for: {0}. compose will try registry pull.' -f ($missing -join ', ')) -ForegroundColor Yellow
    Write-Host 'For handoff packages, rebuild with: pnpm package:windows -- -RequireDockerImages' -ForegroundColor Yellow
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

  # Missing containers: compose up recreates them (pulls images if local cache is empty).
  Write-Host 'Docker: containers missing, running compose up -d ...' -ForegroundColor Yellow
  Push-Location $Root
  try {
    $oldPreference = $ErrorActionPreference
    $ErrorActionPreference = 'SilentlyContinue'
    $composeOut = & $DockerExe compose up -d 2>&1
    $code = $LASTEXITCODE
    $ErrorActionPreference = $oldPreference
    if ($code -ne 0) {
      $postgresRunning = Test-ContainerRunning $PostgresContainer
      $redisRunning = Test-ContainerRunning $RedisContainer
      if ($postgresRunning -and $redisRunning) {
        Write-Host 'Docker: compose reported conflict but required containers are running; continuing.' -ForegroundColor DarkGray
        return
      }
      Write-Host ''
      Write-Host '--- docker compose up output ---' -ForegroundColor Red
      foreach ($line in @($composeOut)) { Write-Host ("  {0}" -f $line) -ForegroundColor DarkYellow }
      Write-Host '--------------------------------' -ForegroundColor Red
      throw (@(
        'Docker compose up failed.',
        '',
        'Deleting containers is fine: Start will recreate them via docker-compose.yml.',
        'If images were also removed, Docker must pull pgvector/pgvector:pg16 and redis:7-alpine.',
        'Pull failure usually means Docker Hub is unreachable — configure a registry mirror in Docker Desktop,',
        'or pull when the network works, then run Start again.'
      ) -join [Environment]::NewLine)
    }
  } finally { Pop-Location }

  if (-not (Test-ContainerRunning $PostgresContainer) -or -not (Test-ContainerRunning $RedisContainer)) {
    throw 'Docker services failed to start. Check Docker Desktop.'
  }
}

function Wait-PostgresReady([int]$Seconds = 90) {
  for ($index = 0; $index -lt $Seconds; $index += 2) {
    if ((Invoke-Docker -DockerArgs @('exec', $PostgresContainer, 'pg_isready', '-U', 'postgres')) -eq 0) {
      return $true
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Get-PackagedDatabaseName {
  $url = Read-PackagedEnvValue 'DATABASE_URL'
  if ([string]::IsNullOrWhiteSpace($url)) { return 'customer_ai' }
  # postgresql://user:pass@host:port/dbname?schema=public
  if ($url -match '/([^/?]+)(\?|$)') { return $Matches[1] }
  return 'customer_ai'
}

function Test-ApiBusinessTablesExist([string]$DatabaseName) {
  $oldPreference = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  try {
    $result = & $DockerExe exec $PostgresContainer psql -U postgres -d $DatabaseName -tAc "SELECT to_regclass('public.shops')" 2>$null
    return ([string]$result).Trim() -match 'shops'
  } finally {
    $ErrorActionPreference = $oldPreference
  }
}

# Empty DB / new volume: apply Prisma migrations for API tables.
# RAG tables are still created by rag-service via scripts/init-db.sql on startup.
function Ensure-DatabaseSchema {
  if (-not (Wait-PostgresReady 90)) {
    throw 'PostgreSQL is not ready. Check Docker container customer-ai-postgres.'
  }

  $databaseName = Get-PackagedDatabaseName
  if (Test-ApiBusinessTablesExist $databaseName) {
    Write-Host 'Database: business tables already present.' -ForegroundColor DarkGray
    return
  }

  $backendDir = Join-Path $Root 'app\backend'
  $schemaPath = Join-Path $backendDir 'prisma\schema.prisma'
  $prismaJs = Join-Path $backendDir 'node_modules\prisma\build\index.js'
  $databaseUrl = Read-PackagedEnvValue 'DATABASE_URL'
  if ([string]::IsNullOrWhiteSpace($databaseUrl)) {
    $databaseUrl = 'postgresql://postgres:postgres@127.0.0.1:5433/customer_ai?schema=public'
  }

  if ((Test-Path -LiteralPath $prismaJs) -and (Test-Path -LiteralPath $schemaPath)) {
    Write-Host 'Database: empty schema detected, running prisma migrate deploy...' -ForegroundColor Yellow
    $prevUrl = $env:DATABASE_URL
    $env:DATABASE_URL = $databaseUrl
    Push-Location $backendDir
    try {
      $oldPreference = $ErrorActionPreference
      $ErrorActionPreference = 'SilentlyContinue'
      $migrateOut = & $NodeExe $prismaJs migrate deploy --schema $schemaPath 2>&1
      $code = $LASTEXITCODE
      $ErrorActionPreference = $oldPreference
      if ($code -ne 0) {
        Write-Host '--- prisma migrate deploy output ---' -ForegroundColor Red
        foreach ($line in @($migrateOut)) { Write-Host ("  {0}" -f $line) -ForegroundColor DarkYellow }
        throw 'Prisma migrate deploy failed. Check DATABASE_URL and PostgreSQL logs.'
      }
    } finally {
      Pop-Location
      if ($null -eq $prevUrl -or $prevUrl -eq '') {
        Remove-Item Env:\DATABASE_URL -ErrorAction SilentlyContinue
      } else {
        $env:DATABASE_URL = $prevUrl
      }
    }
  } else {
    # Fallback when prisma CLI is absent: apply migration SQL in name order (empty DB only).
    Write-Host 'Database: Prisma CLI missing, applying migration SQL via docker exec...' -ForegroundColor Yellow
    $migrationsDir = Join-Path $backendDir 'prisma\migrations'
    if (-not (Test-Path -LiteralPath $migrationsDir)) {
      throw 'Database migrations folder missing: app\backend\prisma\migrations'
    }
    $dirs = Get-ChildItem -LiteralPath $migrationsDir -Directory | Sort-Object Name
    foreach ($dir in $dirs) {
      $sqlPath = Join-Path $dir.FullName 'migration.sql'
      if (-not (Test-Path -LiteralPath $sqlPath)) { continue }
      Write-Host ("Database: applying {0}..." -f $dir.Name) -ForegroundColor DarkGray
      $oldPreference = $ErrorActionPreference
      $ErrorActionPreference = 'SilentlyContinue'
      Get-Content -LiteralPath $sqlPath -Raw -Encoding utf8 | & $DockerExe exec -i $PostgresContainer psql -U postgres -d $databaseName -v 'ON_ERROR_STOP=1' 2>&1 | Out-Null
      $code = $LASTEXITCODE
      $ErrorActionPreference = $oldPreference
      if ($code -ne 0) {
        throw ("Failed applying SQL migration: {0}" -f $dir.Name)
      }
    }
  }

  if (-not (Test-ApiBusinessTablesExist $databaseName)) {
    throw 'Database schema still missing after migrate. Check data\logs and PostgreSQL.'
  }
  Write-Host 'Database: business tables ready.' -ForegroundColor Green
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

Ensure-BundledDockerImages

Ensure-DockerServices

Ensure-DatabaseSchema

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
