/**
 * Generate `THIRD-PARTY-LICENSES.txt` — the complete third-party license text
 * that must ship inside the installed application.
 *
 *   bun run scripts/gen-third-party-licenses.ts
 *
 * Why this file has to exist at all
 * ---------------------------------
 * MIT says the notice "shall be included in all copies or substantial portions
 * of the Software"; Apache-2.0 §4(a)(d), BSD, ISC and OFL-1.1 all carry the
 * same retain-the-notice obligation. Until this script landed the packaged app
 * shipped ~189 bundled JS packages, ~120 Python packages and 59 OFL fonts with
 * *zero* license text — the only two files present (`node_runtime/LICENSE`,
 * Electron's own `LICENSE`) were dropped in by electron-builder by accident of
 * how those trees are copied. The repo's NOTICE claimed this file was
 * "generated at build time" since the first compliance commit, but no generator
 * was ever written, so the claim pointed at nothing.
 *
 * Why the bundle is discovered from SOURCEMAPS, not from package.json
 * -------------------------------------------------------------------
 * `dependencies` vs `devDependencies` says NOTHING about what ships here.
 * `apps/electron/package.json` lists mermaid / katex / shiki / react-markdown
 * under devDependencies, yet Vite bundles every one of them into the renderer;
 * meanwhile the 860 packages installed under node_modules are overwhelmingly
 * build tooling that never reaches a user. electron-builder packs
 * `files: dist/**\/*` with `asar: true` and does not copy node_modules at all,
 * so the only honest answer to "what did we distribute" is "whatever esbuild
 * and Vite actually inlined" — which is exactly what the emitted `.map`
 * `sources` arrays record. Reading the dependency graph instead would
 * simultaneously over-report (sharp's LGPL-3.0 libvips, lightningcss's MPL-2.0
 * — both build-time only) and under-report nothing, i.e. it would attach scary
 * obligations we do not actually incur while adding no real coverage.
 *
 * The `.map` files are safe to rely on: `electron-builder.yml` excludes them
 * from the asar via `!**\/*.map`, but that only filters what gets packed — the
 * files are still on disk next to the bundles after a build. This script must
 * therefore run AFTER `bun run build` and BEFORE `electron-builder` packages.
 *
 * Why fonts are handled separately from their npm package
 * --------------------------------------------------------
 * `katex`'s package.json and LICENSE both say MIT — but the 59 font files Vite
 * copies into `dist/renderer/assets/` are generated from metafont sources whose
 * headers read "Copyright 1995, 2009 American Mathematical Society. This Font
 * Software is licensed under the SIL Open Font License, Version 1.1." Any
 * scanner that reads package metadata alone (including every SBOM tool) marks
 * those 59 files MIT, which is wrong. Binary assets carry licenses that simply
 * are not present in the metadata, so they get their own pass.
 *
 * Missing license text is reported, never silently dropped — a package we
 * cannot find text for is listed in the output as such and printed to stderr,
 * because an incomplete file that *looks* complete is worse than a loud gap.
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'

const DESKTOP_DIR = join(import.meta.dir, '..')
const REPO_ROOT = join(DESKTOP_DIR, '..')
const ELECTRON_DIR = join(DESKTOP_DIR, 'apps/electron')
const DIST_DIR = join(ELECTRON_DIR, 'dist')
const RESOURCES_DIR = join(ELECTRON_DIR, 'resources')
const NODE_MODULES = join(DESKTOP_DIR, 'node_modules')
const OUTPUT_PATH = join(RESOURCES_DIR, 'THIRD-PARTY-LICENSES.txt')

/** Filenames that hold license text, in the order we prefer them. */
const LICENSE_FILENAMES = [
  'LICENSE',
  'LICENSE.md',
  'LICENSE.txt',
  'LICENCE',
  'LICENCE.md',
  'LICENCE.txt',
  'COPYING',
  'COPYING.txt',
  'LICENSE-MIT',
  'LICENSE-APACHE',
  'NOTICE',
]

/** One third-party component and the license text we found for it. */
export interface LicenseEntry {
  name: string
  version: string
  license: string
  /** Full license text, or `null` when the package shipped none. */
  text: string | null
  /** Where it came from — drives the section it lands in. */
  origin: 'javascript' | 'python' | 'runtime' | 'font' | 'installer'
}

