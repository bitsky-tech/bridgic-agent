/**
 * Resolve the absolute path to the `amphi` CLI binary.
 *
 * Three resolution modes, in priority order:
 *   1. `process.env.AMPHI_BIN` — explicit override, used by dev shell
 *      scripts and CI runs that don't want the auto-detect logic.
 *   2. **Production** (`app.isPackaged`): `Resources/bin/amphi` —
 *      bundled by electron-builder `extraResources` in Phase 6.
 *   3. **Development** fallback: walk up from this file to the parent
 *      Bridgic Agent repository's venv (this `desktop/` dir is nested inside it).
 *      Logged loudly when found so it's obvious which backend the GUI is
 *      talking to.
 *
 * Platform note: a Python venv's layout is NOT the same across platforms —
 * POSIX puts executables in `.venv/bin/<cli>`, Windows in
 * `.venv/Scripts/<cli>.exe`. Both the packaged and the dev branch must honor
 * that; the dev branch used to hardcode the POSIX form, so on Windows the
 * walk-up could never hit and the GUI reported BackendBinaryMissing even with
 * a perfectly good venv sitting in the repo.
 *
 * The renderer NEVER calls this — Electron `main` always invokes CLI
 * by absolute path so PATH state on the user's terminal cannot break
 * the GUI.
 *
 * Throws `BackendBinaryMissing` if no resolution succeeds, with a
 * pre-formatted human message the UI can surface verbatim.
 */
import { existsSync } from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { mainLog } from '../logger'
import { BACKEND_CLI_NAME } from '../../shared/app-meta'

const IS_WINDOWS = process.platform === 'win32'

/** CLI filename as it exists on disk — Windows carries the `.exe` suffix. */
const CLI_FILENAME = IS_WINDOWS ? `${BACKEND_CLI_NAME}.exe` : BACKEND_CLI_NAME

/** Subdir holding a venv's executables: `Scripts` on Windows, `bin` elsewhere. */
const VENV_BIN_DIRNAME = IS_WINDOWS ? 'Scripts' : 'bin'

export class BackendBinaryMissing extends Error {
  constructor(public readonly searchedPaths: string[]) {
    super(
      `Could not locate the '${BACKEND_CLI_NAME}' binary. Searched:\n` +
        searchedPaths.map((p) => `  - ${p}`).join('\n') +
        `\nSet AMPHI_BIN=/absolute/path/to/${BACKEND_CLI_NAME} to override.`,
    )
    this.name = 'BackendBinaryMissing'
  }
}

/**
 * Return absolute path to amphi CLI, or throw BackendBinaryMissing.
 *
 * Cached on first successful resolution because the path doesn't move
 * during a single Electron lifetime (Phase 6/7 installers handle upgrade
 * via a full app restart).
 */
let cached: string | null = null

export function amphiAbsolutePath(): string {
  if (cached) return cached
  const candidates: string[] = []

  const fromEnv = process.env.AMPHI_BIN
  if (fromEnv && fromEnv.length > 0) {
    candidates.push(fromEnv)
    if (existsSync(fromEnv)) {
      mainLog.info(`[python-client] amphi resolved from AMPHI_BIN: ${fromEnv}`)
      cached = fromEnv
      return fromEnv
    }
  }

  if (app.isPackaged) {
    // `bin` here is OUR extraResources layout (electron-builder), not a venv —
    // it stays `bin` on every platform. Only the filename varies.
    const bundled = path.join(process.resourcesPath, 'bin', CLI_FILENAME)
    candidates.push(bundled)
    if (existsSync(bundled)) {
      mainLog.info(`[python-client] amphi resolved (bundled): ${bundled}`)
      cached = bundled
      return bundled
    }
  } else {
    // Dev: the backend repository is now the PARENT of this
    // `desktop/` subdir (monorepo layout). We're in
    // <repo-root>/desktop/apps/electron/{dist,src}/…; the venv lives at
    // <repo-root>/.venv/<bin|Scripts>/<cli>. Walk up looking for an
    // ancestor that carries it.
    const here = __dirname
    let cursor: string | undefined = here
    for (let i = 0; i < 8 && cursor; i++) {
      const candidate = path.join(cursor, '.venv', VENV_BIN_DIRNAME, CLI_FILENAME)
      candidates.push(candidate)
      if (existsSync(candidate)) {
        const resolved = path.resolve(candidate)
        mainLog.info(`[python-client] amphi resolved (dev, parent repo): ${resolved}`)
        cached = resolved
        return resolved
      }
      const next = path.dirname(cursor)
      if (next === cursor) break
      cursor = next
    }
  }

  throw new BackendBinaryMissing(candidates)
}

/** Test-only reset; production code never calls this. */
export function _resetForTests(): void {
  cached = null
}
