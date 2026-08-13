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

# Vite 8 needs modern Node. Prefer nvm-windows Node 22 when PATH still points at v14.
$preferredNodeDirs = @(
  "C:\Users\admin\AppData\Local\nvm\v22.12.0",
  "C:\Users\admin\AppData\Local\nvm\v22.14.0",
  "C:\Users\admin\AppData\Local\nvm\v26.0.0"
)
foreach ($dir in $preferredNodeDirs) {
  if (Test-Path (Join-Path $dir "node.exe")) {
    $env:Path = "$dir;" + $env:Path
    break
  }
}

Assert-Command node
Assert-Command npm
Assert-Command cargo
Assert-Command rustc

$nodeVer = (node -v)
$cargoVer = (cargo --version)
Write-Host "==> node $nodeVer | $cargoVer" -ForegroundColor DarkGray
$nodeMajor = [int](($nodeVer.TrimStart("v") -split "\.")[0])
if ($nodeMajor -lt 20) {
  throw "Node $nodeVer is too old for this project (need >= 20). package.ps1 tried nvm v22 but PATH is still old."
}

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

# Hard gate: refuse to package a stale/empty frontend.
# Windows -Filter App-*.js is case-insensitive and also matches app-entry-*.js.
$appJs = Get-ChildItem -Path (Join-Path $RepoRoot "dist\assets") -File |
  Where-Object { $_.Name -cmatch '^App-[A-Za-z0-9_-]+\.js$' } |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $appJs) { throw "dist/assets/App-*.js missing after vite build" }
$appText = Get-Content -LiteralPath $appJs.FullName -Raw
# Overlay caret + solid cursorBlink:false. Do not accept a build that still
# only styles xterm's own .xterm-cursor cell.
if ($appText -notmatch "cursorBlink") { throw "dist frontend missing cursorBlink option ($($appJs.Name))" }
if ($appText -notmatch "xtermCaret|data-xterm-caret") { throw "dist frontend missing overlay caret ($($appJs.Name))" }
if ($appText -notmatch "dataset\.xtermRenderer|xtermRenderer|Consolas") { throw "dist frontend missing terminal font/renderer path ($($appJs.Name))" }
if ($appText -notmatch "exitMainWindow") { throw "dist frontend missing exitMainWindow ($($appJs.Name))" }
if ($appText -match "request-exit-confirm") { throw "dist frontend still contains request-exit-confirm ($($appJs.Name))" }
$cssFile = Get-ChildItem -Path (Join-Path $RepoRoot "dist\assets") -Filter "app-entry-*.css" -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $cssFile) { throw "dist/assets/app-entry-*.css missing after vite build" }
$cssText = Get-Content -LiteralPath $cssFile.FullName -Raw
if ($cssText -notmatch "xterm-caret") { throw "dist css missing overlay caret ($($cssFile.Name))" }
Write-Host ("==> Frontend gate OK: {0} / {1}" -f $appJs.Name, $cssFile.Name) -ForegroundColor DarkGray

# Tauri 2 CLI accepts msi/nsis only — expand "all" to both.
# Force array: bare switch returns unwrap a 1-element @() to string; @string then
# character-splats ("n","s","i","s") and tauri sees --bundles n.
$bundleArgs = @(switch ($Targets) {
  "nsis" { "nsis" }
  "msi"  { "msi" }
  "all"  { "nsis"; "msi" }
})

Write-Host ("==> Tauri release build (targets={0})" -f ($bundleArgs -join ",")) -ForegroundColor Cyan
# beforeBuildCommand in tauri.conf already runs npm.cmd run build; dist already exists so that is fine
# Pass as one arg list so remaining-args + splat never char-splits a bare string.
$tauriBuildArgs = @("build", "--bundles") + $bundleArgs
Invoke-Tauri @tauriBuildArgs
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