/**
 * Extract distinct npm package names from the `sources` array of a sourcemap.
 *
 * Sources look like `../../../node_modules/jszip/lib/index.js`; scoped packages
 * keep two path segments (`@radix-ui/react-dropdown-menu`). Entries outside
 * node_modules are first-party code and are skipped.
 */
export function packagesFromSourcemapSources(sources: readonly string[]): string[] {
  const found = new Set<string>()
  for (const source of sources) {
    const marker = source.lastIndexOf('node_modules/')
    if (marker < 0) continue
    const rest = source.slice(marker + 'node_modules/'.length)
    const parts = rest.split('/')
    const first = parts[0]
    if (first === undefined || first === '') continue
    if (first.startsWith('@')) {
      const second = parts[1]
      if (second === undefined || second === '') continue
      found.add(`${first}/${second}`)
      continue
    }
    found.add(first)
  }
  return [...found].sort()
}

/**
 * Read the license identifier out of a Python `.dist-info/METADATA` blob.
 *
 * Modern wheels carry `License-Expression: MIT`; older ones only have a
 * `Classifier: License :: OSI Approved :: MIT License` line, and some (aiohttp,
 * yarl, sqlalchemy …) declare neither, which is why `UNKNOWN` is a real result
 * rather than an error — those get resolved by hand in NOTICE.
 */
export function parsePythonLicense(metadata: string): string {
  const expression = /^License-Expression:[^\S\n]*(.+)$/m.exec(metadata)
  if (expression?.[1] !== undefined) return expression[1].trim()

  const classifier = /^Classifier:[^\S\n]*License[^\S\n]*::[^\S\n]*(.+)$/m.exec(metadata)
  if (classifier?.[1] !== undefined) {
    const value = classifier[1].trim()
    // "OSI Approved :: MIT License" → "MIT License"; the OSI prefix is noise.
    return value.startsWith('OSI Approved ::') ? value.slice('OSI Approved ::'.length).trim() : value
  }

  // `License: MIT` is the oldest form and is frequently the FULL license text
  // rather than an identifier, so it is only trusted when it fits on one line.
  const legacy = /^License:[^\S\n]*(.+)$/m.exec(metadata)
  if (legacy?.[1] !== undefined) {
    const value = legacy[1].trim()
    if (value !== '' && value.length < 60) return value
  }

  return 'UNKNOWN'
}

/** Read `Name`/`Version` from a Python METADATA blob, falling back to the dir name. */
function parsePythonNameVersion(metadata: string, dirName: string): { name: string; version: string } {
  const name = /^Name:[^\S\n]*(.+)$/m.exec(metadata)?.[1]?.trim()
  const version = /^Version:[^\S\n]*(.+)$/m.exec(metadata)?.[1]?.trim()
  if (name !== undefined && version !== undefined) return { name, version }
  // `foo-1.2.3.dist-info` → name `foo`, version `1.2.3`.
  const base = dirName.replace(/\.dist-info$/, '')
  const split = base.lastIndexOf('-')
  if (split < 0) return { name: base, version: 'unknown' }
  return { name: base.slice(0, split), version: base.slice(split + 1) }
}

/** First license-looking file directly inside `dir`, or in its `licenses/` subdir. */
/**
 * Pick the license file out of a directory listing, case-insensitively.
 *
 * Pure on purpose. The obvious implementation — `existsSync(join(dir,
 * 'LICENSE'))` for each candidate — silently depends on the HOST filesystem's
 * case sensitivity: APFS and NTFS resolve `LICENSE` to an on-disk `license`,
 * ext4 does not. `khroma` and `clsx` both ship lowercase `license`, so that
 * version worked on macOS and Windows and would have dropped their texts on a
 * Linux runner, reported only as a stderr warning.
 *
 * Worse, the bug is untestable through the filesystem on a case-insensitive
 * host: a fixture named `license` satisfies `existsSync('LICENSE')` there, so
 * the test passes on macOS either way and proves nothing. Taking the listing as
 * an argument moves the decision off the filesystem entirely, which is what
 * makes it verifiable on any platform.
 *
 * @param entries - `readdirSync` output for the package directory
 * @returns the actual on-disk name to read, or `null`
 */
