/**
 * Generate the release compatibility manifest that ships inside the packaged app.
 *
 *   bun run scripts/release-manifest.ts
 *
 * The manifest answers exactly one question at runtime: *which backend version
 * was this GUI released against?* `main/release-manifest.ts` reads it,
 * `main/python-client/compatibility.ts` compares it with the version reported by
 * whichever daemon the app adopts, and a mismatch blocks the UI instead of
 * letting a new GUI drive an old daemon over a changed contract.
 *
 * Why the backend version is read from `src/__init__.py` and NOT `pyproject.toml`
 * ------------------------------------------------------------------------------
 * `src/__init__.py::__version__` is the value the daemon actually reports over
 * `GET /api/gateway/health` (see `src/amphi_service/_app.py`, which imports it and
 * passes it to the FastAPI app). `pyproject.toml` used to carry a second, static
 * copy; if the two drifted, this manifest would claim version A while every
 * daemon reported version B — and *every* user would be blocked at the startup
 * gate while CI stayed green, because no unit test packages the app or boots a
 * daemon. pyproject now derives its version from the same file
 * (`[tool.hatch.version]`), and `tests/test_release_version_contract.py` keeps
 * all four copies (backend, two package.json files, app-meta.ts) pinned together.
 *
 * `APP_VERSION` in `shared/app-meta.ts` is deliberately NOT consulted here — it
 * is a fourth copy maintained for the User-Agent string, and reading it would
 * turn a drift into two different failure modes depending on which file was
 * stale. The contract test is what keeps it honest.
 */

import { readFileSync, renameSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const DESKTOP_DIR = join(import.meta.dir, '..')
const REPO_ROOT = join(DESKTOP_DIR, '..')
const OUTPUT_PATH = join(DESKTOP_DIR, 'apps/electron/resources/release-manifest.json')

/** Bumped only when the shape below changes in a way old readers cannot parse. */
export const RELEASE_MANIFEST_SCHEMA = 1 as const

export interface ReleaseManifest {
  schema: typeof RELEASE_MANIFEST_SCHEMA
  desktopVersion: string
  requiredBackendVersion: string
}

/** `x.y.z` only. Pre-release / build-metadata suffixes are rejected on purpose:
 *  P0 compatibility is exact string equality, and `1.0.0` vs `1.0.0+build2`
 *  would compare unequal while meaning the same release. */
const DOTTED_NUMERIC = /^\d+\.\d+\.\d+$/

function assertVersion(label: string, value: string): void {
  if (!DOTTED_NUMERIC.test(value)) {
    throw new Error(`${label} version must be dotted numeric (x.y.z), got ${JSON.stringify(value)}`)
  }
}

/**
 * Pure builder — the whole policy lives here so it can be unit tested without
 * touching the filesystem.
 */
export function buildReleaseManifest(input: {
  desktopVersion: string
  backendVersion: string
}): ReleaseManifest {
  assertVersion('Desktop', input.desktopVersion)
  assertVersion('Backend', input.backendVersion)
  if (input.desktopVersion !== input.backendVersion) {
    throw new Error(
      'Desktop and backend release versions must match ' +
        `(desktop=${input.desktopVersion}, backend=${input.backendVersion})`,
    )
  }
  return {
    schema: RELEASE_MANIFEST_SCHEMA,
    desktopVersion: input.desktopVersion,
    requiredBackendVersion: input.backendVersion,
  }
}

/** Extract `__version__ = "x.y.z"` from the backend package root. Exported for tests. */
export function parseBackendVersion(source: string): string {
  // Anchored to line start so a commented-out or class-scoped lookalike cannot
  // shadow the real constant — and then required to be UNIQUE. A module
  // docstring containing an `__version__ = "9.9.9"` example at column 0 is
  // enough to satisfy the anchor, and taking the first match would bake that
  // number into the manifest: every daemon would then report a different version
  // and every user would be blocked at the startup gate, with CI green.
  const matches = [...source.matchAll(/^__version__[^\S\n]*(?::[^=\n]+)?=[^\S\n]*["']([^"']+)["']/gm)]
  if (matches.length === 0) {
    throw new Error('Could not find __version__ in src/__init__.py — was it renamed or removed?')
  }
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} module-level __version__ assignments in src/__init__.py; ` +
        'cannot tell which one the daemon reports',
    )
  }
  const captured = matches[0]?.[1]
  if (captured === undefined) {
    throw new Error('Could not find __version__ in src/__init__.py — was it renamed or removed?')
  }
  return captured
}

function readDesktopVersion(): string {
  const raw = readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf-8')
  const version = (JSON.parse(raw) as { version?: unknown }).version
  if (typeof version !== 'string') {
    throw new Error('desktop/package.json has no string "version" field')
  }
  return version
}

function readBackendVersion(): string {
  return parseBackendVersion(readFileSync(join(REPO_ROOT, 'src/__init__.py'), 'utf-8'))
}

/**
 * Write the manifest next to the other packaged resources.
 *
 * Written through a temp file + rename so a crashed/killed build can never leave
 * a half-written JSON behind: the main process fails CLOSED on an unparseable
 * manifest in a packaged build (a user-visible "backend unavailable" error), so
 * a truncated file would be indistinguishable from a broken install.
 */
export function writeReleaseManifest(manifest: ReleaseManifest, outputPath = OUTPUT_PATH): void {
  const dir = join(outputPath, '..')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${outputPath}.tmp`
  writeFileSync(tmp, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  renameSync(tmp, outputPath)
}

export function generateReleaseManifest(): ReleaseManifest {
  const manifest = buildReleaseManifest({
    desktopVersion: readDesktopVersion(),
    backendVersion: readBackendVersion(),
  })
  writeReleaseManifest(manifest)
  return manifest
}

if (import.meta.main) {
  try {
    const manifest = generateReleaseManifest()
    console.log(
      `✔ release manifest: desktop ${manifest.desktopVersion} ` +
        `requires backend ${manifest.requiredBackendVersion}`,
    )
  } catch (err) {
    console.error(`\n❌ release manifest: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
