$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $root) { $root = Get-Location }
Set-Location $root
$perlDir = Join-Path $root ".tools\strawberry-perl\perl\bin"
if (Test-Path (Join-Path $perlDir "perl.exe")) {
  $env:Path = "$perlDir;" + $env:Path
}
Write-Host "perl:" (Get-Command perl -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source)
& "$root\scripts\package.ps1" -SkipNpmInstall
exit $LASTEXITCODE