export function pickLicenseFile(entries: readonly string[]): string | null {
  const byLower = new Map<string, string>()
  for (const entry of entries) {
    const key = entry.toLowerCase()
    // First writer wins so a stable listing yields a stable pick.
    if (!byLower.has(key)) byLower.set(key, entry)
  }
  for (const candidate of LICENSE_FILENAMES) {
    const hit = byLower.get(candidate.toLowerCase())
    if (hit !== undefined) return hit
  }
  return null
}

export function findLicenseText(dir: string): string | null {
  let listing: string[] = []
  try {
    listing = readdirSync(dir)
  } catch {
    return null
  }

  const filename = pickLicenseFile(listing)
  if (filename !== null) {
    const candidate = join(dir, filename)
    if (statSync(candidate).isFile()) {
      return readFileSync(candidate, 'utf-8').trimEnd()
    }
  }

  // Python wheels put them under `.dist-info/licenses/`, sometimes several.
  const licensesDir = join(dir, 'licenses')
  if (existsSync(licensesDir) && statSync(licensesDir).isDirectory()) {
    const collected: string[] = []
    for (const entry of readdirSync(licensesDir).sort()) {
      const full = join(licensesDir, entry)
      if (statSync(full).isFile()) {
        collected.push(`--- ${entry} ---\n${readFileSync(full, 'utf-8').trimEnd()}`)
      }
    }
    if (collected.length > 0) return collected.join('\n\n')
  }
  return null
}

/** Normalize the many shapes npm allows in the `license` / `licenses` field. */
function normalizeNpmLicense(pkg: Record<string, unknown>): string {
  const { license, licenses } = pkg
  if (typeof license === 'string') return license
  if (license !== null && typeof license === 'object') {
    const type = (license as { type?: unknown }).type
    if (typeof type === 'string') return type
  }
  if (Array.isArray(licenses)) {
    const types = licenses
      .map((item) => (typeof item === 'string' ? item : (item as { type?: unknown })?.type))
      .filter((item): item is string => typeof item === 'string')
    if (types.length > 0) return types.join(' OR ')
  }
  return 'UNKNOWN'
}

/** Every `.map` file emitted by the main/preload/renderer builds. */
function collectSourcemapPaths(): string[] {
  const paths: string[] = []
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        walk(full)
        continue
      }
      if (entry.endsWith('.map')) paths.push(full)
    }
  }
  walk(DIST_DIR)
  return paths
}

/** Bundled npm packages, resolved back to their installed license text. */
export function collectJavaScriptEntries(): LicenseEntry[] {
  const mapPaths = collectSourcemapPaths()
  if (mapPaths.length === 0) {
    throw new Error(
      `No sourcemaps under ${DIST_DIR} — run \`bun run build\` first. ` +
        'Without them the bundled-package set cannot be determined and the ' +
        'generated file would silently omit every JavaScript dependency.',
    )
  }

  const names = new Set<string>()
  for (const mapPath of mapPaths) {
    const parsed = JSON.parse(readFileSync(mapPath, 'utf-8')) as { sources?: unknown }
    if (!Array.isArray(parsed.sources)) continue
    const sources = parsed.sources.filter((item): item is string => typeof item === 'string')
    for (const name of packagesFromSourcemapSources(sources)) names.add(name)
  }

  const entries: LicenseEntry[] = []
  for (const name of [...names].sort()) {
    const dir = join(NODE_MODULES, ...name.split('/'))
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
    entries.push({
      name,
      version: typeof manifest.version === 'string' ? manifest.version : 'unknown',
      license: normalizeNpmLicense(manifest),
      text: findLicenseText(dir),
      origin: 'javascript',
    })
  }
  return entries
}

/**
 * Walk the production dependency closure of a package manifest.
 *
 * Mirrors what electron-builder packs: `dependencies` plus
 * `optionalDependencies`, transitively, never `devDependencies`. Exported so
 * the traversal can be tested against a synthetic tree.
 *
 * @param readManifest - resolves a package name to its parsed package.json, or
 *                       `null` when it is not installed
 */
