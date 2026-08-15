#!/usr/bin/env bash
# One-shot macOS build: Python backend (PyInstaller) → Electron app → .pkg/.zip.
#
# Usage:
#   bash build/build-desktop-mac.sh              # native arch (arm64 on Apple silicon)
#   bash build/build-desktop-mac.sh x64          # Intel / Rosetta target
#   SKIP_BACKEND=1 bash build/build-desktop-mac.sh   # reuse existing dist/amphi
#
# Why this script exists rather than just `bun run dist:mac`:
#   `dist:mac` does NOT build the backend. Its first step
#   (prebuild-fetch-amphi.ts) only COPIES an already-built PyInstaller bundle
#   out of `dist/amphi/`. If that bundle is stale — or from another branch —
#   the copy succeeds silently and you ship a new frontend glued to an old
#   backend. This script always rebuilds the backend first (override with
#   SKIP_BACKEND=1 when you know it is current).
#
# NO APPLE CERTIFICATE REQUIRED to run this script. Signing and notarization are
# optional and driven purely by env vars that `apps/electron/scripts/build-dmg.sh`
# sources from `desktop/.env` (a gitignored file you will not have after a fresh
# clone, so the default path is simply "unsigned"):
#   APPLE_SIGNING_IDENTITY  → sign the app and the embedded binaries
#   APPLE_ID + APPLE_TEAM_ID + APPLE_APP_SPECIFIC_PASSWORD → notarization
#
# Every layer degrades instead of failing: build-dmg.sh skips the .env source,
# after-pack.cjs falls back to ad-hoc signing, and electron-builder only logs
# "skipped macOS application code signing" (it throws only for MAS builds or
# with forceCodeSigning, neither of which this config uses).
#
# What differs WITHOUT a certificate — know which one you need:
#   * The build succeeds and produces the same .pkg / .zip.
#   * The app is unsigned and un-notarized, so Gatekeeper blocks a double-click
#     install. Install from the command line instead (printed at the end):
#     `sudo installer -pkg <pkg> -target /` runs as root and bypasses that check.
#     For the .app directly: `xattr -dr com.apple.quarantine <app>`.
#   * The result is fine for LOCAL TESTING but must NOT be handed to anyone
#     else — on their machine it is an unsigned binary from an unknown source.
#   * It is also much faster (~8min vs ~30min): notarization dominates a signed
#     build's wall time, and how long it takes depends mostly on your upload
#     bandwidth to Apple (two ~220MB submissions). Datacenter links finish in
#     ~5min; a slow or throttled home link can take 20min+.
#
# To produce a DISTRIBUTABLE signed + notarized build, do NOT copy certificates
# around — run the CI workflow instead, which already holds them as secrets:
#   gh workflow run package.yml --ref <branch>
#
# Prerequisites: bun, uv, and Xcode Command Line Tools (`xcode-select -p`).

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$HERE/.." && pwd)"
DESKTOP="$ROOT/desktop"

ARCH="${1:-$(uname -m)}"
case "$ARCH" in
  arm64 | aarch64) ARCH=arm64; DIST_SCRIPT="dist:mac" ;;
  x64 | x86_64)    ARCH=x64;   DIST_SCRIPT="dist:mac:x64" ;;
  *) echo "unsupported arch: $ARCH (want arm64 or x64)" >&2; exit 1 ;;
esac

started_at=$(date +%s)
step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
elapsed() { printf '%dm%02ds' $(( ($1) / 60 )) $(( ($1) % 60 )); }

step "Checking prerequisites"
missing=0
for tool in bun uv; do
  if command -v "$tool" >/dev/null 2>&1; then
    echo "  ok    $tool  ($("$tool" --version 2>&1 | head -1))"
  else
    echo "  MISSING $tool" >&2
    missing=1
  fi
done
if xcode-select -p >/dev/null 2>&1; then
  echo "  ok    Xcode CLI tools  ($(xcode-select -p))"
else
  echo "  MISSING Xcode Command Line Tools — run: xcode-select --install" >&2
  missing=1
fi
[ "$missing" -eq 0 ] || { echo "install the missing tools first" >&2; exit 1; }

# Report the signing posture up front. Two first-timer surprises this prevents:
# the 30-vs-8 minute gap, and assuming an unsigned local build is shippable.
SIGNED_BUILD=0
if [ -f "$DESKTOP/.env" ] && grep -qE '^APPLE_ID=.' "$DESKTOP/.env" \
  && grep -qE '^APPLE_TEAM_ID=.' "$DESKTOP/.env" \
  && grep -qE '^APPLE_APP_SPECIFIC_PASSWORD=.' "$DESKTOP/.env"; then
  SIGNED_BUILD=1
  echo "  note  Apple credentials found in desktop/.env → signed + notarized"
  echo "        expect ~30min; notarization uploads two ~220MB submissions to"
  echo "        Apple, so your upload bandwidth sets the pace, not this machine"
else
  echo "  note  no Apple credentials → UNSIGNED build (this is fine), ~8min"
  echo "        usable for local testing only — do not hand the artifact to"
  echo "        others; for a distributable build run the CI workflow instead:"
  echo "        gh workflow run package.yml --ref <branch>"
fi

if [ "${SKIP_BACKEND:-}" = "1" ]; then
  step "Skipping backend rebuild (SKIP_BACKEND=1)"
  [ -x "$ROOT/dist/amphi/amphi" ] || {
    echo "dist/amphi/amphi not found — cannot skip the backend build" >&2
    exit 1
  }
  echo "  reusing $(ls -l "$ROOT/dist/amphi/amphi" | awk '{print $6, $7, $8}')"
else
  step "Building backend bundle (PyInstaller)"
  backend_start=$(date +%s)
  bash "$ROOT/build/build-pyinstaller.sh"
  echo "  took $(elapsed $(( $(date +%s) - backend_start )))"
fi

step "Building desktop app ($ARCH) — fetch runtimes, bundle, sign, notarize"
app_start=$(date +%s)
cd "$DESKTOP"
bun run "$DIST_SCRIPT"
echo "  took $(elapsed $(( $(date +%s) - app_start )))"

step "Verifying artifacts"
RELEASE="$DESKTOP/apps/electron/release"
ls -lh "$RELEASE"/*.pkg "$RELEASE"/*.zip
if [ -d "$RELEASE/mac-$ARCH/Amphi.app" ]; then
  echo
  echo "  bundled backend: $(ls -l "$RELEASE/mac-$ARCH/Amphi.app/Contents/Resources/bin/amphi" | awk '{print $6, $7, $8}')"
  echo -n "  gatekeeper: "
  spctl -a -vv "$RELEASE/mac-$ARCH/Amphi.app" 2>&1 | tail -2 | tr '\n' ' ' || true
  echo
fi

printf '\n\033[1m==> Done in %s\033[0m\n' "$(elapsed $(( $(date +%s) - started_at )))"
echo "Install: sudo installer -pkg $RELEASE/Amphi-$ARCH.pkg -target /"
if [ "$SIGNED_BUILD" -eq 0 ]; then
  # Unsigned pkg: the command above still works (root bypasses Gatekeeper), but
  # double-clicking does not — say so rather than letting them hit the dialog.
  echo "         (unsigned build — double-clicking the .pkg will be blocked by"
  echo "          Gatekeeper; use the command above. Local testing only.)"
fi
