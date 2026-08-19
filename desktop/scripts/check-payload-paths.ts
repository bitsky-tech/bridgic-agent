/**
 * Guard the Windows MAX_PATH budget for everything we ship under `resources/`.
 *
 *   bun run scripts/check-payload-paths.ts
 *
 * Windows caps a path at 260 characters (MAX_PATH) unless both the OS and the
 * application opt into long paths, which Electron, PyInstaller's bootloader and
 * npm do not reliably do. Our payload is unusually deep for a desktop app: a
 * bundled CPython, a bundled Node with npm's own `node_modules`, and the
 * PyInstaller `_internal` tree all nest well past what a typical Electron app
 * ships.
 *
 * The failure mode is what makes this worth a build-time check: nothing says
 * "path too long". You get `Failed to load python313.dll`, a bare ENOENT from
 * npm, or a checksum mismatch — symptoms that send you debugging the runtime
 * rather than the install path. And it only reproduces for users whose install
 * directory happens to be long, which is exactly the population that grew when
 * the installer started letting people choose one.
 *
 * Budget arithmetic (keep in sync with `amDirectoryPageLeave` in
 * apps/electron/build/installer.nsh):
 *
 *     260  MAX_PATH
 *   - MAX_PAYLOAD_RELATIVE   longest `resources\...` path we ship
 *   ------------------------------------------------------------
 *   = the budget left for $INSTDIR, from which the installer's own cap is derived
 *
 * If this script starts failing because a tree GREW, the fix is to flatten or
 * drop that tree — not to raise the constant, which would silently shrink the
 * directory budget users may pick from while the installer's cap kept assuming
 * the old one.
 *
 * The one legitimate reason to raise it is that the previous value was measured
 * wrong (see MAX_PAYLOAD_RELATIVE) — and then AM_INSTDIR_MAX_LEN in
 * apps/electron/build/installer.nsh must come down by the same amount. The two
 * are a pair; changing one alone is how 260 gets exceeded quietly.
 */

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

const RESOURCES_DIR = join(import.meta.dir, '../apps/electron/resources')

/**
 * Longest allowed path relative to the install root (i.e. including the leading
 * `resources/` segment).
 *
 * **Measure this on WINDOWS.** The first value here was 150, derived from a
 * macOS payload, and CI immediately reported 161: uv's Windows CPython ships
 * byte-compiled `__pycache__/*.pyc` under `site-packages/pip/_vendor/...` that
 * its macOS build does not, e.g.
 * `resources\python_runtime\cpython-3.13.6-windows-x86_64-none\Lib\site-packages\
 * pip\_vendor\urllib3\packages\backports\__pycache__\weakref_finalize.cpython-313.pyc`
 * at 161 chars. A macOS-derived number is not a bound for the platform this
 * check exists to protect.
 *
 * 165 = 161 measured + 4 slack. Paired with AM_INSTDIR_MAX_LEN = 80 in
 * installer.nsh: 80 + 1 separator + 165 = 246, and `amInstFilesPre` may append
 * a 6-char `\Amphi`, so the worst case a user can reach is 252 of the 260
 * Windows allows.
 */
const MAX_PAYLOAD_RELATIVE = 165

const BUILDER_CONFIG = join(import.meta.dir, '../apps/electron/electron-builder.yml')

/**
 * Subtrees of `resources/` that electron-builder actually ships, read from
 * `extraResources` rather than hand-copied.
 *
 * A hand-copied list drifts silently in the dangerous direction whenever a new
 * runtime subtree is added to `extraResources`. With a static list this check
 * could keep reporting a comfortable bound while the unmeasured payload exceeds
 * MAX_PATH — the exact silent DLL-load failure the header describes.
 *
 * Deliberately a regex over the YAML rather than a parser: this runs on every
 * `dist:*` and pulling in a YAML dependency for four lines is not worth it. It
 * matches only `- from: resources/<name>` at the indentation electron-builder
 * uses, and commented-out entries do not match.
 */
