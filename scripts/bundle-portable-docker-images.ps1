# @file scripts/bundle-portable-docker-images.ps1
# @module 数据库、共享包与交付
# @description 向已有便携包写入 Postgres/Redis 镜像 tar，供离线首次启动 docker load。
# @see 联动关注：build-windows-portable.ps1、Start-Customer-AI.ps1。
#Requires -Version 5.1
# Keep comments ASCII-only for Windows PowerShell 5.1 UTF-8-without-BOM.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackageRoot
)

$ErrorActionPreference = 'Stop'
$PackageRoot = (Resolve-Path -LiteralPath $PackageRoot).Path
$docker = Get-Command docker.exe -ErrorAction Stop
$outDir = Join-Path $PackageRoot 'runtime\docker-images'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$specs = @(
  @{ Ref = 'pgvector/pgvector:pg16'; File = 'pgvector-pg16.tar' },
  @{ Ref = 'redis:7-alpine'; File = 'redis-7-alpine.tar' }
)

$pullPrefixes = @('', 'docker.1ms.run/', 'docker.m.daocloud.io/')
foreach ($spec in $specs) {
  Write-Host ("Ensuring {0} ..." -f $spec.Ref) -ForegroundColor Cyan
  $oldPref = $ErrorActionPreference
  $ErrorActionPreference = 'SilentlyContinue'
  & $docker.Source image inspect $spec.Ref | Out-Null
  $inspectCode = $LASTEXITCODE
  $ErrorActionPreference = $oldPref
  if ($inspectCode -ne 0) {
    $pulled = $false
    foreach ($prefix in $pullPrefixes) {
      $source = if ($prefix) { "$prefix$($spec.Ref)" } else { $spec.Ref }
      Write-Host ("Pulling {0} ..." -f $source) -ForegroundColor Yellow
      $ErrorActionPreference = 'SilentlyContinue'
      & $docker.Source pull $source | Out-Null
      $pullCode = $LASTEXITCODE
      $ErrorActionPreference = $oldPref
      if ($pullCode -ne 0) { continue }
      if ($source -ne $spec.Ref) {
        & $docker.Source tag $source $spec.Ref
        if ($LASTEXITCODE -ne 0) { continue }
      }
      $pulled = $true
      break
    }
    if (-not $pulled) { throw "docker pull failed: $($spec.Ref) (Hub + mirrors)" }
  }
  $tarPath = Join-Path $outDir $spec.File
  if (Test-Path -LiteralPath $tarPath) { Remove-Item -LiteralPath $tarPath -Force }
  & $docker.Source save -o $tarPath $spec.Ref
  if ($LASTEXITCODE -ne 0) { throw "docker save failed: $($spec.Ref)" }
  Write-Host ("Saved {0} ({1:N0} MB)" -f $tarPath, ((Get-Item -LiteralPath $tarPath).Length / 1MB)) -ForegroundColor Green
}

Write-Host 'Done. Recipients can Start without Docker Hub if these tars are present.' -ForegroundColor Green