export function productionClosure(
  rootDir: string,
  rootNames: readonly string[],
  resolveFrom: (name: string, fromDir: string) => string | null,
  readManifest: (dir: string) => Record<string, unknown> | null,
): string[] {
  const seen = new Set<string>()
  const queue: Array<{ name: string; fromDir: string }> = rootNames.map((name) => ({
    name,
    fromDir: rootDir,
  }))

  while (queue.length > 0) {
    const item = queue.shift()
    if (item === undefined) continue
    const dir = resolveFrom(item.name, item.fromDir)
    // Keyed by resolved DIRECTORY, not by name: two versions of the same
    // package legitimately coexist (electron-updater nests its own semver) and
    // both ship, so both belong in the manifest.
    if (dir === null || seen.has(dir)) continue
    seen.add(dir)

    const manifest = readManifest(dir)
    if (manifest === null) continue
    for (const field of ['dependencies', 'optionalDependencies']) {
      const deps = manifest[field]
      if (deps === null || typeof deps !== 'object') continue
      for (const dep of Object.keys(deps as Record<string, unknown>)) {
        queue.push({ name: dep, fromDir: dir })
      }
    }
  }
  return [...seen].sort()
}

/**
 * Resolve a dependency the way Node does: nearest `node_modules` first, then
 * upward toward `rootDir`.
 *
 * Naively joining `rootDir/node_modules/<name>` reads the HOISTED copy, which
 * is not always the one that ships. `electron-updater` nests its own `semver`
 * 7.7.4 while the hoisted one is 6.3.1 — electron-builder packs the nested
 * copy, so the flat lookup recorded a version no user ever receives. Licenses
 * happened to match here (both ISC); a package that relicenses between majors
 * would have turned that into a real compliance error.
 *
 * `exists` is injected so the walk can be tested without a fixture tree.
 */
