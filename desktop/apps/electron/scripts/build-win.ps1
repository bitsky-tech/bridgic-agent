# Package a Windows NSIS installer via electron-builder.
$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ElectronDir = Split-Path -Parent $ScriptDir
$RootDir = Split-Path -Parent (Split-Path -Parent $ElectronDir)

Write-Host "=== Building Windows installer (x64) ==="

Push-Location $RootDir
bun install
bun run build
Pop-Location

Push-Location $ElectronDir
if (Test-Path release) { Remove-Item -Recurse -Force release }
bunx electron-builder --config electron-builder.yml --win
Pop-Location

Write-Host ""
Write-Host "=== Done ==="
Get-ChildItem (Join-Path $ElectronDir "release\*.exe") -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_.Name $_.Length }
