/**
 * Tests for scripts/gen-third-party-licenses.ts.
 *
 * The failure mode this file guards against is specific: a generated
 * THIRD-PARTY-LICENSES.txt that *looks* complete while silently omitting or
 * misattributing components. Every case below is one where a plausible bug
 * produces a well-formed file that a reviewer would sign off on.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  collectRuntimeEntries,
  dedupeEntries,
  findLicenseText,
  formatLicenseDocument,
  packagesFromSourcemapSources,
  parsePythonLicense,
  pickLicenseFile,
  productionClosure,
  resolvePackageDir,
  type LicenseEntry,
} from '../gen-third-party-licenses'

let tmpDirs: string[] = []

function tmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'third-party-licenses-test-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true })
  tmpDirs = []
})

describe('collectRuntimeEntries', () => {
  it('attributes the packaged models.dev snapshot with its MIT text', () => {
    const entry = collectRuntimeEntries().find((item) => item.name === 'models.dev catalog snapshot')
    expect(entry?.license).toBe('MIT')
    expect(entry?.text).toContain('Copyright (c) 2025 models.dev')
  })
})

describe('packagesFromSourcemapSources', () => {
  it('keeps both segments of a scoped package', () => {
    // Truncating to `@radix-ui` would fail the node_modules/<name>/package.json
    // lookup, and the collector skips anything it cannot resolve — so the
    // package would vanish from the output with no warning at all.
    expect(
      packagesFromSourcemapSources(['../../../node_modules/@radix-ui/react-dropdown-menu/dist/index.js']),
    ).toEqual(['@radix-ui/react-dropdown-menu'])
  })

  it('attributes a nested dependency to the inner package, not the outer one', () => {
    // `lastIndexOf` matters here. Taking the FIRST node_modules would credit
    // jszip's files to electron-devtools-installer and drop jszip's own
    // (MIT OR GPL-3.0) license from the document entirely.
    expect(
      packagesFromSourcemapSources([
        '../../../node_modules/electron-devtools-installer/node_modules/jszip/lib/index.js',
      ]),
    ).toEqual(['jszip'])
  })

  it('ignores first-party sources outside node_modules', () => {
    expect(packagesFromSourcemapSources(['../src/main/index.ts', '../src/renderer/App.tsx'])).toEqual([])
  })

  it('de-duplicates and sorts', () => {
    expect(
      packagesFromSourcemapSources([
        '../../../node_modules/react/index.js',
        '../../../node_modules/jotai/esm/index.mjs',
        '../../../node_modules/react/jsx-runtime.js',
      ]),
    ).toEqual(['jotai', 'react'])
  })

  it('skips a malformed scoped path with no package segment', () => {
    expect(packagesFromSourcemapSources(['../../../node_modules/@scope/'])).toEqual([])
  })
})

describe('parsePythonLicense', () => {
  it('prefers the modern License-Expression field', () => {
    const metadata = ['Name: dulwich', 'License-Expression: Apache-2.0 OR GPL-2.0-or-later'].join('\n')
    expect(parsePythonLicense(metadata)).toBe('Apache-2.0 OR GPL-2.0-or-later')
  })

  it('strips the OSI Approved prefix from a classifier', () => {
    const metadata = ['Name: certifi', 'Classifier: License :: OSI Approved :: MIT License'].join('\n')
    expect(parsePythonLicense(metadata)).toBe('MIT License')
  })

  it('does not mistake an inlined full license for an identifier', () => {
    // Many older wheels put the ENTIRE license body after `License:`. Accepting
    // it would put a wall of legal text where the document prints a one-line
    // identifier, wrecking the section a reviewer skims.
    const metadata = [
      'Name: legacy-pkg',
      'License: Permission is hereby granted, free of charge, to any person obtaining a copy of this software',
    ].join('\n')
    expect(parsePythonLicense(metadata)).toBe('UNKNOWN')
  })

  it('accepts a short legacy License line', () => {
    expect(parsePythonLicense('Name: old-pkg\nLicense: BSD-3-Clause')).toBe('BSD-3-Clause')
  })

  it('reports UNKNOWN rather than guessing when nothing is declared', () => {
    // aiohttp / yarl / sqlalchemy really do ship without any license metadata;
    // UNKNOWN is the honest answer and routes them to NOTICE for a hand check.
    expect(parsePythonLicense('Name: aiohttp\nVersion: 3.13.5')).toBe('UNKNOWN')
  })
})

describe('findLicenseText', () => {
  it('reads a plain LICENSE file', () => {
    const dir = tmpDir()
    writeFileSync(path.join(dir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 Someone\n')
    expect(findLicenseText(dir)).toContain('Copyright (c) 2026 Someone')
  })

  it('collects every file from a wheel licenses/ directory', () => {
    // Python wheels split multi-license packages across several files; taking
    // only the first would drop, for example, tqdm's MPL half.
    const dir = tmpDir()
    mkdirSync(path.join(dir, 'licenses'))
    writeFileSync(path.join(dir, 'licenses', 'LICENSE'), 'MPL text')
    writeFileSync(path.join(dir, 'licenses', 'NOTICE'), 'MIT text')
    const text = findLicenseText(dir)
    expect(text).toContain('MPL text')
    expect(text).toContain('MIT text')
  })

  it('returns null when the package ships no license text', () => {
    expect(findLicenseText(tmpDir())).toBeNull()
  })
})

describe('pickLicenseFile', () => {
  // These assertions never touch the filesystem — that is the entire point.
  // The bug they lock down (lowercase `license` missed on ext4) is invisible to
  // any fixture-based test run on macOS, because APFS resolves `LICENSE` to
  // `license` for the old implementation too. Feeding the listing in directly
  // makes the result identical on every platform.
  it('matches a lowercase license file', () => {
    // khroma and clsx both ship exactly this.
    expect(pickLicenseFile(['index.js', 'license', 'package.json'])).toBe('license')
  })

  it('returns the real on-disk name, not the canonical one', () => {
    // The caller reads the returned name verbatim; handing back `LICENSE`
    // would ENOENT on a case-sensitive filesystem.
    expect(pickLicenseFile(['LiCeNsE.md'])).toBe('LiCeNsE.md')
  })

  it('honours candidate priority over listing order', () => {
    // LICENSE outranks NOTICE regardless of how readdir happened to sort.
    expect(pickLicenseFile(['NOTICE', 'LICENSE'])).toBe('LICENSE')
  })

  it('falls through the whole candidate list', () => {
    expect(pickLicenseFile(['copying.txt'])).toBe('copying.txt')
  })

  it('returns null when nothing matches', () => {
    expect(pickLicenseFile(['index.js', 'README.md'])).toBeNull()
  })
})

describe('resolvePackageDir', () => {
  // Also filesystem-free: `exists` is injected, so the walk order is asserted
  // directly rather than inferred from a fixture tree.
  it('prefers a nested copy over the hoisted one', () => {
    // The real case: electron-updater nests semver 7.7.4 while the hoisted
    // copy is 6.3.1, and electron-builder packs the nested one.
    const present = new Set(['/r/node_modules/electron-updater/node_modules/semver/package.json'])
    expect(
      resolvePackageDir('semver', '/r/node_modules/electron-updater', '/r', (p) => present.has(p)),
    ).toBe('/r/node_modules/electron-updater/node_modules/semver')
  })

  it('walks up to the hoisted copy when there is no nested one', () => {
    const present = new Set(['/r/node_modules/semver/package.json'])
    expect(
      resolvePackageDir('semver', '/r/node_modules/electron-updater', '/r', (p) => present.has(p)),
    ).toBe('/r/node_modules/semver')
  })

  it('stops at rootDir instead of escaping the project', () => {
    expect(resolvePackageDir('ghost', '/r/node_modules/a', '/r', () => false)).toBeNull()
  })

  it('resolves scoped packages', () => {
    const present = new Set(['/r/node_modules/@posthog/core/package.json'])
    expect(resolvePackageDir('@posthog/core', '/r', '/r', (p) => present.has(p))).toBe(
      '/r/node_modules/@posthog/core',
    )
  })
})

describe('productionClosure', () => {
  /**
   * Model a flat (hoisted) layout: every package lives at `/r/node_modules/<name>`.
   * `resolveFrom` ignores the starting directory, which is exactly what the old
   * implementation did implicitly — kept here so the flat cases stay covered.
   */
  const flat = (graph: Record<string, Record<string, unknown>>) => ({
    resolveFrom: (name: string) => (name in graph ? `/r/node_modules/${name}` : null),
    readManifest: (dir: string) => graph[dir.replace('/r/node_modules/', '')] ?? null,
  })

  it('follows transitive dependencies', () => {
    // electron-updater is `external` to esbuild, so it and its whole subtree
    // leave no sourcemap trace, yet electron-builder copies all of them in.
    const g = flat({
      'electron-updater': { dependencies: { 'builder-util-runtime': '9.0.0' } },
      'builder-util-runtime': { dependencies: { sax: '1.0.0', 'lazy-val': '1.0.0' } },
      sax: {},
      'lazy-val': {},
    })
    expect(productionClosure('/r', ['electron-updater'], g.resolveFrom, g.readManifest)).toEqual([
      '/r/node_modules/builder-util-runtime',
      '/r/node_modules/electron-updater',
      '/r/node_modules/lazy-val',
      '/r/node_modules/sax',
    ])
  })

  it('keeps BOTH copies when a dependency is nested', () => {
    // The regression this rewrite fixes: keying by name collapsed the nested
    // semver into the hoisted one, so the manifest recorded 6.3.1 while 7.7.4
    // was what actually shipped.
    const dirs: Record<string, Record<string, unknown>> = {
      '/r/node_modules/electron-updater': { dependencies: { semver: '^7.0.0' } },
      '/r/node_modules/electron-updater/node_modules/semver': {},
      '/r/node_modules/other': { dependencies: { semver: '^6.0.0' } },
      '/r/node_modules/semver': {},
    }
    const resolveFrom = (name: string, fromDir: string) => {
      const nested = `${fromDir}/node_modules/${name}`
      if (nested in dirs) return nested
      const hoisted = `/r/node_modules/${name}`
      return hoisted in dirs ? hoisted : null
    }
    const closure = productionClosure(
      '/r',
      ['electron-updater', 'other'],
      resolveFrom,
      (dir) => dirs[dir] ?? null,
    )
    expect(closure).toContain('/r/node_modules/electron-updater/node_modules/semver')
    expect(closure).toContain('/r/node_modules/semver')
  })

  it('does not follow devDependencies', () => {
    // electron-builder never packs them; including them would attach license
    // obligations for build tooling we do not distribute.
    const g = flat({ a: { devDependencies: { typescript: '5.0.0' } }, typescript: {} })
    expect(productionClosure('/r', ['a'], g.resolveFrom, g.readManifest)).toEqual([
      '/r/node_modules/a',
    ])
  })

  it('follows optionalDependencies — electron-builder packs those too', () => {
    const g = flat({ a: { optionalDependencies: { b: '1.0.0' } }, b: {} })
    expect(productionClosure('/r', ['a'], g.resolveFrom, g.readManifest)).toEqual([
      '/r/node_modules/a',
      '/r/node_modules/b',
    ])
  })

  it('terminates on a dependency cycle', () => {
    const g = flat({ a: { dependencies: { b: '1.0.0' } }, b: { dependencies: { a: '1.0.0' } } })
    expect(productionClosure('/r', ['a'], g.resolveFrom, g.readManifest)).toEqual([
      '/r/node_modules/a',
      '/r/node_modules/b',
    ])
  })

  it('skips packages that are not installed', () => {
    expect(productionClosure('/r', ['ghost'], () => null, () => null)).toEqual([])
  })
})

