/**
 * Copy the freshly-built `amphi` PyInstaller bundle into the
 * apps/electron/resources/bin/ folder so electron-builder's
 * `extraResources` ships it inside the .app / installer.
 *
 * Run by `bun run dist:*` scripts BEFORE electron-builder kicks in.
 * Failure is fatal. Dist builds must not produce a packaged app that launches
 * without its backend gateway binary.
 *
 * PyInstaller emits a onedir bundle — `dist/amphi/amphi[.exe]` plus a sibling
 * `_internal/` payload directory and, on Windows, `amphi-autostart.exe`. Its
 * CONTENTS are flattened into
 * `resources/bin/` rather than nested one level deeper, so the launcher stays
 * at `resources/bin/amphi[.exe]`: the exact path that `path-resolver.ts`,
 * `installer.nsh`'s PATH injection and `deb-scripts/postinst` all already
 * hard-code. See `build/amphi.spec` for why the build is onedir.
 *
 * The bundle is architecture-specific and CANNOT be cross-compiled (PyInstaller
 * builds for whatever host it runs on), so the target architecture is passed in
 * and verified against the binary itself — see `assertArchMatches`.
 *
 * Source path priority:
 *   1. `$AMPHI_BIN_DIR` env (CI / custom layouts) — the bundle dir itself
 *   2. `../dist/amphi/`  (the repository root, dev default — desktop/ is nested in it)
 *   3. fail with instructions on how to build it
 */

import {
  chmodSync,
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { stripDistInfoPaths } from './strip-dist-info-paths'

const HERE = path.resolve(import.meta.dir ?? __dirname)
const REPO_ROOT = path.resolve(HERE, '..')
const TARGET_DIR = path.join(REPO_ROOT, 'apps', 'electron', 'resources', 'bin')

const CLI_BINARY_NAME = process.platform === 'win32' ? 'amphi.exe' : 'amphi'
const REQUIRED_BINARY_NAMES =
  process.platform === 'win32'
    ? [CLI_BINARY_NAME, 'amphi-autostart.exe']
    : [CLI_BINARY_NAME]
/** Must match `COLLECT(name=...)` in build/amphi.spec. */
const BUNDLE_DIR_NAME = 'amphi'

/** Written by build-pyinstaller.{sh,ps1}; holds the backend version built. */
const BACKEND_VERSION_STAMP = '.backend-version'

/** Mach-O constants, from `<mach-o/loader.h>` and `<mach/machine.h>`. */
const MH_MAGIC_64 = 0xfeedfacf
const CPU_TYPE_X86_64 = 0x01000007
const CPU_TYPE_ARM64 = 0x0100000c

/**
 * Architecture of a thin Mach-O binary, or null when it is not one.
 *
 * Reads the header directly instead of shelling out to `lipo`, so the check also
 * works on a machine without the Xcode command line tools. A universal ("fat")
 * binary has a different magic and returns null — we never produce one, and
 * quietly accepting it would defeat the check.
 */
function readMachOArch(file: string): string | null {
  const header = Buffer.alloc(8)
  const fd = openSync(file, 'r')
  try {
    if (readSync(fd, header, 0, 8, 0) < 8) return null
  } finally {
    closeSync(fd)
  }
  if (header.readUInt32LE(0) !== MH_MAGIC_64) return null
  switch (header.readUInt32LE(4)) {
    case CPU_TYPE_ARM64:
      return 'arm64'
    case CPU_TYPE_X86_64:
      return 'x64'
    default:
      return null
  }
}

/**
 * Refuse to ship a backend built for a different architecture than the app.
 *
 * PyInstaller cannot cross-compile, so `dist/amphi/` always holds a binary for
 * whichever machine last ran build-pyinstaller. Running `dist:mac:x64` on Apple
 * Silicon therefore produces a package whose Electron shell and bundled runtimes
 * are x64 while the backend launcher is arm64 — it builds, signs and notarizes
 * cleanly, and only fails once a user installs it. The version stamp does not
 * catch this: both halves can be the same version and still the wrong CPU.
 *
 * Non-macOS is skipped: those targets are x64-only today, and PE/ELF headers
 * would need their own parsers for no current benefit.
 */
function assertArchMatches(source: string, targetArch: string): void {
  if (process.platform !== 'darwin') return

  const launcher = path.join(source, CLI_BINARY_NAME)
  const actual = readMachOArch(launcher)
  if (actual === null) {
    console.warn(
      `[prebuild-fetch-amphi] WARNING: could not read the Mach-O header of ${launcher}; ` +
        `skipping the architecture check (expected ${targetArch}).`,
    )
    return
  }
  if (actual === targetArch) return

  throw new Error(
    [
      '[prebuild-fetch-amphi] backend bundle is for the wrong architecture.',
      `  Packaging for ${targetArch}, but ${launcher} is ${actual}.`,
      '  PyInstaller cannot cross-compile: build the backend on a machine of the target',
      `  architecture (CI runs the ${targetArch} job on a matching runner), or pass the`,
      '  right bundle via AMPHI_BIN_DIR.',
    ].join('\n'),
  )
}

/**
 * Locate the onedir bundle directory — the one that directly contains the
 * launcher and `_internal/` payload. Requiring both rejects `dist/` itself and
 * stale onefile artifacts left under the old output path.
 */
function findSourceDir(): string | null {
  const candidates: string[] = []
  if (process.env.AMPHI_BIN_DIR) {
    candidates.push(process.env.AMPHI_BIN_DIR)
  }
  candidates.push(path.resolve(REPO_ROOT, '..', 'dist', BUNDLE_DIR_NAME))
  for (const dir of candidates) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue
    const internal = path.join(dir, '_internal')
    if (
      REQUIRED_BINARY_NAMES.every((name) => {
        const binary = path.join(dir, name)
        return existsSync(binary) && statSync(binary).isFile()
      }) &&
      existsSync(internal) &&
      statSync(internal).isDirectory()
    ) {
      return dir
    }
  }
  return null
}

