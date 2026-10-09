import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import rendererConfig from '../../apps/electron/vite.config'

const config = await (typeof rendererConfig === 'function'
  ? rendererConfig({ command: 'serve', mode: 'development' })
  : rendererConfig)

describe('Office first-open dependency discovery', () => {
  it('scans every renderer entry and import worker before an editor is opened', () => {
    const root = config.root!
    const patterns = config.optimizeDeps?.entries
    expect(Array.isArray(patterns)).toBe(true)
    const scanned = new Set((patterns as string[]).flatMap((pattern) => [...new Bun.Glob(pattern).scanSync({ cwd: root, onlyFiles: true })]))
    const inputs = config.build?.rollupOptions?.input
    expect(inputs && typeof inputs === 'object').toBe(true)
    for (const input of Object.values(inputs as Record<string, string>)) {
      expect(scanned.has(path.relative(root, input).split(path.sep).join('/'))).toBe(true)
    }
    const workers = [...new Bun.Glob('lib/**/*.worker.ts').scanSync({ cwd: root, onlyFiles: true })]
    expect(workers.length).toBeGreaterThanOrEqual(3)
    for (const worker of workers) expect(scanned.has(worker)).toBe(true)
    expect(scanned.has('lib/wordImport.worker.ts')).toBe(true)
  })
})
