#!/usr/bin/env bash
# Build the `amphi` onedir bundle via PyInstaller.
#
# Run from anywhere; the script resolves the Bridgic Agent repo root via its
# own location and then `cd`s there before invoking PyInstaller.
#
# Output: $REPO_ROOT/dist/amphi/amphi plus the sibling _internal/ payload.
# Native Windows builds additionally contain the windowless
# amphi-autostart.exe login shim.
#
# Windows builds must run natively via build-pyinstaller.ps1; PyInstaller
# cannot cross-compile an amphi.exe from macOS/Linux or WSL.
# See build/amphi.spec for why this is onedir and not onefile.
#
# Prerequisites:
#   - uv is available on PATH.
#   - pyinstaller is declared under [dependency-groups].dev in pyproject.toml.
#
# Consumed by amphi-desktop's pre-build script
# (apps/electron/scripts/prebuild-fetch-amphi.ts).

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/.." && pwd)"
cd "$ROOT"

echo "[build-pyinstaller] building from $ROOT"

if ! command -v uv >/dev/null 2>&1; then
  echo "[build-pyinstaller] uv not found on PATH." >&2
  exit 1
fi

BUILD_VENV="$ROOT/build/pyinstaller-venv"
if [[ -x "$ROOT/.venv/bin/python" ]]; then
  BUILD_PYTHON="$ROOT/.venv/bin/python"
else
  BUILD_PYTHON="$(uv python find)"
fi

# Clean previous builds so PyInstaller doesn't reuse stale Analysis cache
# (a frequent source of mysterious "ModuleNotFoundError in packaged binary"
# headaches). `dist/amphi.exe` is the pre-onedir artifact shape — still removed
# so a stale onefile binary can't be picked up by prebuild-fetch-amphi.
rm -rf build/amphi build/amphi.dist-info dist/amphi dist/amphi.exe || true

echo "[build-pyinstaller] preparing clean packaging venv at $BUILD_VENV"
uv venv "$BUILD_VENV" --python "$BUILD_PYTHON" --clear

echo "[build-pyinstaller] syncing pyproject dependencies (non-editable)"
VIRTUAL_ENV="$BUILD_VENV" uv sync \
  --active \
  --frozen \
  --no-editable \
  --all-groups \
  --compile-bytecode

PYINSTALLER_PYTHON="$BUILD_VENV/bin/python"
if ! "$PYINSTALLER_PYTHON" -c 'import PyInstaller' 2>/dev/null; then
  echo "[build-pyinstaller] PyInstaller not found in packaging venv." >&2
  echo "[build-pyinstaller] Ensure pyinstaller is declared in pyproject.toml dev dependencies." >&2
  exit 1
fi

"$PYINSTALLER_PYTHON" -m PyInstaller build/amphi.spec --clean --noconfirm

# Assert the onedir layout, mirroring the same check in build-pyinstaller.ps1.
# Without it a COLLECT misconfiguration ships a bundle whose launcher isn't
# where prebuild-fetch-amphi.ts (and thus resources/bin/) expects it.
ARTIFACT="$ROOT/dist/amphi/amphi"
if [[ ! -x "$ARTIFACT" ]]; then
  echo "[build-pyinstaller] expected artifact missing: $ARTIFACT" >&2
  exit 1
fi
INTERNAL_DIR="$ROOT/dist/amphi/_internal"
if [[ ! -d "$INTERNAL_DIR" ]]; then
  echo "[build-pyinstaller] expected payload directory missing: $INTERNAL_DIR" >&2
  exit 1
fi

# Stamp the backend version this bundle was built from.
#
# The launcher has no `--version`, and nothing else inside the bundle exposes
# one, so without this stamp there is no way to tell a fresh artifact from a
# stale one. That gap shipped a package whose release manifest promised backend
# 0.1.2 while the bundled binary was still 0.1.0 — every build gate passed, and
# the install wedged on the version-compatibility screen with no way forward.
# `prebuild-fetch-amphi.ts` refuses to copy a bundle whose stamp disagrees with
# src/__init__.py.
BACKEND_VERSION="$(sed -n 's/^__version__ = "\(.*\)"$/\1/p' "$ROOT/src/__init__.py")"
if [[ -z "$BACKEND_VERSION" ]]; then
  echo "[build-pyinstaller] could not read __version__ from src/__init__.py" >&2
  exit 1
fi
printf '%s\n' "$BACKEND_VERSION" > "$ROOT/dist/amphi/.backend-version"

echo "[build-pyinstaller] done — artifact at $ARTIFACT (backend $BACKEND_VERSION)"
