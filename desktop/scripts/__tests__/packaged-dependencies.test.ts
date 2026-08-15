/**
 * Pins the one rule that decides what electron-builder copies into the asar.
 *
 * electron-builder packs the production dependency closure of
 * `apps/electron/package.json` VERBATIM — no bundler, no tree-shaking, source
 * directories and all. Everything else reaches the app through esbuild/Vite.
 * So a package belongs in `dependencies` if and only if the bundle cannot
 * inline it, which is exactly esbuild's `external` list.
 *
 * Get this wrong in the harmless-looking direction — move a bundled package
 * back into `dependencies` because that is "where runtime deps go" — and the
 * app ships two copies of it: one inlined in main.cjs, one loose in the asar.
 * That is what the packaged 0.1.13 build did with posthog-node (+3.8 MB), and
 * it also dragged in 143 TypeScript source and test files from @app/shared,
 * @app/ui and @posthog/core. Nothing crashes, nothing turns red — the package
 * just quietly grows. This test is the tripwire, since package.json cannot
 * carry a comment explaining it.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const SCRIPTS_DIR = path.join(import.meta.dir, '..')
const ELECTRON_PKG = path.join(SCRIPTS_DIR, '../apps/electron/package.json')
const BUILD_MAIN = path.join(SCRIPTS_DIR, 'electron-build-main.ts')

/** Packages esbuild refuses to inline, read from the build script itself. */
function esbuildExternals(): string[] {
  const source = readFileSync(BUILD_MAIN, 'utf-8')
  const match = /external:\s*\[([^\]]*)\]/.exec(source)
  if (match?.[1] === undefined) {
    throw new Error(`no \`external:\` array found in ${BUILD_MAIN} — did the build script change shape?`)
  }
  return [...match[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1] as string)
}

function packagedDependencies(): string[] {
  const pkg = JSON.parse(readFileSync(ELECTRON_PKG, 'utf-8')) as {
    dependencies?: Record<string, string>
  }
  return Object.keys(pkg.dependencies ?? {})
}

describe('apps/electron production dependencies', () => {
  it('contains only packages esbuild cannot inline', () => {
    const externals = new Set(esbuildExternals())
    const stowaways = packagedDependencies().filter((name) => !externals.has(name))
    expect(stowaways).toEqual([])
  })

  it('keeps every external that is a real package available at runtime', () => {
    // `electron` is provided by the runtime itself and must NOT be a dependency;
    // every other external is require()d from the asar and must be present.
    const deps = new Set(packagedDependencies())
    const missing = esbuildExternals().filter((name) => name !== 'electron' && !deps.has(name))
    expect(missing).toEqual([])
  })

  it('does not list workspace packages — they are bundled, not copied', () => {
    // @app/shared is inlined into main.cjs and the renderer chunks (its i18n
    // JSON included, via static re-export). Listing it here would ship its
    // src/ tree, __tests__ and all, on top of the copy already in the bundle.
    expect(packagedDependencies().filter((name) => name.startsWith('@app/'))).toEqual([])
  })
})
