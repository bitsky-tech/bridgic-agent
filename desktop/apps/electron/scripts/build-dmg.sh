#!/usr/bin/env bash
# Package macOS PKG and ZIP artifacts via electron-builder.
#
# Usage:
#   bash build-dmg.sh [arm64|x64]
#
# Honors APPLE_SIGNING_IDENTITY / APPLE_ID / APPLE_TEAM_ID /
# APPLE_APP_SPECIFIC_PASSWORD env vars (set in .env) to enable signing
# and notarization. Unset → unsigned local build (fine for testing).

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"
ARCH="${1:-arm64}"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

echo "=== Building macOS PKG + ZIP (${ARCH}) ==="

cd "$ROOT_DIR"
bun install
bun run build

cd "$ELECTRON_DIR"
rm -rf release

if [ -n "$APPLE_SIGNING_IDENTITY" ]; then
  echo "→ Signing identity: $APPLE_SIGNING_IDENTITY"
  export CSC_NAME="${APPLE_SIGNING_IDENTITY#Developer ID Application: }"
fi

if [ -n "$APPLE_ID" ] && [ -n "$APPLE_TEAM_ID" ] && [ -n "$APPLE_APP_SPECIFIC_PASSWORD" ]; then
  echo "→ Notarization credentials present"
  export NOTARIZE=true
fi

bunx electron-builder --config electron-builder.yml --mac --"$ARCH"

echo ""
echo "=== Done ==="
ls -lh release/*.pkg release/*.zip
