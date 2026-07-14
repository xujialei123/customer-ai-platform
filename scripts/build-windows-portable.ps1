# @file scripts/build-windows-portable.ps1
# @module 数据库、共享包与交付
# @description 组装 Windows 便携包：构建、依赖、OpenClaw、扩展和文档。
# @see 联动关注：排除敏感 data，输出 release 目录。
#Requires -Version 5.1
[CmdletBinding()]
param(
  [string]$OutputPath = '',
  [string]$OpenClawSource = 'F:\OpenClaw-USB-Portable',
  [string]$PnpmCommand = '',
  [switch]$CreateZip,
  # 交付给外部客户时打开：强制关闭自动发送，忽略开发机 .env 里的开关。
  [switch]$SafeSendDefaults
)

$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path -LiteralPath (Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..')).Path
if (-not $OutputPath) {
  $stamp = [DateTime]::Now.ToString('yyyyMMdd-HHmmss')
  $OutputPath = Join-Path $Root "release\Customer-AI-Portable-$stamp"
}
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$PackageRoot = $OutputPath
$env:CUSTOMER_AI_PACKAGE_ROOT = $PackageRoot
$OpenClawSource = [IO.Path]::GetFullPath($OpenClawSource)
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$env:CI = 'true'
$env:npm_config_confirm_modules_purge = 'false'

if ($PackageRoot -eq $Root -or $PackageRoot -eq $OpenClawSource -or [IO.Path]::GetPathRoot($PackageRoot) -eq $PackageRoot) {
  throw 'Unsafe output path. Cleanup refused.'
}
if (-not (Test-Path -LiteralPath (Join-Path $OpenClawSource 'Start-OpenClaw.ps1'))) {
  throw "OpenClaw portable package is incomplete: $OpenClawSource"
}

function Invoke-Pnpm([string[]]$Arguments) {
  $pnpm = $PnpmCommand
  if (-not $pnpm) {
    # Codex 自带 pnpm wrapper 会在执行脚本前触发额外依赖检查；打包时优先使用用户系统 pnpm，
    # 避免因为开发环境中的 node_modules 文件锁导致交付包构建被中断。
    $pnpm = 'E:\nodejs\node_global\pnpm.cmd'
  }
  if (-not $pnpm) { $pnpm = (Get-Command pnpm.cmd -ErrorAction Stop).Source }
  if (Test-Path -LiteralPath 'E:\nodejs\node.exe') {
    $env:PATH = "E:\nodejs;$env:PATH"
  }
  # 打包通常运行在双击脚本或 Codex 非交互环境中，pnpm 不能弹出 node_modules 清理确认。
  # 显式关闭该确认，避免实际构建还没开始就因为没有 TTY 中断。
  $env:npm_config_confirm_modules_purge = 'false'
  for ($attempt = 1; $attempt -le 3; $attempt += 1) {
    & $pnpm '--config.confirm-modules-purge=false' @Arguments
    if ($LASTEXITCODE -eq 0) { return }
    if ($attempt -lt 3) { Start-Sleep -Seconds 3 }
  }
  throw "pnpm failed: $($Arguments -join ' ')"
}

function Invoke-Tsc([string]$Project) {
  $tsc = Join-Path $Root 'node_modules\.bin\tsc.cmd'
  if (-not (Test-Path -LiteralPath $tsc)) { throw 'TypeScript compiler is missing. Run pnpm install first.' }
  & $tsc -p (Join-Path $Root $Project)
  if ($LASTEXITCODE -ne 0) { throw "tsc failed: $Project" }
}

function Invoke-PrismaGenerate {
  $prisma = Join-Path $Root 'node_modules\.bin\prisma.cmd'
  if (-not (Test-Path -LiteralPath $prisma)) {
    $prisma = Join-Path $Root 'apps\api\node_modules\.bin\prisma.cmd'
  }
  if (-not (Test-Path -LiteralPath $prisma)) { throw 'Prisma CLI is missing. Run pnpm install first.' }
  # 便携包需要把 schema 专属 Prisma Client 一起复制进去，因此打包时主动生成一次。
  & $prisma generate --schema (Join-Path $Root 'apps\api\prisma\schema.prisma')
  if ($LASTEXITCODE -ne 0) { throw 'prisma generate failed.' }
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

function Get-RootEnvValue([string]$Name) {
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

function Resolve-PackagedEnvValue([string]$Name, [string]$Default, [switch]$SafeSendDefaults) {
  if ($SafeSendDefaults -and ($Name -eq 'AUTO_REPLY_ENABLED' -or $Name -eq 'RPA_AUTO_SEND_ENABLED')) {
    return 'false'
  }
  $fromDev = Get-RootEnvValue $Name
  if ($null -ne $fromDev -and $fromDev -ne '') { return $fromDev }
  return $Default
}

Write-Host '1/6 Building project...' -ForegroundColor Cyan
Push-Location $Root
try {
  # 交付构建直接调用 tsc，避免 pnpm 在已有开发进程占用 node_modules 时触发 install/清理。
  Invoke-Tsc 'packages\shared\tsconfig.json'
  Invoke-Tsc 'packages\rpa-sdk\tsconfig.json'
  Invoke-Tsc 'apps\api\tsconfig.json'
  Invoke-Tsc 'services\rag-service\tsconfig.json'
  Invoke-PrismaGenerate
} finally { Pop-Location }

if (Test-Path -LiteralPath $PackageRoot) { throw 'Output path already exists. Choose a new directory.' }
New-Item -ItemType Directory -Path $PackageRoot -Force | Out-Null

Write-Host '2/6 Deploying production dependencies...' -ForegroundColor Cyan
Write-Host "Package root: ${PackageRoot}" -ForegroundColor DarkGray
$env:CUSTOMER_AI_PACKAGE_ROOT = $PackageRoot
Push-Location $Root
try {
  # pnpm v10 之后 deploy 默认要求 injected workspace；本项目交付包使用 legacy deploy 即可。
  # 某些 Windows PowerShell 5.1 环境中，进入 try 后第一条局部赋值可能被外部批处理污染；先做一次无害赋值。
  $warmupDeployValue = 'warmup'
  $backendTarget = $env:CUSTOMER_AI_PACKAGE_ROOT + '\app\backend'
  $ragTarget = $env:CUSTOMER_AI_PACKAGE_ROOT + '\app\rag-service'
  Write-Host ('API deploy path: ' + $backendTarget) -ForegroundColor DarkGray
  Remove-Item -LiteralPath $backendTarget -Recurse -Force -ErrorAction SilentlyContinue
  Invoke-Pnpm @('--config.node-linker=hoisted', '--filter', '@customer-ai/api', 'deploy', $backendTarget, '--prod')

  Write-Host ('RAG deploy path: ' + $ragTarget) -ForegroundColor DarkGray
  Remove-Item -LiteralPath $ragTarget -Recurse -Force -ErrorAction SilentlyContinue
  Invoke-Pnpm @('--config.node-linker=hoisted', '--filter', '@customer-ai/rag-service', 'deploy', $ragTarget, '--prod')
} finally { Pop-Location }

# pnpm deploy 有时只复制依赖包，Prisma 生成物可能在 .prisma/client，也可能在 @prisma/client 包内。
# 两种布局都兼容，确保便携包离开开发机后仍能直接启动。
$prismaClientDir = Get-ChildItem -LiteralPath (Join-Path $Root 'node_modules\.pnpm') -Recurse -Directory -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -eq 'client' -and $_.Parent.Name -eq '.prisma' -and (Test-Path -LiteralPath (Join-Path $_.FullName 'default.js')) } |
  Select-Object -First 1 -ExpandProperty FullName
if ($prismaClientDir) {
  Copy-Tree (Split-Path -Parent $prismaClientDir) (Join-Path $PackageRoot 'app\backend\node_modules\.prisma')
} else {
  $prismaDirs = Get-ChildItem -LiteralPath (Join-Path $Root 'node_modules') -Directory -Filter '.prisma' -Recurse -ErrorAction SilentlyContinue
  $generatedPrisma = $prismaDirs | Where-Object { $_ -and $_.FullName -and (Test-Path -LiteralPath (Join-Path $_.FullName 'client')) } | Select-Object -First 1 -ExpandProperty FullName
  if ($generatedPrisma) {
    Copy-Tree $generatedPrisma (Join-Path $PackageRoot 'app\backend\node_modules\.prisma')
  } else {
    throw 'Generated Prisma client is missing. Run prisma generate before packaging.'
  }
}

Write-Host '3/6 Copying sanitized OpenClaw runtime...' -ForegroundColor Cyan
Copy-Tree $OpenClawSource (Join-Path $PackageRoot 'openclaw') @((Join-Path $OpenClawSource 'data'))
New-Item -ItemType Directory -Path (Join-Path $PackageRoot 'openclaw\data') -Force | Out-Null

Write-Host '4/6 Copying config and launchers...' -ForegroundColor Cyan
Copy-Item -LiteralPath (Join-Path $Root 'docker-compose.yml') -Destination $PackageRoot
Copy-Item -LiteralPath (Join-Path $Root 'README.md') -Destination $PackageRoot
Copy-Tree (Join-Path $Root 'config') (Join-Path $PackageRoot 'config')
Copy-Tree (Join-Path $Root 'docs') (Join-Path $PackageRoot 'docs')
Copy-Tree (Join-Path $Root 'extensions') (Join-Path $PackageRoot 'extensions')
Copy-Tree (Join-Path $Root 'samples') (Join-Path $PackageRoot 'samples')
New-Item -ItemType Directory -Path (Join-Path $PackageRoot 'scripts') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $Root 'scripts\init-db.sql') -Destination (Join-Path $PackageRoot 'scripts\init-db.sql')
Copy-Item -Path (Join-Path $Root 'packaging\windows-portable\*') -Destination $PackageRoot -Force
New-Item -ItemType Directory -Path (Join-Path $PackageRoot 'data\logs'), (Join-Path $PackageRoot 'data\sessions') -Force | Out-Null
New-Item -ItemType Directory -Path (Join-Path $PackageRoot 'app\rag-service\uploads') -Force | Out-Null

Write-Host '5/6 Generating secret-free config...' -ForegroundColor Cyan
$envText = [IO.File]::ReadAllText((Join-Path $Root '.env.example'), [Text.Encoding]::UTF8)
$values = [ordered]@{
  NODE_ENV = 'production'
  LLM_PROVIDER = 'openclaw'
  OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789'
  OPENCLAW_TOKEN = ''
  # Leave portable OpenClaw paths empty; runtime auto-discovers .\openclaw relative to package root.
  OPENCLAW_PORTABLE_ROOT = ''
  OPENCLAW_TOKEN_FILE = ''
  OPENCLAW_AUTO_START = 'true'
  OPENCLAW_TIMEOUT_MS = '30000'
  ORDER_ADAPTER_MODE = 'mock'
  RPA_MOCK_MODE = 'extension'
  AUTO_REPLY_ENABLED = (Resolve-PackagedEnvValue 'AUTO_REPLY_ENABLED' 'false' -SafeSendDefaults:$SafeSendDefaults)
  RPA_AUTO_SEND_ENABLED = (Resolve-PackagedEnvValue 'RPA_AUTO_SEND_ENABLED' 'false' -SafeSendDefaults:$SafeSendDefaults)
  MEITUAN_RPA_ENABLED = 'true'
  MEITUAN_RPA_USER_DATA_DIR = '.\data\sessions\meituan-production'
  MEITUAN_RPA_ALLOWED_CUSTOMERS = (Resolve-PackagedEnvValue 'MEITUAN_RPA_ALLOWED_CUSTOMERS' '')
  DOUYIN_RPA_ALLOWED_CUSTOMERS = (Resolve-PackagedEnvValue 'DOUYIN_RPA_ALLOWED_CUSTOMERS' '')
}
foreach ($optionalKey in @(
  'EMBEDDING_BASE_URL', 'EMBEDDING_API_KEY', 'EMBEDDING_MODEL', 'EMBEDDING_DIM',
  'LLM_API_KEY', 'LLM_MODEL', 'RAG_API_KEY'
)) {
  $fromDev = Get-RootEnvValue $optionalKey
  if ($null -ne $fromDev -and $fromDev -ne '') { $values[$optionalKey] = $fromDev }
}
foreach ($entry in $values.GetEnumerator()) {
  $envText = Set-EnvValue $envText $entry.Key ([string]$entry.Value)
  if (Get-RootEnvValue $entry.Key) {
    Write-Host ("  Preserved {0} from project .env" -f $entry.Key) -ForegroundColor DarkGray
  }
}
[IO.File]::WriteAllText((Join-Path $PackageRoot '.env'), $envText, $utf8NoBom)

$allowlistLocal = Join-Path $Root 'config\rpa-allowlist.local.json'
if (Test-Path -LiteralPath $allowlistLocal) {
  Copy-Item -LiteralPath $allowlistLocal -Destination (Join-Path $PackageRoot 'config\rpa-allowlist.local.json') -Force
  Write-Host '  Preserved config\rpa-allowlist.local.json from project.' -ForegroundColor DarkGray
}

$buildInfo = @(
  'Customer AI Windows Portable',
  "BuiltAt=$([DateTime]::Now.ToString('s'))",
  'OpenClawDataIncluded=false',
  'ProjectEnvIncluded=false',
  'RpaSessionIncluded=false',
  'RpaMode=chrome-extension-websocket',
  'ChromeExtension=extensions\customer-ai-rpa'
) -join "`r`n"
[IO.File]::WriteAllText((Join-Path $PackageRoot 'BUILD-INFO.txt'), $buildInfo, $utf8NoBom)

Write-Host '6/6 Checking for sensitive files...' -ForegroundColor Cyan
$forbidden = @(
  (Join-Path $PackageRoot 'openclaw\data\.openclaw\gateway-token.txt'),
  (Join-Path $PackageRoot 'data\sessions\meituan-production\Default\Network\Cookies')
)
foreach ($path in $forbidden) {
  if (Test-Path -LiteralPath $path) { throw "Sensitive file must not be packaged: $path" }
}

if ($CreateZip) {
  $zipPath = "$PackageRoot.zip"
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
  Compress-Archive -LiteralPath $PackageRoot -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host "ZIP: $zipPath" -ForegroundColor Green
}

Write-Host "Portable package created: $PackageRoot" -ForegroundColor Green
