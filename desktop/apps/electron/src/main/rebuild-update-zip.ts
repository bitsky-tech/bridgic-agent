/**
 * Manufacture the differential source that a .pkg install never leaves behind.
 *
 * electron-updater downloads a release differentially — fetching only changed
 * blocks — but only when it can copy the unchanged ones out of the previous
 * artifact at `<cacheDir>/update.zip`. That file is written by the updater
 * itself after a successful download (`MacUpdater.js`), so a machine that
 * installed from the .pkg and never updated does not have it, and its FIRST
 * update falls back to a full download: 222.5 MB instead of 24.1 MB, measured
 * on 0.1.2/arm64.
 *
 * Re-packing the installed bundle closes that gap. It runs once per machine —
 * afterwards the updater keeps `update.zip` current on every download — and it
 * is cheap next to what it saves: ~44 s of CPU against ~198 MB of transfer.
 *
 * Why the rebuilt zip does not need to equal the published one
 * -----------------------------------------------------------
 * It cannot: three attempts (7za extract, unzip extract, ditto copy) all
 * produced a byte-different archive, and Python writes `__pycache__` into the
 * installed bundle after first run, so the file set drifts too. It does not
 * matter. Block matching is content-addressed (`downloadPlanBuilder.js` maps
 * checksum -> offset), so a locally built zip yields the same differential
 * payload as the real artifact — verified end to end: 197 range requests,
 * 24.1 MB transferred, output sha512 equal to the published release.
 *
 * What DOES matter is that `current.blockmap` describes THIS zip. `AppUpdater.js`
 * reads it first and only falls back to downloading the previous release's
 * blockmap, which describes the published bytes — pairing that with a locally
 * built zip makes the copy step read from wrong offsets. Hence both files are
 * always written together, and the blockmap is generated locally rather than
 * fetched (its per-block checksums come from app-builder's Rabin-fingerprint
 * chunker; 52 hash algorithms were tried against a real blockmap and none
 * reproduced them, so both sides of a diff must come from the same generator).
 *
 * Every failure path degrades to today's behaviour — a full download — because
 * a mismatched pair still ends at electron-updater's whole-file sha512 check,
 * which rejects it and refetches (`MacUpdater.js`). Nothing gets installed
 * wrong; at worst one download is wasted.
 *
 * macOS only. Windows needs no equivalent: its NSIS installer copies itself to
 * `%LOCALAPPDATA%\amphi-updater\installer.exe` at install time, so even the
 * first update runs differentially — confirmed on a real machine, where
 * 0.1.0→0.1.1 pulled 5,616 KB (3%) and 0.1.1→0.1.2 pulled 8,120 KB (4%).
 */

import { execFile } from 'node:child_process'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface RebuildUpdateZipDeps {
  /** Absolute path of the installed `.app` bundle. */
  appBundle: string
  /** electron-updater's cache directory, i.e. the parent of `pending/`. */
  cacheDir: string
  /** Directory holding the bundled `7za` and `app-builder` binaries. */
  toolsDir: string
  /** Run a binary to completion; reject on non-zero exit. */
  run: (file: string, args: string[], cwd?: string) => Promise<void>
  exists: (target: string) => boolean
  /** Must be atomic within `cacheDir` (same filesystem). */
  rename: (from: string, to: string) => void
  /** Must not throw when the target is absent. */
  remove: (target: string) => void
  info?: (message: string) => void
  warn?: (message: string, error?: unknown) => void
}

/**
 * 7za flags, copied verbatim from what electron-builder used to produce the
 * published zip (`app-builder-lib/out/targets/archive.js`).
 *
 * Not stylistic. `-mx=7` is the default `compression: normal` level, and
 * `-mtc=off` / `-mcu` are the two switches electron-builder added specifically
 * to make output reproducible ("to produce the same archive for the same data",
 * "archive should be the same regardless where produced"). Changing any of
 * them changes the compressed bytes, which shrinks the share of blocks that
 * match the published artifact and silently erodes the saving this whole
 * module exists for.
 */
const SEVEN_ZIP_FLAGS = ['a', '-bd', '-mx=7', '-mtc=off', '-mm=Deflate', '-mcu']

/** Whether this machine still lacks a differential source. */
function needsRebuild(deps: RebuildUpdateZipDeps): boolean {
  return !deps.exists(path.join(deps.cacheDir, 'update.zip'))
}

/**
 * Rebuild if this machine needs it, announcing the wait first.
 *
 * `onPreparing` fires only when a rebuild is actually going to run. On the
 * common path — a previous download already left an `update.zip` — this returns
 * immediately, and announcing there would flash a "preparing" state for a
 * no-op. A null `deps` means the build cannot rebuild at all (not macOS, or an
 * unrecognised updater config); that is not an error, just a full download.
 */
export async function prepareDifferentialSource(
  deps: RebuildUpdateZipDeps | null,
  onPreparing: () => void,
): Promise<void> {
  if (deps == null || !needsRebuild(deps)) return
  onPreparing()
  await rebuildUpdateZip(deps)
}