describe('dedupeEntries', () => {
  const entry = (over: Partial<LicenseEntry>): LicenseEntry => ({
    name: 'posthog-node',
    version: '5.48.1',
    license: 'MIT',
    text: 'MIT text',
    origin: 'javascript',
    ...over,
  })

  it('keeps the copy that has license text', () => {
    // posthog-node arrives twice: inlined by esbuild (sourcemap pass) and copied
    // into the asar (dependency pass). Keeping the textless one would report a
    // gap that does not exist.
    const merged = dedupeEntries([entry({ text: null }), entry({ text: 'MIT text' })])
    expect(merged).toHaveLength(1)
    expect(merged[0]?.text).toBe('MIT text')
  })

  it('does not merge across origins', () => {
    const merged = dedupeEntries([entry({ name: 'x' }), entry({ name: 'x', origin: 'python' })])
    expect(merged).toHaveLength(2)
  })

  it('sorts by name', () => {
    const merged = dedupeEntries([entry({ name: 'zod' }), entry({ name: 'argparse' })])
    expect(merged.map((item) => item.name)).toEqual(['argparse', 'zod'])
  })
})

describe('formatLicenseDocument', () => {
  const entry = (over: Partial<LicenseEntry>): LicenseEntry => ({
    name: 'pkg',
    version: '1.0.0',
    license: 'MIT',
    text: 'MIT License text',
    origin: 'javascript',
    ...over,
  })

  it('flags a missing license text explicitly instead of leaving a blank', () => {
    // The whole point of the file is proving the notices shipped. A silent gap
    // reads as "covered" to anyone skimming; this line is what makes it not.
    const out = formatLicenseDocument([entry({ text: null })], '0.1.0')
    expect(out).toContain('[license text not found in the distributed package]')
  })

  it('groups by origin with per-section counts', () => {
    const out = formatLicenseDocument(
      [
        entry({ name: 'react' }),
        entry({ name: 'jotai' }),
        entry({ name: 'certifi', origin: 'python' }),
        entry({ name: 'KaTeX fonts', origin: 'font', license: 'OFL-1.1' }),
      ],
      '0.1.0',
    )
    expect(out).toContain('Bundled JavaScript packages (2)')
    expect(out).toContain('Bundled Python packages (amphi) (1)')
    expect(out).toContain('Bundled font assets (1)')
    expect(out).not.toContain('Bundled runtimes')
  })

  it('points at NOTICE for the statements it cannot generate', () => {
    // The two documents are complementary: this one carries the texts, NOTICE
    // carries the dual-license elections and the PyInstaller GPL exception.
    // Dropping the pointer is how the pair drifted apart the first time.
    expect(formatLicenseDocument([entry({})], '0.1.0')).toContain('NOTICE')
  })

  it('records the version so a shipped file can be traced to its build', () => {
    expect(formatLicenseDocument([entry({})], '0.1.18')).toContain('Bridgic Agent 0.1.18')
  })
})
