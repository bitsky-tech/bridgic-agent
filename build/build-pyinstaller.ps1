# Build the `amphi.exe` onedir bundle via PyInstaller (Windows).
#
# PowerShell counterpart of build-pyinstaller.sh. It exists as a separate file
# rather than as cross-platform logic inside the .sh because PyInstaller cannot
# cross-compile — a Windows binary must be produced on Windows — and the .sh is
# the macOS/Linux release path we don't want to destabilize.
#
# Keep the two in step: same clean-venv strategy, same uv sync flags, same spec.
#
# Output: $RootDir\dist\amphi\amphi.exe
#         $RootDir\dist\amphi\amphi-autostart.exe
#         $RootDir\dist\amphi\_internal\
#         See build/amphi.spec for why this is onedir and not onefile — on this
#         platform specifically, onefile cost 22.6 s per invocation.
#
# Prerequisites:
#   - uv is available on PATH.
#   - pyinstaller is declared under [dependency-groups].dev in pyproject.toml.
#
# Consumed by amphi-desktop's pre-build script
# (apps/electron/scripts/prebuild-fetch-amphi.ts).

$ErrorActionPreference = "Stop"

$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $Here
Set-Location $RootDir

Write-Host "[build-pyinstaller] building from $RootDir"

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
  Write-Error "[build-pyinstaller] uv not found on PATH."
  exit 1
}

$BuildVenv = Join-Path $RootDir "build\pyinstaller-venv"

# Windows venvs put the interpreter in Scripts\, not bin\ — the single most
# common reason a POSIX build script fails when ported verbatim.
$RepoVenvPython = Join-Path $RootDir ".venv\Scripts\python.exe"
if (Test-Path $RepoVenvPython) {
  $BuildPython = $RepoVenvPython
} else {
  $BuildPython = (uv python find).Trim()
}

# Clean previous builds so PyInstaller doesn't reuse a stale Analysis cache
# (a frequent source of mysterious "ModuleNotFoundError in packaged binary").
foreach ($stale in @("build\amphi", "build\amphi.dist-info", "dist\amphi", "dist\amphi.exe")) {
  $path = Join-Path $RootDir $stale
  if (Test-Path $path) { Remove-Item -Recurse -Force $path }
}

Write-Host "[build-pyinstaller] preparing clean packaging venv at $BuildVenv"
uv venv $BuildVenv --python $BuildPython --clear
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "[build-pyinstaller] syncing pyproject dependencies (non-editable)"
# `uv sync --active` targets whatever VIRTUAL_ENV points at; scoping the env var
# to this process keeps the caller's shell untouched.
$env:VIRTUAL_ENV = $BuildVenv
uv sync --active --frozen --no-editable --all-groups --compile-bytecode
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

$PyInstallerPython = Join-Path $BuildVenv "Scripts\python.exe"
& $PyInstallerPython -c "import PyInstaller" 2>$null
if ($LASTEXITCODE -ne 0) {
  Write-Error "[build-pyinstaller] PyInstaller not found in packaging venv. Ensure pyinstaller is declared in pyproject.toml dev dependencies."
  exit 1
}

Write-Host "[build-pyinstaller] generating packaged model catalog"
$GeneratedCatalog = Join-Path $RootDir "build\generated\_models_dev_catalog.json"
& $PyInstallerPython build\generate-providers-catalog.py --output $GeneratedCatalog
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

& $PyInstallerPython -m PyInstaller build\amphi.spec --clean --noconfirm
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

# Assert the onedir layout. Without this a COLLECT misconfiguration ships a
# bundle whose launcher isn't where prebuild-fetch-amphi.ts expects it.
$Artifact = Join-Path $RootDir "dist\amphi\amphi.exe"
if (-not (Test-Path $Artifact)) {
  Write-Error "[build-pyinstaller] expected artifact missing: $Artifact"
  exit 1
}
$AutostartArtifact = Join-Path $RootDir "dist\amphi\amphi-autostart.exe"
if (-not (Test-Path $AutostartArtifact)) {
  Write-Error "[build-pyinstaller] expected windowless launcher missing: $AutostartArtifact"
  exit 1
}
$InternalDir = Join-Path $RootDir "dist\amphi\_internal"
if (-not (Test-Path $InternalDir -PathType Container)) {
  Write-Error "[build-pyinstaller] expected payload directory missing: $InternalDir"
  exit 1
}

function Get-PeSubsystem([string]$Path) {
  $bytes = [System.IO.File]::ReadAllBytes($Path)
  if ($bytes.Length -lt 256 -or $bytes[0] -ne 0x4D -or $bytes[1] -ne 0x5A) {
    throw "[build-pyinstaller] invalid PE executable: $Path"
  }
  $peOffset = [BitConverter]::ToInt32($bytes, 0x3C)
  $subsystemOffset = $peOffset + 24 + 68
  if ($peOffset -lt 0 -or $subsystemOffset + 2 -gt $bytes.Length) {
    throw "[build-pyinstaller] invalid PE header: $Path"
  }
  if (
    $bytes[$peOffset] -ne 0x50 -or
    $bytes[$peOffset + 1] -ne 0x45 -or
    $bytes[$peOffset + 2] -ne 0x00 -or
    $bytes[$peOffset + 3] -ne 0x00
  ) {
    throw "[build-pyinstaller] missing PE signature: $Path"
  }
  $optionalHeaderMagic = [BitConverter]::ToUInt16($bytes, $peOffset + 24)
  if (@(0x10B, 0x20B) -notcontains $optionalHeaderMagic) {
    throw "[build-pyinstaller] unsupported PE optional header: $Path"
  }
  return [BitConverter]::ToUInt16($bytes, $subsystemOffset)
}

# IMAGE_SUBSYSTEM_WINDOWS_CUI = 3 keeps normal CLI output. The Run-key shim
# must be IMAGE_SUBSYSTEM_WINDOWS_GUI = 2 so Windows never allocates a console.
if ((Get-PeSubsystem $Artifact) -ne 3) {
  Write-Error "[build-pyinstaller] amphi.exe is not a console-subsystem executable"
  exit 1
}
if ((Get-PeSubsystem $AutostartArtifact) -ne 2) {
  Write-Error "[build-pyinstaller] amphi-autostart.exe is not a GUI-subsystem executable"
  exit 1
}

Write-Host "[build-pyinstaller] done — artifacts at $Artifact and $AutostartArtifact"