/**
 * Refuse to ship a bundle that was built from a different backend version than
 * the one this release claims to need.
 *
 * `scripts/release-manifest.ts` validates `src/__init__.py` against
 * `package.json` — the SOURCE versions — while what actually gets packaged is
 * whatever `dist/amphi/` happens to hold. Nothing connected the two, so
 * bumping the version and running only `dist:*` produced an artifact whose
 * manifest promised a backend the bundle did not contain. It builds, signs and
 * notarizes cleanly; the failure only surfaces after install, as a permanent
 * "gateway version does not match" screen.
 *
 * A missing stamp means the bundle predates this check — warn rather than fail,
 * so an existing artifact still builds, but say plainly what is unverified.
 */
function assertBackendVersionMatches(source: string): void {
  const expected = readSourceBackendVersion()
  const stampFile = path.join(source, BACKEND_VERSION_STAMP)
  if (!existsSync(stampFile)) {
    console.warn(
      `[prebuild-fetch-amphi] WARNING: ${BACKEND_VERSION_STAMP} missing from ${source}; ` +
        `cannot verify it was built from backend ${expected}. Rebuild with build/build-pyinstaller.sh to remove this warning.`,
    )
    return
  }

  const stamped = readFileSync(stampFile, 'utf-8').trim()
  if (stamped === expected) return

  throw new Error(
    [
      '[prebuild-fetch-amphi] backend bundle is stale.',
      `  src/__init__.py declares ${expected}, but ${source} was built from ${stamped}.`,
      '  Packaging this would ship a release manifest that requires a backend the bundle does not contain,',
      '  which installs fine and then wedges on the version-compatibility screen. Rebuild the backend first:',
      process.platform === 'win32'
        ? '    cd ..; .\\build\\build-pyinstaller.ps1'
        : '    cd .. && bash build/build-pyinstaller.sh',
    ].join('\n'),
  )
}

/** Read `__version__` out of the backend's `src/__init__.py`. */
function readSourceBackendVersion(): string {
  const initFile = path.resolve(REPO_ROOT, '..', 'src', '__init__.py')
  const version = /^__version__ = "(.*)"$/m.exec(readFileSync(initFile, 'utf-8'))?.[1]
  if (!version) {
    throw new Error(`[prebuild-fetch-amphi] could not read __version__ from ${initFile}`)
  }
  return version
}

function main(): void {
  // Mirrors prebuild-fetch-{uv,python,node}: explicit argument first, host as
  // the default so a plain `bun run scripts/prebuild-fetch-amphi.ts` still works.
  const targetArch = process.argv[2] || process.arch
  const source = findSourceDir()
  if (!source) {
    const buildCommand =
      process.platform === 'win32'
        ? '    cd ..; .\\build\\build-pyinstaller.ps1'
        : '    cd .. && bash build/build-pyinstaller.sh'
    throw new Error(
      [
        '[prebuild-fetch-amphi] amphi bundle not found.',
        `  Wanted a directory containing ${REQUIRED_BINARY_NAMES.join(', ')} and _internal/; looked in AMPHI_BIN_DIR`,
        `  (if set) and ../dist/${BUNDLE_DIR_NAME}/. Build it with:`,
        buildCommand,
      ].join('\n'),
    )
  }

  assertBackendVersionMatches(source)
  assertArchMatches(source, targetArch)

  // Wipe first. The bundle is hundreds of files, and a stale `amphi.exe` left
  // over from the pre-onedir builds would otherwise survive here and be shipped
  // alongside — or instead of — the new launcher.
  rmSync(TARGET_DIR, { recursive: true, force: true })
  mkdirSync(TARGET_DIR, { recursive: true })
  cpSync(source, TARGET_DIR, { recursive: true })
  // cpSync preserves the source mode, but the exec bit on the launcher is
  // load-bearing on POSIX and cheap to reassert.
  chmodSync(path.join(TARGET_DIR, CLI_BINARY_NAME), 0o755)

  const stripped = stripDistInfoPaths(TARGET_DIR)

  console.log(
    `[prebuild-fetch-amphi] copied ${source}${path.sep}* (${targetArch}) -> ${TARGET_DIR}` +
      (stripped > 0 ? ` (stripped ${stripped} direct_url.json)` : ''),
  )
}

main()
