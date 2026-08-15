#!/usr/bin/env bash
# Package a Linux DEB via electron-builder.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ELECTRON_DIR="$(dirname "$SCRIPT_DIR")"
ROOT_DIR="$(dirname "$(dirname "$ELECTRON_DIR")")"

if [ -f "$ROOT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.env"
  set +a
fi

echo "=== Building DEB (x64) ==="

cd "$ROOT_DIR"
bun install
bun run build

cd "$ELECTRON_DIR"
rm -rf release
bunx electron-builder --config electron-builder.yml --linux

echo ""
echo "=== Done ==="
ls -lh release/*.deb