export function resolvePackageDir(
  name: string,
  fromDir: string,
  rootDir: string,
  exists: (path: string) => boolean,
): string | null {
  const segments = name.split('/')
  let current = fromDir
  for (;;) {
    const candidate = join(current, 'node_modules', ...segments)
    if (exists(join(candidate, 'package.json'))) return candidate
    if (current === rootDir) return null
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * npm packages electron-builder copies into the asar verbatim.
 *
 * THE BLIND SPOT THIS CLOSES: everything else in this file is discovered from
 * sourcemaps, which only record what esbuild and Vite actually inlined. But
 * `electron-builder` ALSO packs the production dependency tree of
 * `apps/electron/package.json` into the asar untouched — and esbuild's
 * `external: ['electron', 'electron-updater', 'electron-log']` guarantees those
 * packages, plus their entire transitive closure (builder-util-runtime, fs-extra,
 * js-yaml, sax, semver, …), never appear in any bundle and therefore leave no
 * sourcemap trace at all. Auditing the packaged 0.1.13 app found 17 such
 * packages shipping with no license text.
 *
 * `electron-log` looked covered only by accident — the renderer imports
 * `electron-log/renderer`, so Vite inlined a copy. That coincidence is exactly
 * why this cannot be left to the sourcemap pass.
 *
 * Workspace packages (`@app/*`) are skipped: they are first-party code governed
 * by the repo LICENSE, not third-party software.
 */
export function collectPackagedNodeModules(): LicenseEntry[] {
  const manifestPath = join(ELECTRON_DIR, 'package.json')
  if (!existsSync(manifestPath)) return []
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as Record<string, unknown>
  const roots = (manifest.dependencies ?? {}) as Record<string, string>

  const readManifest = (dir: string): Record<string, unknown> | null => {
    const file = join(dir, 'package.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf-8')) as Record<string, unknown>
  }
  const resolveFrom = (name: string, fromDir: string): string | null =>
    resolvePackageDir(name, fromDir, DESKTOP_DIR, existsSync)

  const entries: LicenseEntry[] = []
  for (const dir of productionClosure(DESKTOP_DIR, Object.keys(roots), resolveFrom, readManifest)) {
    const pkg = readManifest(dir)
    if (pkg === null) continue
    const name = typeof pkg.name === 'string' ? pkg.name : ''
    if (name === '' || name.startsWith('@app/')) continue
    entries.push({
      name,
      version: typeof pkg.version === 'string' ? pkg.version : 'unknown',
      license: normalizeNpmLicense(pkg),
      text: findLicenseText(dir),
      origin: 'javascript',
    })
  }
  return entries
}

/** Python packages inside the PyInstaller payload (`resources/bin/_internal`). */
export function collectPythonEntries(): LicenseEntry[] {
  const internal = join(RESOURCES_DIR, 'bin/_internal')
  if (!existsSync(internal)) return []

  const entries: LicenseEntry[] = []
  for (const dirName of readdirSync(internal).sort()) {
    if (!dirName.endsWith('.dist-info')) continue
    const dir = join(internal, dirName)
    const metadataPath = join(dir, 'METADATA')
    const metadata = existsSync(metadataPath) ? readFileSync(metadataPath, 'utf-8') : ''
    const { name, version } = parsePythonNameVersion(metadata, dirName)
    entries.push({
      name,
      version,
      license: parsePythonLicense(metadata),
      text: findLicenseText(dir),
      origin: 'python',
    })
  }
  return entries
}

/**
 * The bundled runtimes shipped via `extraResources`.
 *
 * These are whole third-party distributions (CPython, Node.js, uv, and the
 * PyInstaller-built `amphi` launcher), each embedding its own subtree of
 * dependencies. Only `node_runtime` currently ships a LICENSE of its own; the
 * rest are declared by hand in NOTICE, and this pass records which is which so
 * that gap stays visible instead of being assumed handled.
 */
export function collectRuntimeEntries(): LicenseEntry[] {
  const runtimes: ReadonlyArray<{ dir: string; name: string; license: string }> = [
    { dir: 'python_runtime', name: 'CPython (python-build-standalone)', license: 'PSF-2.0' },
    { dir: 'node_runtime', name: 'Node.js', license: 'MIT' },
    { dir: 'uv_runtime', name: 'uv', license: 'Apache-2.0 OR MIT' },
  ]

  const entries: LicenseEntry[] = []
  for (const runtime of runtimes) {
    const dir = join(RESOURCES_DIR, runtime.dir)
    if (!existsSync(dir)) continue
    entries.push({
      name: runtime.name,
      version: 'bundled',
      license: runtime.license,
      text: findLicenseText(dir) ?? findNestedLicense(dir),
      origin: 'runtime',
    })
  }

  const electron = collectElectronEntry()
  if (electron !== null) entries.push(electron)
  return entries
}

/**
 * Electron itself — the one runtime that is NOT staged through `resources/`.
 *
 * electron-builder copies `node_modules/electron/dist/Electron.app` and renames
 * it, but Electron's own LICENSE and LICENSES.chromium.html sit BESIDE that
 * bundle in `dist/`, not inside it — so on macOS they are left behind entirely
 * (verified against the packaged 0.1.13 app: the only LICENSE anywhere in the
 * .app came from node_runtime). Pulling the MIT text in here is what puts it
 * back. LICENSES.chromium.html is deliberately NOT bundled — it is 15 MB
 * against a 579 MB package, and NOTICE points at the upstream Electron release
 * for the full Chromium credits instead.
 */
function collectElectronEntry(): LicenseEntry | null {
  const dist = join(NODE_MODULES, 'electron/dist')
  const licensePath = join(dist, 'LICENSE')
  if (!existsSync(licensePath)) return null

  return {
    name: 'Electron',
    version: packagedElectronVersion(),
    license: 'MIT',
    text: readFileSync(licensePath, 'utf-8').trimEnd(),
    origin: 'runtime',
  }
}

/**
 * The Electron version that actually ships, which is NOT necessarily the one in
 * node_modules.
 *
 * `electron-builder.yml` pins `electronVersion`, and electron-builder downloads
 * exactly that build regardless of what `bun install` put in node_modules — the
 * two currently disagree (39.2.7 packaged vs 39.8.10 installed). Reading the
 * manifest would therefore stamp a version into the shipped license file that
 * no user ever runs. The license text is identical across patch releases, so
 * this is an accuracy fix rather than a compliance one, but a notice file that
 * misstates a version is exactly the kind of detail an audit picks on.
 */
function packagedElectronVersion(): string {
  const config = join(ELECTRON_DIR, 'electron-builder.yml')
  if (existsSync(config)) {
    const pinned = /^electronVersion:\s*["']?([^"'\s]+)["']?/m.exec(readFileSync(config, 'utf-8'))
    if (pinned?.[1] !== undefined) return pinned[1]
  }
  const manifestPath = join(NODE_MODULES, 'electron/package.json')
  if (!existsSync(manifestPath)) return 'unknown'
  const version = (JSON.parse(readFileSync(manifestPath, 'utf-8')) as { version?: unknown }).version
  return typeof version === 'string' ? version : 'unknown'
}

/** Runtime tarballs nest their LICENSE one level down (e.g. `cpython-3.13.6-…/LICENSE`). */
function findNestedLicense(dir: string): string | null {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (!statSync(full).isDirectory()) continue
    const text = findLicenseText(full)
    if (text !== null) return text
  }
  return null
}

