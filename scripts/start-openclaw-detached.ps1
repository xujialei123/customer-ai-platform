#Requires -Version 5.1
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$OpenClawRoot
)

$ErrorActionPreference = 'Stop'
$startScript = Join-Path $OpenClawRoot 'Start-OpenClaw.ps1'
if (-not (Test-Path -LiteralPath $startScript)) { throw 'Start-OpenClaw.ps1 is missing.' }

# Native Start-Process keeps the foreground gateway alive after this small wrapper exits.
Start-Process -FilePath 'powershell.exe' -ArgumentList @(
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', ('"' + $startScript + '"'),
  '-NoBrowser'
) -WorkingDirectory $OpenClawRoot -WindowStyle Hidden | Out-Null
