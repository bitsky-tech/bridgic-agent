import { afterEach, describe, expect, test } from 'bun:test'
import { createStore } from 'jotai'

import { refreshWorkflowMarketAtom, workflowMarketAtom } from '../workflow-market'

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

const workflow = (id: string) => ({
  id,
  name: id,
  desc: 'desc',
  domain: 'domain',
  status: 'verified',
  path: `zh/workflows/${id}`,
})

const INDEX = { endpoints: { workflows: { zh: 'api/workflows.zh.json', en: 'api/workflows.en.json' } } }

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })

interface Harness {
  store: ReturnType<typeof createStore>
  fetchCalls: string[]
  saved: Record<string, unknown>[]
}

const realFetch = globalThis.fetch
let restoreApi: (() => void) | undefined

/**
 * Builds a store plus stubbed `window.api.market` and `fetch`.
 * `cache` seeds what the on-disk blob returns; `fetchFails` makes the network throw.
 */
function harness(opts: { cache?: unknown; fetchFails?: boolean; lang?: string; remoteIds?: string[] } = {}): Harness {
  const fetchCalls: string[] = []
  const saved: Record<string, unknown>[] = []

  const api = {
    market: {
      load: async () => (opts.cache === undefined ? {} : { workflows: opts.cache }),
      save: async (cache: Record<string, unknown>) => {
        saved.push(cache)
      },
    },
  }
  const w = globalThis as unknown as { window?: unknown; api?: unknown }
  const prevWindow = w.window
  w.window = { api }
  restoreApi = () => {
    w.window = prevWindow
  }

  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url)
    fetchCalls.push(u)
    if (opts.fetchFails === true) throw new DOMException('timed out', 'TimeoutError')
    if (u.endsWith('index.json')) return json(INDEX)
    return json({ lang: opts.lang ?? 'zh', workflows: (opts.remoteIds ?? ['remote-a', 'remote-b']).map(workflow) })
  }) as typeof fetch

  return { store: createStore(), fetchCalls, saved }
}

afterEach(() => {
  globalThis.fetch = realFetch
  restoreApi?.()
  restoreApi = undefined
})

describe('refreshWorkflowMarketAtom', () => {
  test('starts empty, then fills from the network when there is no cache', async () => {
    const h = harness()
    expect(h.store.get(workflowMarketAtom)).toEqual([])

    await h.store.set(refreshWorkflowMarketAtom, 'zh')

    expect(h.store.get(workflowMarketAtom).map((w) => w.id)).toEqual(['remote-a', 'remote-b'])
    // index.json + the language payload
    expect(h.fetchCalls).toHaveLength(2)
  })

  test('writes the fetched list to the cache with a timestamp and language', async () => {
    const h = harness()
    await h.store.set(refreshWorkflowMarketAtom, 'zh')

    expect(h.saved).toHaveLength(1)
    const entry = h.saved[0]?.workflows as { fetchedAt: number; lang: string; workflows: unknown[] }
    expect(entry.lang).toBe('zh')
    expect(entry.workflows).toHaveLength(2)
    expect(entry.fetchedAt).toBeGreaterThan(0)
  })

  test('renders a fresh cache without touching the network', async () => {
    const h = harness({
      cache: { fetchedAt: Date.now() - 60_000, lang: 'zh', workflows: [workflow('cached')] },
    })

    await h.store.set(refreshWorkflowMarketAtom, 'zh')

    expect(h.store.get(workflowMarketAtom).map((w) => w.id)).toEqual(['cached'])
    expect(h.fetchCalls).toEqual([])
  })

  test('refetches once the cache is older than the interval', async () => {
    const h = harness({
      cache: { fetchedAt: Date.now() - SIX_HOURS_MS - 1_000, lang: 'zh', workflows: [workflow('stale')] },
    })

    await h.store.set(refreshWorkflowMarketAtom, 'zh')

    expect(h.fetchCalls).toHaveLength(2)
    expect(h.store.get(workflowMarketAtom).map((w) => w.id)).toEqual(['remote-a', 'remote-b'])
  })

  test('keeps the cached list when the fetch fails', async () => {
    const h = harness({
      cache: { fetchedAt: Date.now() - SIX_HOURS_MS - 1_000, lang: 'zh', workflows: [workflow('stale')] },
      fetchFails: true,
    })

    await h.store.set(refreshWorkflowMarketAtom, 'zh')

    // Stale data beats an empty grid; the failure is only logged.
    expect(h.store.get(workflowMarketAtom).map((w) => w.id)).toEqual(['stale'])
    expect(h.saved).toEqual([])
  })

  test('stays empty when there is no cache and the fetch fails', async () => {
    const h = harness({ fetchFails: true })

    await h.store.set(refreshWorkflowMarketAtom, 'zh')

    // The home page renders no market section at all in this state.
    expect(h.store.get(workflowMarketAtom)).toEqual([])
  })

  test('ignores a cache fetched for another language and fetches instead', async () => {
    const h = harness({
      cache: { fetchedAt: Date.now() - 60_000, lang: 'en', workflows: [workflow('english')] },
    })

    await h.store.set(refreshWorkflowMarketAtom, 'zh')

    // Showing the wrong language briefly would read as a bug, so the entry is
    // skipped rather than rendered-then-replaced.
    expect(h.store.get(workflowMarketAtom).map((w) => w.id)).not.toContain('english')
    expect(h.fetchCalls).toHaveLength(2)
  })

  test('ignores a malformed cache entry', async () => {
    const h = harness({ cache: { fetchedAt: 'yesterday', lang: 'zh' } })

    await h.store.set(refreshWorkflowMarketAtom, 'zh')

    expect(h.fetchCalls).toHaveLength(2)
    expect(h.store.get(workflowMarketAtom).map((w) => w.id)).toEqual(['remote-a', 'remote-b'])
  })

  test('a second call while fresh issues no further requests', async () => {
    const h = harness()
    await h.store.set(refreshWorkflowMarketAtom, 'zh')
    const afterFirst = h.fetchCalls.length

    await h.store.set(refreshWorkflowMarketAtom, 'zh')

    expect(h.fetchCalls).toHaveLength(afterFirst)
  })

  test('concurrent calls collapse into a single fetch', async () => {
    const h = harness()

    await Promise.all([
      h.store.set(refreshWorkflowMarketAtom, 'zh'),
      h.store.set(refreshWorkflowMarketAtom, 'zh'),
      h.store.set(refreshWorkflowMarketAtom, 'zh'),
    ])

    expect(h.fetchCalls).toHaveLength(2)
  })
})
