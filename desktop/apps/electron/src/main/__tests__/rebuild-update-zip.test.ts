import { describe, expect, it } from 'bun:test'
import path from 'node:path'
import {
  prepareDifferentialSource,
  rebuildUpdateZip,
  type RebuildUpdateZipDeps,
} from '../rebuild-update-zip'

const APP_BUNDLE = '/Applications/Bridgic Agent.app'
const CACHE_DIR = '/cache/amphi-updater'
const TOOLS_DIR = '/app/Contents/Resources/updater_tools'

const UPDATE_ZIP = path.join(CACHE_DIR, 'update.zip')
const CURRENT_BLOCKMAP = path.join(CACHE_DIR, 'current.blockmap')

interface Call {
  file: string
  args: string[]
  cwd?: string
}

function harness(
  options: {
    existing?: string[]
    failOn?: '7za' | 'app-builder'
  } = {},
): {
  deps: RebuildUpdateZipDeps
  calls: Call[]
  renames: Array<[string, string]>
  removed: string[]
  files: Set<string>
} {
  const files = new Set(options.existing ?? [])
  const calls: Call[] = []
  const renames: Array<[string, string]> = []
  const removed: string[] = []

  const deps: RebuildUpdateZipDeps = {
    appBundle: APP_BUNDLE,
    cacheDir: CACHE_DIR,
    toolsDir: TOOLS_DIR,
    run: async (file, args, cwd) => {
      calls.push({ file, args, cwd })
      if (options.failOn != null && file.endsWith(options.failOn)) {
        throw new Error(`${options.failOn} exited with code 2`)
      }
      // Model each tool's output landing on disk, so later existence checks
      // behave like the real thing. Located by content rather than position:
      // 7za takes trailing `-xr!` switches after the archive path.
      const produced = file.endsWith('7za')
        ? args.find((a) => a.startsWith(CACHE_DIR) && a.endsWith('.zip'))
        : args[args.indexOf('--output') + 1]
      if (produced != null) files.add(produced)
    },
    exists: (p) => files.has(p),
    rename: (from, to) => {
      renames.push([from, to])
      files.delete(from)
      files.add(to)
    },
    remove: (p) => {
      removed.push(p)
      files.delete(p)
    },
  }

  return { deps, calls, renames, removed, files }
}

