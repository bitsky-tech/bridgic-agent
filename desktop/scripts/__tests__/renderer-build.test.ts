import { afterEach, describe, expect, it } from 'bun:test'
import { resolveConfig, type UserConfig } from 'vite'
import desktopViteConfig from '../../apps/electron/vite.config'
import { rendererBuildEnvironment, RENDERER_ENTRY_ENV, RENDERER_ENTRY_FILES, type RendererEntry } from '../renderer-entries'

const originalEntry = process.env[RENDERER_ENTRY_ENV]
afterEach(() => {
  if (originalEntry === undefined) delete process.env[RENDERER_ENTRY_ENV]
  else process.env[RENDERER_ENTRY_ENV] = originalEntry
})

async function config(command: 'serve' | 'build'): Promise<UserConfig> {
  if (typeof desktopViteConfig !== 'function') throw new Error('Expected a command-aware Vite config')
  return desktopViteConfig({ command, mode: command === 'build' ? 'production' : 'development', isPreview: false })
}

describe('Renderer production builds', () => {
  it('skips Babel in production while preserving development transforms', async () => {
    delete process.env[RENDERER_ENTRY_ENV]
    const built = await resolveConfig({ ...await config('build'), configFile: false }, 'build')
    const served = await resolveConfig({ ...await config('serve'), configFile: false }, 'serve')
    expect(built.plugins.find(plugin => plugin.name === 'vite:react-babel')?.transform).toBeUndefined()
    expect(served.plugins.find(plugin => plugin.name === 'vite:react-babel')?.transform).toBeDefined()
  })

  it('keeps prior pages and isolates assets for each targeted build', async () => {
    for (const [entry, file] of Object.entries(RENDERER_ENTRY_FILES)) {
      process.env[RENDERER_ENTRY_ENV] = entry
      const built = await config('build')
      expect(built.build?.emptyOutDir).toBe(false)
      expect(built.build?.assetsDir).toBe(`assets/${entry}`)
      expect(built.build?.sourcemap).toBe(true)
      const input = built.build?.rollupOptions?.input as Record<string, string>
      expect(Object.keys(input)).toEqual([entry])
      expect(input[entry]?.replaceAll('\\', '/')).toEndWith(`/src/renderer/${file}`)
    }
  })

  it('retains all development pages even with an inherited build selector', async () => {
    process.env[RENDERER_ENTRY_ENV] = 'word'
    const served = await config('serve')
    expect(Object.keys(served.build?.rollupOptions?.input ?? {})).toEqual(Object.keys(RENDERER_ENTRY_FILES))
    expect(served.build?.assetsDir).toBe('assets')
  })

  it('rejects invalid selectors before producing an incomplete release', async () => {
    process.env[RENDERER_ENTRY_ENV] = 'unknown'
    await expect(config('build')).rejects.toThrow('Unknown renderer entry: unknown')
  })

  it('uses measured per-page heap budgets and preserves other Node options', () => {
    const inherited = { NODE_OPTIONS: '--enable-source-maps', PATH: '/test/bin' }
    for (const entry of Object.keys(RENDERER_ENTRY_FILES) as RendererEntry[]) {
      const environment = rendererBuildEnvironment(entry, inherited)
      expect(environment[RENDERER_ENTRY_ENV]).toBe(entry)
      expect(environment.NODE_OPTIONS).toBe(`--enable-source-maps --max-old-space-size=${entry === 'excel' ? 4096 : 2048}`)
      expect(environment.PATH).toBe(inherited.PATH)
    }
    expect(inherited.NODE_OPTIONS).toBe('--enable-source-maps')
  })

  it('respects explicit caller heap limits in both Node flag spellings', () => {
    for (const options of ['--max-old-space-size=3072', '--max_old_space_size=3072', '--max-old-space-size 3072']) {
      expect(rendererBuildEnvironment('excel', { NODE_OPTIONS: options }).NODE_OPTIONS).toBe(options)
    }
  })
})