/**
 * The three copyright holders of the KaTeX font family.
 *
 * Transcribed from the font sources inside the installed `katex` package —
 * `src/fonts/*.mf` (the AMS line) and `src/fonts/lib/*.ttx` (the other two).
 * They are hard-coded rather than parsed because the `.ttx` copies are
 * HTML-escaped, duplicated and truncated across dozens of files, so extracting
 * them costs far more code than it saves; they are also historical and frozen.
 * Re-check this list when bumping `katex` to a major version.
 */
const KATEX_FONT_COPYRIGHTS = [
  'Copyright 1995, 2009 American Mathematical Society.',
  'Copyright (c) 2009-2010 Design Science, Inc. (www.mathjax.org)',
  'Copyright (c) 2014-2018 Khan Academy (www.khanacademy.org)',
] as const

/**
 * Font assets copied into the renderer bundle.
 *
 * Keyed off the emitted filenames rather than the npm package, because the
 * package metadata attributes them to the wrong license entirely — see the
 * module header. The OFL text is vendored under `scripts/license-texts/`
 * because `katex` ships the `.mf` sources that *reference* OFL.txt without
 * shipping OFL.txt itself, and OFL-1.1 condition 2 requires each copy of the
 * font software to be distributed together with the license.
 */
export function collectFontEntries(): LicenseEntry[] {
  const assets = join(DIST_DIR, 'renderer/assets')
  if (!existsSync(assets)) return []

  const katexFonts = readdirSync(assets).filter(
    (entry) => entry.startsWith('KaTeX_') && /\.(woff2?|ttf|otf)$/.test(entry),
  )
  if (katexFonts.length === 0) return []

  const oflPath = join(import.meta.dir, 'license-texts/OFL-1.1.txt')
  const ofl = existsSync(oflPath) ? readFileSync(oflPath, 'utf-8').trimEnd() : null
  return [
    {
      name: `KaTeX fonts (${katexFonts.length} files)`,
      version: 'bundled',
      license: 'OFL-1.1',
      text: ofl === null ? null : `${KATEX_FONT_COPYRIGHTS.join('\n')}\n\n${ofl}`,
      origin: 'font',
    },
  ]
}

/**
 * Components linked into the Windows NSIS installer.
 *
 * Easy to miss because they never appear in any dependency graph: the DLL is
 * compiled into the installer executable by NSIS at package time, straight out
 * of `buildResources`. It ships to every Windows user all the same.
 */
export function collectInstallerEntries(): LicenseEntry[] {
  const dir = join(RESOURCES_DIR, 'x86-unicode')
  const dll = join(dir, 'EnVar.dll')
  if (!existsSync(dll)) return []

  const licensePath = join(dir, 'EnVar-LICENSE.txt')
  return [
    {
      name: 'EnVar NSIS plugin',
      version: 'bundled',
      license: 'Zlib',
      text: existsSync(licensePath) ? readFileSync(licensePath, 'utf-8').trimEnd() : null,
      origin: 'installer',
    },
  ]
}

const SECTION_TITLES: Record<LicenseEntry['origin'], string> = {
  javascript: 'Bundled JavaScript packages',
  font: 'Bundled font assets',
  python: 'Bundled Python packages (amphi)',
  runtime: 'Bundled runtimes',
  installer: 'Bundled installer components (Windows)',
}

const RULE = '='.repeat(80)
const THIN_RULE = '-'.repeat(80)

/**
 * Render the final document.
 *
 * Pure so the layout — and in particular the "license text not found" wording,
 * which is the part a reviewer scans for — can be asserted without a build.
 */
export function formatLicenseDocument(entries: readonly LicenseEntry[], version: string): string {
  const lines: string[] = [
    'THIRD-PARTY LICENSES',
    `Bridgic Agent ${version}`,
    '',
    'This product bundles the third-party components listed below. Each is',
    'reproduced with the license text as distributed by its author.',
    '',
    'Components requiring a statement beyond this list — dual-license elections,',
    'MPL source availability, and the PyInstaller bootloader exception — are',
    'declared in the accompanying NOTICE file.',
    '',
  ]

  const origins: ReadonlyArray<LicenseEntry['origin']> = [
    'javascript',
    'font',
    'python',
    'runtime',
    'installer',
  ]
  for (const origin of origins) {
    const group = entries.filter((entry) => entry.origin === origin)
    if (group.length === 0) continue
    lines.push(RULE, `${SECTION_TITLES[origin]} (${group.length})`, RULE, '')
    for (const entry of group) {
      lines.push(THIN_RULE, `${entry.name}@${entry.version}  —  ${entry.license}`, THIN_RULE, '')
      lines.push(entry.text ?? '[license text not found in the distributed package]', '')
    }
  }
  return `${lines.join('\n').trimEnd()}\n`
}

