#Requires -Version 5.1
<#
.SYNOPSIS
  Package RustShell for Windows (frontend + Tauri release bundle).

.DESCRIPTION
  Runs from the repo root (or this scripts folder). Produces:
    - target\release\rustshell.exe
    - target\release\bundle\nsis\RustShell_*_x64-setup.exe
    - target\release\bundle\msi\RustShell_*_x64_en-US.msi

.PARAMETER Targets
  Tauri bundle targets. Default: nsis (installer). Use "all" for NSIS + MSI.

.PARAMETER SkipNpmInstall
  Skip npm install if node_modules is already good.

.EXAMPLE
  .\scripts\package.ps1
  .\scripts\package.ps1 -Targets all
  .\scripts\package.ps1 -SkipNpmInstall
#>
param(
  [ValidateSet("nsis", "msi", "all")]
  [string]$Targets = "nsis",
  [switch]$SkipNpmInstall
)

$ErrorActionPreference = "Stop"

function Assert-Command([string]$Name) {
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Required command not found: $Name. Install it and ensure it is on PATH."
  }
}

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot
Write-Host "==> Repo: $RepoRoot" -ForegroundColor Cyan

Assert-Command node
Assert-Command npm
Assert-Command cargo
Assert-Command rustc

$nodeVer = (node -v)
$cargoVer = (cargo --version)
Write-Host "==> node $nodeVer | $cargoVer" -ForegroundColor DarkGray

# Prefer local node_modules CLI, then cargo-tauri / global tauri, else npx.
$localTauri = Join-Path $RepoRoot "node_modules\.bin\tauri.cmd"
function Invoke-Tauri {
  param([Parameter(ValueFromRemainingArguments = $true)][string[]]$TauriArgs)
  if (Test-Path $localTauri) {
    & $localTauri @TauriArgs
  } elseif (Get-Command cargo-tauri -ErrorAction SilentlyContinue) {
    & cargo tauri @TauriArgs
  } elseif (Get-Command tauri -ErrorAction SilentlyContinue) {
    & tauri @TauriArgs
  } else {
    Write-Host "==> Using npx @tauri-apps/cli@2" -ForegroundColor Yellow
    & npx --yes "@tauri-apps/cli@2" @TauriArgs
  }
}

if (-not $SkipNpmInstall) {
  Write-Host "==> npm install" -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

Write-Host "==> Frontend build (vite)" -ForegroundColor Cyan
npm run build
if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }

# Tauri 2 CLI accepts msi/nsis only — expand "all" to both.
$bundleArgs = switch ($Targets) {
  "nsis" { @("nsis") }
  "msi"  { @("msi") }
  "all"  { @("nsis", "msi") }
}

Write-Host ("==> Tauri release build (targets={0})" -f ($bundleArgs -join ",")) -ForegroundColor Cyan
# beforeBuildCommand in tauri.conf already runs npm.cmd run build; dist already exists so that is fine
Invoke-Tauri build --bundles @bundleArgs
if ($LASTEXITCODE -ne 0) { throw "tauri build failed" }

Write-Host ""
Write-Host "==> Done. Artifacts:" -ForegroundColor Green
$exe = Join-Path $RepoRoot "target\release\rustshell.exe"
if (Test-Path $exe) {
  $item = Get-Item $exe
  Write-Host ("  EXE  {0:N1} MB  {1}" -f ($item.Length / 1MB), $item.FullName)
}

Get-ChildItem -Path (Join-Path $RepoRoot "target\release\bundle") -Recurse -Include *.exe,*.msi -ErrorAction SilentlyContinue |
  ForEach-Object {
    Write-Host ("  PKG  {0:N1} MB  {1}" -f ($_.Length / 1MB), $_.FullName)
  }

Write-Host ""
Write-Host "Tip: open target\release\bundle\nsis for the installer." -ForegroundColor DarkGray