export function packagedSubtrees(configPath = BUILDER_CONFIG): string[] {
  const raw = readFileSync(configPath, 'utf-8')
  const names = [...raw.matchAll(/^\s*-\s*from:\s*resources\/([A-Za-z0-9_-]+)\s*$/gm)]
    .map((match) => match[1])
    .filter((name): name is string => name !== undefined)
  if (names.length === 0) {
    throw new Error(
      `No \`- from: resources/<dir>\` entries found in ${configPath}. ` +
        'Either extraResources moved or this pattern went stale — refusing to ' +
        'report a clean payload it never actually measured.',
    )
  }
  return names
}

interface Longest {
  length: number
  path: string
}

function walk(dir: string, onFile: (absolute: string) => void, seen = new Set<string>()): void {
  // Symlink loops are not hypothetical in this payload: a Python framework build
  // ships `Versions/Current -> .`, and following it without a visited set
  // recurses until the stack blows. Track resolved directories, not names.
  const real = realpathSync(dir)
  if (seen.has(real)) return
  seen.add(real)

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(absolute, onFile, seen)
    } else if (entry.isFile()) {
      onFile(absolute)
    } else if (entry.isSymbolicLink()) {
      // readdir reports a link as neither file nor directory; resolve it to
      // decide. A dangling link has nothing to measure and must not abort the run.
      try {
        if (statSync(absolute).isDirectory()) walk(absolute, onFile, seen)
        else onFile(absolute)
      } catch {
        // dangling symlink — nothing to measure
      }
    }
  }
}

export function longestPackagedPath(resourcesDir = RESOURCES_DIR): {
  longest: Longest | null
  skipped: string[]
} {
  let longest: Longest | null = null
  const skipped: string[] = []

  for (const subtree of packagedSubtrees()) {
    const root = join(resourcesDir, subtree)
    if (!existsSync(root)) {
      skipped.push(subtree)
      continue
    }
    let files = 0
    const measure = (absolute: string): void => {
      files += 1
      // Windows separators, and prefixed with `resources/` because that is where
      // the tree lands relative to $INSTDIR.
      const rel = `resources${sep}${relative(resourcesDir, absolute)}`.split(sep).join('\\')
      if (longest === null || rel.length > longest.length) {
        longest = { length: rel.length, path: rel }
      }
    }
    // An extraResources entry may name a single file (LICENSE, NOTICE), and
    // walk() readdirs its root — ENOTDIR on a file.
    if (statSync(root).isDirectory()) walk(root, measure)
    else measure(root)
    // An existing but empty subtree is a failed fetch that still created the
    // directory. Counting it as present would let the check report success over
    // a payload that is not actually there.
    if (files === 0) skipped.push(`${subtree} (present but empty)`)
  }

  return { longest, skipped }
}

function main(): void {
  const { longest, skipped } = longestPackagedPath()

  if (skipped.length > 0) {
    console.log(
      `ℹ payload path check: skipped ${skipped.join(', ')} (not fetched — run bun run prebuild:fetch-*)`,
    )
  }

  if (longest === null) {
    console.log('ℹ payload path check: nothing to measure, skipping')
    return
  }

  if (longest.length > MAX_PAYLOAD_RELATIVE) {
    console.error(
      `\n❌ payload path check: longest packaged path is ${longest.length} chars, ` +
        `budget is ${MAX_PAYLOAD_RELATIVE}\n` +
        `   ${longest.path}\n\n` +
        `   Windows MAX_PATH is 260. Every char here is a char users cannot spend on\n` +
        `   their install directory, and overrunning it surfaces as DLL-load / ENOENT\n` +
        `   failures with no mention of path length. Flatten or drop the tree above —\n` +
        `   do NOT raise MAX_PAYLOAD_RELATIVE without also lowering the installer's\n` +
        `   directory cap in apps/electron/build/installer.nsh.`,
    )
    process.exit(1)
  }

  console.log(
    `✔ payload path check: longest packaged path ${longest.length}/${MAX_PAYLOAD_RELATIVE} chars`,
  )
}

if (import.meta.main) {
  main()
}

export { MAX_PAYLOAD_RELATIVE }
