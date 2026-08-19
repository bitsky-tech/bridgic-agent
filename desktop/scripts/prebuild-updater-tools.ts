/**
 * Copy the two binaries the macOS updater needs at RUNTIME into
 * apps/electron/resources/updater_tools/ so electron-builder's `extraResources`
 * ships them next to the app.
 *
 * Why the app needs build tooling at runtime
 * ------------------------------------------
 * electron-updater downloads a new release differentially — it only fetches the
 * blocks that changed — but only when it can find the PREVIOUS release's
 * artifact on disk to copy the unchanged blocks from
 * (`MacUpdater.js`: `<cacheDir>/update.zip`).
 *
 * That file is written by the updater itself, after a successful download. It is
 * therefore absent on a machine that installed from the .pkg and has never
 * updated — so the FIRST update after a fresh install falls back to a full
 * download. Measured on 0.1.2/arm64: 222.5 MB instead of 24.1 MB.
 *
 * These two binaries let the app manufacture that missing file locally:
 *   - 7za         re-packs the installed .app into a byte-compatible zip
 *   - app-builder generates the blockmap describing that zip
 *
 * Both are required; neither is optional:
 *   - The zip alone is useless. `AppUpdater.js` reads `<cacheDir>/current.blockmap`
 *     and only falls back to downloading the previous release's blockmap, which
 *     describes the RELEASE bytes — not ours. A mismatched blockmap makes the
 *     copy step read from wrong offsets.
 *   - The blockmap cannot be computed in JS. Its per-block checksums come from
 *     app-builder's Rabin-fingerprint chunker; 52 hash algorithms were tried
 *     against a real blockmap and none reproduced them. Both blockmaps in a diff
 *     must come from the same generator or no checksum ever matches.
 *
 * The rebuilt zip does NOT need to be byte-identical to the published one, and
 * is not: matching is content-addressed, so a locally built zip yields the same
 * differential payload as the real artifact (verified end-to-end: 197 range
 * requests, 24.1 MB, output sha512 equal to the published release).
 *
 * macOS only. Windows needs none of this: its NSIS installer copies itself to
 * `%LOCALAPPDATA%\amphi-updater\installer.exe` at install time
 * (app-builder-lib templates/nsis/include/installer.nsh), so the very first
 * update already runs differentially — confirmed on a real machine, where
 * 0.1.0→0.1.1 pulled 5,616 KB (3%) and 0.1.1→0.1.2 pulled 8,120 KB (4%).
 *
 * Runs from the `dist:mac*` scripts BEFORE electron-builder. Failure is fatal:
 * without these the app still updates, just always at full size.
 */

import { createRequire } from 'node:module'
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

const HERE = path.resolve(import.meta.dir ?? __dirname)
const REPO_ROOT = path.resolve(HERE, '..')
const TARGET_DIR = path.join(
  REPO_ROOT,
  'apps',
  'electron',
  'resources',
  'updater_tools',
)

/**
 * Locate an installed package's root via its package.json, so hoisting can move.
 *
 * Both packages are pinned to EXACT versions in package.json rather than left
 * to arrive as electron-builder's transitive dependencies. Two reasons, and the
 * second is the one that bites silently:
 *
 *   - resolving them at all only works while the package manager hoists them to
 *     a place this script can see;
 *   - app-builder owns the Rabin chunker that produces blockmaps. If a version
 *     bump changed its chunking, blockmaps generated on already-installed
 *     clients would stop matching the ones a new release ships, and every
 *     differential download would quietly fall back to a full one — no error,
 *     anywhere. Pinning turns that into a visible lockfile change.
 */
function packageRoot(name: string): string {
  return path.dirname(require.resolve(`${name}/package.json`))
}

/**
 * Source path of each binary for a macOS target arch.
 *
 * The two vendors disagree on how they spell x64 — 7zip-bin uses Node's `arch`
 * verbatim, app-builder-bin renames it to Go's `amd64` — so this cannot be a
 * single template. Deriving from the target arch rather than reusing the
 * packages' own `path7za` / `appBuilderPath` exports matters because those
 * resolve against the BUILD HOST (`process.arch`), which silently ships an
 * arm64 binary inside an x64 package when releasing both from one machine.
 */
function sources(arch: string): { sevenZip: string; appBuilder: string } {
  return {
    sevenZip: path.join(packageRoot('7zip-bin'), 'mac', arch, '7za'),
    appBuilder: path.join(
      packageRoot('app-builder-bin'),
      'mac',
      `app-builder_${arch === 'x64' ? 'amd64' : arch}`,
    ),
  }
}

function main(): void {
  try {
    if (os.platform() !== 'darwin') {
      throw new Error(
        `updater tools are macOS-only, refusing to run on ${os.platform()}`,
      )
    }

    const arch = process.argv[2] ?? os.arch()
    if (arch !== 'arm64' && arch !== 'x64') {
      throw new Error(`unsupported macOS arch: ${arch}`)
    }

    const { sevenZip, appBuilder } = sources(arch)
    for (const src of [sevenZip, appBuilder]) {
      if (!existsSync(src)) {
        throw new Error(`missing vendored binary: ${src}`)
      }
    }

    rmSync(TARGET_DIR, { recursive: true, force: true })
    mkdirSync(TARGET_DIR, { recursive: true })

    // chmod explicitly: cpSync's `mode` is a set of COPYFILE_* modifiers, NOT a
    // permission bitmask, so it preserves the source mode. The vendored 7za
    // ships as 0666 — copying it and running it yields EACCES.
    for (const [src, name] of [
      [sevenZip, '7za'],
      [appBuilder, 'app-builder'],
    ] as const) {
      const dest = path.join(TARGET_DIR, name)
      cpSync(src, dest)
      chmodSync(dest, 0o755)
    }

    console.log(`[prebuild-updater-tools] bundled 7za + app-builder (${arch}) -> ${TARGET_DIR}`)
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[prebuild-updater-tools] failed: ${message}`)
    process.exitCode = 1
  }
}

main()