describe('rebuilding the updater differential source', () => {
  it('does nothing when a differential source is already cached', async () => {
    const h = harness({ existing: [UPDATE_ZIP] })

    expect(await rebuildUpdateZip(h.deps)).toBe(false)
    expect(h.calls).toEqual([])
    expect(h.renames).toEqual([])
  })

  it('repacks the bundle with the exact flags electron-builder used', async () => {
    const h = harness()

    expect(await rebuildUpdateZip(h.deps)).toBe(true)

    const zip = h.calls[0]
    expect(zip?.file).toBe(path.join(TOOLS_DIR, '7za'))
    // Deviating from these makes the output diverge from the published artifact
    // far enough that differential matching degrades. -mx=7 mirrors the default
    // `compression: normal`; -mtc=off and -mcu are what make 7za deterministic.
    expect(zip?.args).toContain('-mx=7')
    expect(zip?.args).toContain('-mtc=off')
    expect(zip?.args).toContain('-mm=Deflate')
    expect(zip?.args).toContain('-mcu')
    // Python writes bytecode caches into the installed bundle after first run;
    // they are absent from the published zip and must not be packed.
    expect(zip?.args).toContain('-xr!__pycache__')
    // 7za is invoked from the bundle's parent so the archive root is the .app.
    expect(zip?.cwd).toBe('/Applications')
    expect(zip?.args).toContain('Bridgic Agent.app')
  })

  it('generates a blockmap for the zip it just built', async () => {
    const h = harness()

    await rebuildUpdateZip(h.deps)

    const blockmap = h.calls[1]
    expect(blockmap?.file).toBe(path.join(TOOLS_DIR, 'app-builder'))
    expect(blockmap?.args[0]).toBe('blockmap')
    const input = blockmap?.args[blockmap.args.indexOf('--input') + 1]
    const zipOutput = h.calls[0]?.args.find(
      (a) => a.startsWith(CACHE_DIR) && a.endsWith('.zip'),
    )
    expect(input).toBe(zipOutput)
  })

  it('publishes the blockmap before the zip so the zip stays the commit point', async () => {
    const h = harness()

    await rebuildUpdateZip(h.deps)

    // update.zip is what the skip check looks for. If it landed first and the
    // process died, the next run would skip while current.blockmap still
    // described a different file -- every later diff would read wrong offsets.
    expect(h.renames.map(([, to]) => to)).toEqual([CURRENT_BLOCKMAP, UPDATE_ZIP])
    expect(h.files.has(UPDATE_ZIP)).toBe(true)
    expect(h.files.has(CURRENT_BLOCKMAP)).toBe(true)
  })

  it('overwrites a stale blockmap left by an earlier version', async () => {
    const h = harness({ existing: [CURRENT_BLOCKMAP] })

    expect(await rebuildUpdateZip(h.deps)).toBe(true)
    expect(h.renames.map(([, to]) => to)).toContain(CURRENT_BLOCKMAP)
  })

  it('publishes nothing when repacking fails', async () => {
    const h = harness({ failOn: '7za' })

    expect(await rebuildUpdateZip(h.deps)).toBe(false)
    expect(h.renames).toEqual([])
    expect(h.files.has(UPDATE_ZIP)).toBe(false)
  })

  it('publishes nothing when the blockmap step fails', async () => {
    const h = harness({ failOn: 'app-builder' })

    expect(await rebuildUpdateZip(h.deps)).toBe(false)
    // A zip without its matching blockmap is worse than no zip at all: the
    // updater would pair it with the published release's blockmap.
    expect(h.files.has(UPDATE_ZIP)).toBe(false)
    expect(h.renames).toEqual([])
  })

  it('leaves no scratch files behind after a failure', async () => {
    const h = harness({ failOn: 'app-builder' })

    await rebuildUpdateZip(h.deps)

    for (const leftover of h.files) {
      expect(leftover.startsWith(CACHE_DIR)).toBe(true)
      expect(leftover).not.toContain('rebuild')
    }
  })

  it('reports the failure reason instead of throwing', async () => {
    const h = harness({ failOn: '7za' })
    const warnings: string[] = []

    const result = await rebuildUpdateZip({
      ...h.deps,
      warn: (message) => warnings.push(message),
    })

    expect(result).toBe(false)
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('deciding whether to prepare a differential source', () => {
  it('announces the wait before starting a rebuild that will take a minute', async () => {
    const h = harness()
    const order: string[] = []

    await prepareDifferentialSource(
      { ...h.deps, run: async (...a) => { order.push('rebuild'); return h.deps.run(...a) } },
      () => order.push('announce'),
    )

    // Announcing after the fact would leave the UI silent for the whole wait,
    // which reads as a hang.
    expect(order[0]).toBe('announce')
    expect(order).toContain('rebuild')
  })

  it('stays silent and does nothing when a source is already cached', async () => {
    const h = harness({ existing: [UPDATE_ZIP] })
    let announced = false

    await prepareDifferentialSource(h.deps, () => { announced = true })

    // The common path: flashing "preparing" for a no-op is worse than nothing.
    expect(announced).toBe(false)
    expect(h.calls).toEqual([])
  })

  it('stays silent on builds that cannot rebuild at all', async () => {
    let announced = false

    await prepareDifferentialSource(null, () => { announced = true })

    expect(announced).toBe(false)
  })

  it('resolves rather than throwing when the rebuild fails', async () => {
    const h = harness({ failOn: 'app-builder' })

    expect(
      await prepareDifferentialSource(h.deps, () => {}).then(() => 'resolved'),
    ).toBe('resolved')
  })
})
