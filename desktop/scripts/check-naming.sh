#!/usr/bin/env bash
# Drift check: project names must live in app-meta.ts and be imported,
# not scattered as literals across the codebase.
#
# Enforces the naming contract centralized in shared/app-meta.ts. Run as part of CI or
# as a pre-commit / pre-push hook.
#
# Tolerated string occurrences (whitelist):
#   - apps/electron/src/shared/app-meta.ts       canonical definitions
#   - apps/electron/electron-builder.yml         electron-builder needs literals
#   - apps/electron/package.json                 npm package metadata
#   - package.json                               npm workspace metadata
#   - apps/electron/build/{pkg-scripts,deb-scripts,installer.nsh,
#                          installer-languages.nsh}
#                                                installer hooks: shell/.nsh
#                                                cannot import TS, comment in
#                                                each file explains the rule
#   - apps/electron/resources/systemd/*.service  systemd unit literal name
#   - README.md                                  user-facing prose

set -e

cd "$(dirname "$0")/.."

# Fully retired names: they should no longer appear in the source at all, so any
# occurrence is a rename that slipped through (not a legitimate use) — let CI
# block it outright.
#
# The display name became `Bridgic Agent` in 2026-08, but a bare `Amphi` is
# deliberately NOT in this pattern: the rename covered user-visible text only,
# so ~119 legitimate occurrences remain as identifiers (`AmphiClient`,
# `buildAmphiClient`, `getAmphiWsConnection`, the `Amphi Daemon` Run value,
# `$LOCALAPPDATA\Amphi`). Adding it here would be all false positives.
#
# What IS pinned, by tests/test_branding_contract.py: app-meta's
# APP_PRODUCT_NAME against the backend OAuth page, against electron-builder's
# `productName`, and against the agent's own AGENT_NAME. That covers the
# constants; it does NOT cover free prose. User-facing strings that name the
# product (i18n locales, NSIS LangStrings, README) still have to be caught by
# review — prefer `{{product}}` interpolation over a literal wherever the
# framework allows it.
PATTERNS='amphi-desktop|com\.bitsky\.amphi-desktop|Amphi Desktop|AmphiLoop'

# Allow listed paths (anchored substrings). Includes __tests__ (fixtures may
# carry historical literals while asserting pass-through behaviour) and this
# script itself (its PATTERNS= line below would otherwise self-match).
#
# Note this script only scans `desktop/` (it cd's there before running git
# ls-files). The product identity mirrored on the Python side
# (`_codex_oauth.py`'s APP_PRODUCT_NAME / APP_SCHEME) is out of range; it is
# covered by the cross-language contract assertions in
# `tests/test_branding_contract.py`.
ALLOW='apps/electron/src/shared/app-meta\.ts|apps/electron/electron-builder\.yml|apps/electron/package\.json|^package\.json|apps/electron/build/(pkg-scripts|deb-scripts|installer\.nsh|installer-languages\.nsh)|apps/electron/resources/systemd/.*\.service|apps/electron/src/renderer/index\.html|README\.md|^diagrams/|\.gitignore|__tests__|scripts/check-naming\.sh'

# Search only tracked source-ish files; skip lock files and binaries.
FILES=$(git ls-files | grep -E '\.(ts|tsx|js|jsx|cjs|mjs|json|yml|yaml|sh|nsh|md|plist|service|html)$' | grep -Ev "$ALLOW")

if [ -z "$FILES" ]; then
  echo "[check-naming] no source files to scan (nothing to do)"
  exit 0
fi

# ── Check 1: retired names anywhere in source ──────────────────────────────
#
# Match literals, then drop comment lines: a project name inside a comment
# (JSDoc ` *` / `/*` / `//` / shell `#`) documents an on-disk path — it is
# not a stray code-level literal, and only the latter counts as real drift.
# shellcheck disable=SC2086
hits=$(echo "$FILES" | xargs grep -EnH "$PATTERNS" 2>/dev/null | grep -Ev ':[0-9]+:[[:space:]]*(\*|//|/\*|#)' || true)