/** Write atomically so a killed build cannot leave a half-written file that looks complete. */
export function writeLicenseDocument(content: string, outputPath = OUTPUT_PATH): void {
  const tmp = `${outputPath}.tmp`
  writeFileSync(tmp, content, 'utf-8')
  renameSync(tmp, outputPath)
}

function readDesktopVersion(): string {
  const raw = readFileSync(join(DESKTOP_DIR, 'package.json'), 'utf-8')
  const version = (JSON.parse(raw) as { version?: unknown }).version
  return typeof version === 'string' ? version : '0.0.0'
}

/**
 * Copy the repo-root LICENSE and NOTICE next to the generated file.
 *
 * All three are staged into `resources/` together so `electron-builder.yml`
 * addresses them uniformly, and — more importantly — so the set cannot ship
 * half-complete. THIRD-PARTY-LICENSES.txt points at NOTICE, LICENSE condition 1
 * requires the license to travel with any redistribution, and NOTICE points
 * back at THIRD-PARTY-LICENSES.txt. A missing member is a dangling reference in
 * a compliance document, which is exactly how the previous NOTICE ended up
 * citing a THIRD-PARTY-LICENSES.txt that no build had ever produced. Failing
 * loudly here is the guard against repeating that.
 */
function stageComplianceDocuments(): void {
  for (const filename of ['LICENSE', 'NOTICE']) {
    const source = join(REPO_ROOT, filename)
    if (!existsSync(source)) {
      throw new Error(
        `${filename} is missing from the repository root. THIRD-PARTY-LICENSES.txt ` +
          'references it, so shipping without it would leave a dangling reference ' +
          'in a compliance document.',
      )
    }
    writeFileSync(join(RESOURCES_DIR, filename), readFileSync(source, 'utf-8'), 'utf-8')
  }
}

/**
 * Merge the two npm passes.
 *
 * A package can legitimately arrive from both: `posthog-node` is inlined into
 * main.cjs by esbuild AND copied into the asar by electron-builder. Keeping the
 * copy that actually carries license text avoids reporting a false gap.
 */
export function dedupeEntries(entries: readonly LicenseEntry[]): LicenseEntry[] {
  const byKey = new Map<string, LicenseEntry>()
  for (const entry of entries) {
    const key = `${entry.origin}:${entry.name}`
    const existing = byKey.get(key)
    if (existing === undefined || (existing.text === null && entry.text !== null)) {
      byKey.set(key, entry)
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function generateThirdPartyLicenses(): { entries: LicenseEntry[]; missing: LicenseEntry[] } {
  const entries = dedupeEntries([
    ...collectJavaScriptEntries(),
    ...collectPackagedNodeModules(),
    ...collectFontEntries(),
    ...collectPythonEntries(),
    ...collectRuntimeEntries(),
    ...collectInstallerEntries(),
  ])
  writeLicenseDocument(formatLicenseDocument(entries, readDesktopVersion()))
  stageComplianceDocuments()
  return { entries, missing: entries.filter((entry) => entry.text === null) }
}

if (import.meta.main) {
  try {
    const { entries, missing } = generateThirdPartyLicenses()
    console.log(`✔ THIRD-PARTY-LICENSES.txt: ${entries.length} components`)
    if (missing.length > 0) {
      // Loud on purpose: each of these is a retain-the-notice obligation we
      // cannot satisfy from the package alone and must cover in NOTICE by hand.
      console.warn(`⚠ ${missing.length} without license text (declare these in NOTICE):`)
      for (const entry of missing) console.warn(`    ${entry.name}@${entry.version} (${entry.license})`)
    }
  } catch (err) {
    console.error(`\n❌ third-party licenses: ${err instanceof Error ? err.message : String(err)}`)
    process.exit(1)
  }
}
