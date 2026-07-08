#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$OutputPath = '',
  [string]$OpenClawSource = 'F:\OpenClaw-USB-Portable',
  [string]$PnpmCommand = '',
  [switch]$CreateZip
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path
if (-not $OutputPath) {
  $stamp = [DateTime]::Now.ToString('yyyyMMdd-HHmmss')
  $OutputPath = Join-Path $Root "release\Customer-AI-Portable-$stamp"
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$OpenClawSource = [IO.Path]::GetFullPath($OpenClawSource)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ($OutputPath -eq $Root -or $OutputPath -eq $OpenClawSource -or [IO.Path]::GetPathRoot($OutputPath) -eq $OutputPath) {
  throw 'Unsafe output path. Cleanup refused.'
}
if (-not (Test-Path -LiteralPath (Join-Path $OpenClawSource 'Start-OpenClaw.ps1'))) {
  throw "OpenClaw portable package is incomplete: $OpenClawSource"
}

function Invoke-Pnpm([string[]]$Arguments) {
  $pnpm = if ($PnpmCommand) { $PnpmCommand } else { (Get-Command pnpm.cmd -ErrorAction Stop).Source }
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    & $pnpm @Arguments
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -lt 3) { Start-Sleep -Seconds 3 }
  }
  throw "pnpm failed: $($Arguments -join ' ')"
}

function Copy-Tree([string]$Source, [string]$Destination, [string[]]$ExcludeDirectories = @()) {
  $args = @($Source, $Destination, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NP')
  if ($ExcludeDirectories.Count) { $args += '/XD'; $args += $ExcludeDirectories }
  & robocopy @args | Out-Null
  if ($LASTEXITCODE -gt 7) { throw "Directory copy failed: $Source" }
}

function Set-EnvValue([string]$Text, [string]$Name, [string]$Value) {
  $line = "$Name=$Value"
  if ($Text -match "(?m)^$([regex]::Escape($Name))=") {
    return [regex]::Replace($Text, "(?m)^$([regex]::Escape($Name))=.*$", $line)
  }
  return "$Text`r`n$line"
}

Write-Host '1/6 Building project...' -ForegroundColor Cyan
Push-Location $Root
try { Invoke-Pnpm @('build:all') } finally { Pop-Location }

if (Test-Path -LiteralPath $OutputPath) { throw 'Output path already exists. Choose a new directory.' }
New-Item -ItemType Directory -Path $OutputPath -Force | Out-Null

Write-Host '2/6 Deploying production dependencies...' -ForegroundColor Cyan
Push-Location $Root
try {
  Invoke-Pnpm @('--config.node-linker=hoisted', '--filter', '@customer-ai/api', 'deploy', (Join-Path $OutputPath 'app\api'), '--prod')
  Invoke-Pnpm @('--config.node-linker=hoisted', '--filter', '@customer-ai/rag-service', 'deploy', (Join-Path $OutputPath 'app\rag-service'), '--prod')
} finally { Pop-Location }

# pnpm deploy copies @prisma/client but not the generated schema-specific client directory.
$generatedPrisma = Get-ChildItem -LiteralPath (Join-Path $Root 'node_modules\.pnpm') -Directory -Filter '.prisma' -Recurse `
  | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'client') } `
  | Select-Object -First 1 -ExpandProperty FullName
if (-not $generatedPrisma) {
  throw 'Generated Prisma client is missing. Run prisma generate before packaging.'
}
Copy-Tree $generatedPrisma (Join-Path $OutputPath 'app\api\node_modules\.prisma')

Write-Host '3/6 Copying sanitized OpenClaw runtime...' -ForegroundColor Cyan
Copy-Tree $OpenClawSource (Join-Path $OutputPath 'openclaw') @((Join-Path $OpenClawSource 'data'))
New-Item -ItemType Directory -Path (Join-Path $OutputPath 'openclaw\data') -Force | Out-Null

Write-Host '4/6 Copying config and launchers...' -ForegroundColor Cyan
Copy-Item -LiteralPath (Join-Path $Root 'docker-compose.yml') -Destination $OutputPath
Copy-Tree (Join-Path $Root 'config') (Join-Path $OutputPath 'config')
Copy-Tree (Join-Path $Root 'samples') (Join-Path $OutputPath 'samples')
New-Item -ItemType Directory -Path (Join-Path $OutputPath 'scripts') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $Root 'scripts\init-db.sql') -Destination (Join-Path $OutputPath 'scripts\init-db.sql')
Copy-Item -Path (Join-Path $Root 'packaging\windows-portable\*') -Destination $OutputPath -Force
New-Item -ItemType Directory -Path (Join-Path $OutputPath 'data\logs'), (Join-Path $OutputPath 'data\sessions') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $OutputPath 'app\rag-service\uploads') -Force | Out-Null

Write-Host '5/6 Generating secret-free config...' -ForegroundColor Cyan
$envText = [IO.File]::ReadAllText((Join-Path $Root '.env.example'), [Text.Encoding]::UTF8)
$values = [ordered]@{
  NODE_ENV = 'production'
  LLM_PROVIDER = 'openclaw'
  OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
  OPENCLAW_TOKEN = ''
  OPENCLAW_PORTABLE_ROOT = '.\openclaw'
  OPENCLAW_TOKEN_FILE = '.\openclaw\data\.openclaw\gateway-token.txt'
  OPENCLAW_AUTO_START = 'true'
  OPENCLAW_TIMEOUT_MS = '30000'
  ORDER_ADAPTER_MODE = 'mock'
  AUTO_REPLY_ENABLED = 'false'
  RPA_AUTO_SEND_ENABLED = 'false'
  MEITUAN_RPA_ENABLED = 'true'
  MEITUAN_RPA_USER_DATA_DIR = '.\data\sessions\meituan-production'
}
foreach ($entry in $values.GetEnumerator()) { $envText = Set-EnvValue $envText $entry.Key $entry.Value }
[IO.File]::WriteAllText((Join-Path $OutputPath '.env'), $envText, $utf8NoBom)

$buildInfo = @(
  'Customer AI Windows Portable',
  "BuiltAt=$([DateTime]::Now.ToString('s'))",
  'OpenClawDataIncluded=false',
  'ProjectEnvIncluded=false',
  'RpaSessionIncluded=false'
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $OutputPath 'BUILD-INFO.txt'), $buildInfo, $utf8NoBom)

Write-Host '6/6 Checking for sensitive files...' -ForegroundColor Cyan
$forbidden = @(
  (Join-Path $OutputPath 'openclaw\data\.openclaw\gateway-token.txt'),
  (Join-Path $OutputPath 'data\sessions\meituan-production\Default\Network\Cookies')
)
foreach ($path in $forbidden) {
  if (Test-Path -LiteralPath $path) { throw "Sensitive file must not be packaged: $path" }
}

if ($CreateZip) {
  $zipPath = "$OutputPath.zip"
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -LiteralPath $OutputPath -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host "ZIP: $zipPath" -ForegroundColor Green
}

Write-Host "Portable package created: $OutputPath" -ForegroundColor Green