# ── Check 2: hard-coded product name in user-facing copy ───────────────────
#
# This closes the gap the header admits to: retired names are caught above, but
# the CURRENT display name hard-coded into a locale string is invisible to that
# pattern — and it is the one that silently survives the next rename. Twelve
# keys already interpolate `{{product}}` and follow `APP_PRODUCT_NAME`
# automatically; `settings.privacy.telemetry.sectionTitle` spelled it out
# instead, so a rename would have relabelled the whole UI except that heading.
#
# The name is read out of app-meta rather than repeated here — a checker that
# hard-codes the value it guards becomes a second source of truth, i.e. the
# exact failure it exists to prevent.
# A failed extraction is a HARD error, never a silent skip. The pattern below
# is tied to one exact spelling of the constant; reformatting it (adding
# `as const`, switching quotes, wrapping the line) makes sed print nothing, and
# an earlier `if [ -n "$PRODUCT_NAME" ]` guard turned that into "check 2 didn't
# run" while the script still exited 0 — a checker that silently stops checking
# is the very failure mode this file exists to prevent.
PRODUCT_NAME=$(sed -n "s/^export const APP_PRODUCT_NAME = '\(.*\)'\$/\1/p" apps/electron/src/shared/app-meta.ts)
if [ -z "$PRODUCT_NAME" ]; then
  echo "[check-naming] FAIL — cannot read APP_PRODUCT_NAME from app-meta.ts."
  echo "                The declaration must stay on one line as:"
  echo "                  export const APP_PRODUCT_NAME = '<name>'"
  echo "                Update the sed pattern here if the file legitimately changed."
  exit 1
fi

LOCALE_FILES=$(git ls-files 'packages/shared/src/i18n/locales/*.json')
if [ -z "$LOCALE_FILES" ]; then
  echo "[check-naming] FAIL — no locale files found; the copy check cannot run."
  exit 1
fi
# shellcheck disable=SC2086
locale_hits=$(grep -EnH "$PRODUCT_NAME" $LOCALE_FILES 2>/dev/null || true)

# ── Check 3: retired product name in user-facing copy ──────────────────────
#
# `AmphiAgent` cannot go in PATTERNS above: it is still a LIVE identifier —
# the agent's Python class name, and the `~/.bridgic/AmphiAgent/` runtime
# directory — so a repo-wide ban would be all false positives. In the locale
# catalogs it is something else entirely: those two files are nothing but
# user-visible copy, so an occurrence there is a retired product name on its
# way to the screen, with no legitimate reading.
#
# Narrow by construction, and currently at zero. The 2026-08 rename left ~40
# `AmphiAgent` references behind in prose; none reached the catalogs, but the
# only thing that had stopped them was that nobody happened to type one.
# shellcheck disable=SC2086
retired_copy_hits=$(grep -EnH 'AmphiAgent' $LOCALE_FILES 2>/dev/null || true)

failed=0

if [ -n "$hits" ]; then
  failed=1
  echo "[check-naming] FAIL — these files contain project-name literals that"
  echo "                should be imported from apps/electron/src/shared/app-meta.ts:"
  echo
  echo "$hits"
  echo
  echo "Fix: replace the literal with an import from app-meta, or — if the"
  echo "literal is unavoidable (electron-builder.yml, installer scripts) —"
  echo "add its path to the ALLOW regex in scripts/check-naming.sh."
  echo
fi

if [ -n "$locale_hits" ]; then
  failed=1
  echo "[check-naming] FAIL — user-facing copy hard-codes the product name"
  echo "                \"$PRODUCT_NAME\" instead of interpolating it:"
  echo
  echo "$locale_hits"
  echo
  echo "Fix: put {{product}} in the locale string and pass"
  echo "\`{ product: APP_PRODUCT_NAME }\` at the t() call site, the way the"
  echo "other {{product}} keys already do."
  echo
fi

if [ -n "$retired_copy_hits" ]; then
  failed=1
  echo "[check-naming] FAIL — user-facing copy contains the retired product"
  echo "                name \"AmphiAgent\":"
  echo
  echo "$retired_copy_hits"
  echo
  echo "Fix: the product is \"$PRODUCT_NAME\". Write the copy with"
  echo "{{product}} and pass \`{ product: APP_PRODUCT_NAME }\` at the t() call"
  echo "site. \`AmphiAgent\` stays valid in code as an identifier (the agent"
  echo "class, the ~/.bridgic/AmphiAgent/ runtime dir) — just never in copy."
  echo
fi

if [ "$failed" -eq 0 ]; then
  echo "[check-naming] OK — no stray project-name literals"
  exit 0
fi

exit 1

