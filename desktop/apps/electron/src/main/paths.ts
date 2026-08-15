/**
 * Filesystem layout for everything the desktop app owns on the user's disk.
 *
 * One single base directory — `~/.bridgic/amphi/` by default —
 * under which all our config / logs / caches live, next to the daemon's
 * `~/.bridgic/AmphiAgent/` so users only need to know about one
 * `~/.bridgic/` family dir. Path is centralized so a future move is a
 * one-line edit (`app-meta.ts :: AMPHI_USER_DIR_BASENAME`).
 *
 * Override the base via the `AMPHI_USER_DIR` environment variable.
 * Useful for:
 *   - tests / CI runs that want an isolated sandbox
 *   - dev workflows that point at `./tmp/amphi-user-dir/` to inspect
 *     files without rooting around in `$HOME`
 *
 * Notes on choice of a `$HOME` dotfile dir vs `app.getPath('userData')`:
 *   - userData is per-Electron-app-name; ours stutters when sibling
 *     Electron projects (electron-bun-template fork) share the same
 *     internal product name.
 *   - A predictable hidden dotfile dir under `$HOME` is also the
 *     pattern AmphiAgent uses (`~/.bridgic/AmphiAgent/`).
 */

import { existsSync, mkdirSync, renameSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  AMPHI_USER_DIR_BASENAME,
  AMPHI_USER_DIR_LEGACY_BASENAME,
  BACKEND_RUNTIME_DIR_REL,
  BRIDGIC_DIR_BASENAME,
} from '../shared/app-meta'

let migrationChecked = false

/**
 * One-time move of the legacy `~/.amphi-desktop/` dir to the new root.
 *
 * Only this one generation is handled. The 2026-07 `amphi-desktop` → `amphi`
 * rename is deliberately **not** part of the migration — the product had not
 * shipped, so there is no install to move; if a dev machine still has the old
 * directory, just `mv` it.
 *
 * LAZY (first path resolution) rather than an explicit startup call:
 * logger.ts evaluates very early and would otherwise create the new dir
 * before any migration ran, making the whole-dir `renameSync` fail.
 * Running on first access guarantees nothing exists at the target yet.
 *
 * Best-effort: on failure we fall through to a fresh dir (defaults) —
 * a broken migration must never prevent the GUI from booting.
 */
function migrateLegacyUserDirOnce(target: string): void {
  if (migrationChecked) return
  migrationChecked = true
  const legacy = path.join(os.homedir(), AMPHI_USER_DIR_LEGACY_BASENAME)
  try {
    if (existsSync(legacy) && !existsSync(target)) {
      mkdirSync(path.dirname(target), { recursive: true })
      renameSync(legacy, target)
    }
  } catch (err) {
    // console (not mainLog — logger.ts imports this module, would cycle):
    // visible in the dev terminal at least.
    console.error('[paths] legacy user-dir migration failed', err)
  }
}

/**
 * Absolute path to the shared `~/.bridgic` family root (parent of both the
 * desktop dir and the daemon's `AmphiAgent/`). NOT subject to the
 * `AMPHI_USER_DIR` override — that only relocates the desktop's own dir, while
 * this root is where the daemon's session files genuinely live (used by the
 * `fs:writeFile` path guard to confine writes to `~/.bridgic/**`).
 */
export function bridgicHomeDir(): string {
  return path.join(os.homedir(), BRIDGIC_DIR_BASENAME)
}

/** Absolute path to the App-wide Bridgic Agent data root. */
export function amphiAgentDataDir(): string {
  return path.join(os.homedir(), BACKEND_RUNTIME_DIR_REL)
}

/** Absolute path to the shared path-backed Electron browser profile. */
export function embeddedBrowserProfileDir(): string {
  return path.join(amphiAgentDataDir(), 'browser', 'base')
}

/** Absolute path to the desktop app's user dir (no trailing slash). */
export function amphiUserDir(): string {
  const override = process.env.AMPHI_USER_DIR
  if (override) return override
  const dir = path.join(os.homedir(), AMPHI_USER_DIR_BASENAME)
  migrateLegacyUserDirOnce(dir)
  return dir
}

/**
 * Build an absolute path under the amphi user dir and ensure all
 * intermediate directories exist. Pass one or more path segments —
 * they're joined just like `path.join`.
 *
 *   amphiUserFile('gui-settings.json')
 *     → "/Users/…/.bridgic/amphi/gui-settings.json"
 *
 *   amphiUserFile('cache', 'avatars', '12.png')
 *     → "/Users/…/.bridgic/amphi/cache/avatars/12.png"
 *     (plus mkdir -p of the parent)
 *
 * The parent directory is created on every call; this is cheap (one
 * `mkdir -p`-equivalent syscall) and saves callers from having to
 * remember to call it before writing.
 */
export function amphiUserFile(...parts: string[]): string {
  const target = path.join(amphiUserDir(), ...parts)
  const parent = path.dirname(target)
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true })
  }
  return target
}