export async function rebuildUpdateZip(
  deps: RebuildUpdateZipDeps,
): Promise<boolean> {
  const updateZip = path.join(deps.cacheDir, 'update.zip')
  const currentBlockmap = path.join(deps.cacheDir, 'current.blockmap')
  const scratchZip = path.join(deps.cacheDir, '.rebuild.zip')
  const scratchBlockmap = path.join(deps.cacheDir, '.rebuild.blockmap')

  if (!needsRebuild(deps)) {
    deps.info?.('differential source already cached, skipping rebuild')
    return false
  }

  const discardScratch = (): void => {
    deps.remove(scratchZip)
    deps.remove(scratchBlockmap)
  }

  try {
    discardScratch()

    // Nothing is excluded, deliberately. An earlier version dropped
    // `__pycache__` because the bundled interpreter used to litter the signed
    // app with bytecode on every run, which made the rebuild drift by 1.87 MB.
    // That leak is fixed at the source now (see `_python_env.py`), so the
    // bundle holds exactly the three .pyc files CPython ships with — and
    // excluding them would itself be the drift: measured, a rebuild WITH them
    // is byte-identical to the published artifact, while one without them
    // differs by 10,649 bytes and costs an extra 0.4 MB of range requests.
    await deps.run(
      path.join(deps.toolsDir, '7za'),
      [...SEVEN_ZIP_FLAGS, scratchZip, path.basename(deps.appBundle)],
      path.dirname(deps.appBundle),
    )
    await deps.run(path.join(deps.toolsDir, 'app-builder'), [
      'blockmap',
      '--input',
      scratchZip,
      '--output',
      scratchBlockmap,
    ])

    // Order is load-bearing. `update.zip` is the sentinel this function skips
    // on, so it has to land last: if it landed first and the process died here,
    // the next run would skip the rebuild while `current.blockmap` still
    // described some older file, and every later diff would read wrong offsets.
    // Publishing the blockmap first means a crash simply leaves no sentinel and
    // the next run redoes both.
    deps.rename(scratchBlockmap, currentBlockmap)
    deps.rename(scratchZip, updateZip)

    deps.info?.('rebuilt differential source for the next update')
    return true
  } catch (error) {
    deps.warn?.('could not rebuild differential source, update will be full', error)
    discardScratch()
    return false
  }
}

/**
 * The cache directory is derived, not chosen: it must be byte-identical to the
 * one electron-updater computes, or the files land where nothing reads them.
 *
 * `updaterCacheDirName` is written into `app-update.yml` at package time by
 * electron-builder (`appInfo.updaterCacheDirName`) and read back by
 * `AppUpdater.getOrCreateDownloadHelper()`. Reading the same file keeps the two
 * in lockstep; recomputing it here from package.json's `name` would silently
 * drift the day that name changes.
 */
function readUpdaterCacheDirName(appUpdateYml: string): string | null {
  try {
    const match = /^updaterCacheDirName:\s*(\S+)\s*$/m.exec(
      readFileSync(appUpdateYml, 'utf8'),
    )
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Bind the rebuild to the running app, or refuse when this build cannot do it.
 *
 * Returns null on any platform but macOS — Windows gets its differential source
 * from the NSIS installer and Linux ships no updater feed — and when
 * `app-update.yml` does not name a cache directory, which means the packaged
 * updater config is not what this code expects and guessing would write 222 MB
 * somewhere nothing reads.
 */
export function createRebuildDeps(
  info: (message: string) => void,
  warn: (message: string, error?: unknown) => void,
): RebuildUpdateZipDeps | null {
  if (process.platform !== 'darwin') return null

  const resources = process.resourcesPath
  const cacheDirName = readUpdaterCacheDirName(path.join(resources, 'app-update.yml'))
  if (cacheDirName == null) {
    warn('app-update.yml has no updaterCacheDirName; skipping rebuild')
    return null
  }

  return {
    // <bundle>/Contents/MacOS/<exe> -> <bundle>
    appBundle: path.resolve(process.execPath, '../../..'),
    // Mirrors electron-updater's getAppCacheDir() on darwin (`AppAdapter.js`).
    cacheDir: path.join(os.homedir(), 'Library', 'Caches', cacheDirName),
    toolsDir: path.join(resources, 'updater_tools'),
    run: async (file, args, cwd) => {
      // No timeout on purpose: repacking the bundle took ~44 s on an M-series
      // machine and scales with disk speed, so any cap we picked would be a
      // coin flip that turns a slow disk into a permanently full download.
      await execFileAsync(file, args, { cwd, maxBuffer: 8 * 1024 * 1024 })
    },
    exists: (target) => existsSync(target),
    rename: (from, to) => renameSync(from, to),
    remove: (target) => rmSync(target, { force: true }),
    info,
    warn,
  }
}
