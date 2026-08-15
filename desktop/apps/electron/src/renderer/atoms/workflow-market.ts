/**
 * Workflow-market data for the home page, cached on disk.
 *
 * Read path (stale-while-revalidate), driven by `refreshWorkflowMarketAtom` every
 * time the home page becomes visible:
 *
 *   1. First call reads `market-cache.json`. A usable entry is rendered
 *      immediately — no waiting on the network for a second launch.
 *   2. A fetch is issued only when there is nothing usable, or the entry is older
 *      than REFRESH_INTERVAL_MS, or it was fetched for a different language.
 *   3. On success the list is replaced and the cache rewritten. On failure the
 *      current list stays as it is; nothing is surfaced to the UI.
 *
 * Deliberately not built on `useBlobPersistence` (§1.27) even though it also
 * persists a JSON blob: that hook mirrors renderer state to disk, debounce-saving
 * the whole map whenever the state changes. Here the write must happen only after
 * a successful fetch — mirroring would also write when the list is seeded from
 * cache, and could not tell "keep the old list because the fetch failed" apart
 * from "the list legitimately changed".
 *
 * There is no built-in fallback list. When nothing is available the atom holds an
 * empty array and the home page renders no market section at all, which is why
 * every failure here is a warning rather than an error.
 */

import { atom } from 'jotai'

import { fetchShowcaseWorkflows, type ShowcaseWorkflow } from '@/lib/showcaseClient'
import { rlog } from '@/lib/logger'
import type { ResolvedLocale } from './locale'

/** Six hours: the payload changes on the order of days, and the origin itself
 *  serves it with a 600s CDN cache, so polling harder cannot surface anything
 *  newer. */
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Fixed key inside the blob. Unlike drafts / spec-comments this store is not
 *  keyed by session — it holds one global entry. */
const CACHE_KEY = 'workflows'

interface MarketCacheEntry {
  fetchedAt: number
  lang: ResolvedLocale
  workflows: ShowcaseWorkflow[]
}

const _workflows = atom<ShowcaseWorkflow[]>([])
/** When the currently held list was fetched; 0 means "nothing fetched yet". */
const _fetchedAt = atom(0)
/** Which language the held list belongs to; null before anything is loaded. */
const _lang = atom<ResolvedLocale | null>(null)
/** Whether the on-disk cache has been consulted (once per app run). */
const _cacheRead = atom(false)
/** In-flight guard: switching away and back quickly must not stack requests. */
const _fetching = atom(false)

/** Read — the workflow list to render. Empty means "render no market section". */
export const workflowMarketAtom = atom((get) => get(_workflows))

/** Shape-check one cache entry. Anything unrecognised is treated as absent: the
 *  file is written by an older build, hand-edited, or truncated. */
function parseCacheEntry(raw: unknown): MarketCacheEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const entry = raw as Partial<MarketCacheEntry>
  if (typeof entry.fetchedAt !== 'number' || !Number.isFinite(entry.fetchedAt)) return null
  if (entry.lang !== 'zh' && entry.lang !== 'en') return null
  if (!Array.isArray(entry.workflows)) return null
  return { fetchedAt: entry.fetchedAt, lang: entry.lang, workflows: entry.workflows as ShowcaseWorkflow[] }
}

/**
 * Write — call whenever the home page becomes visible, passing the language in
 * effect.
 *
 * The language is a parameter rather than read from `localeAtom` here so this atom
 * depends on nothing but the fetch and the cache: `atoms/settings` touches
 * `window` at module scope, which would drag a DOM into every test importing this
 * file. The caller already holds the resolved locale, and passing it also makes a
 * language switch flow naturally through the effect's dependency list.
 *
 * Safe to call redundantly: it reads the cache at most once per run, skips the
 * network while the held list is fresh, and drops out entirely if a fetch is
 * already in flight.
 */
export const refreshWorkflowMarketAtom = atom(
  null,
  async (get, set, lang: ResolvedLocale): Promise<void> => {
    // Step 1 — consult the cache once per run, before deciding about the network.
    if (!get(_cacheRead)) {
      set(_cacheRead, true)
      try {
        const blob = await window.api.market.load()
        const entry = parseCacheEntry(blob[CACHE_KEY])
        // A cache fetched for another language is intentionally ignored rather than
        // rendered-then-replaced: showing the wrong language for a moment reads as a
        // bug, and the fetch below will fill it in.
        if (entry && entry.lang === lang) {
          set(_workflows, entry.workflows)
          set(_fetchedAt, entry.fetchedAt)
          set(_lang, entry.lang)
        }
      } catch (err: unknown) {
        rlog.warn('[market] cache read failed; starting from empty', err)
      }
    }

    // Step 2 — decide whether the network is needed at all.
    const heldLang = get(_lang)
    const age = Date.now() - get(_fetchedAt)
    const needsFetch = heldLang !== lang || age >= REFRESH_INTERVAL_MS
    if (!needsFetch || get(_fetching)) return

    // Step 3 — fetch. Failures keep whatever is already on screen.
    set(_fetching, true)
    try {
      const workflows = await fetchShowcaseWorkflows(lang)
      const fetchedAt = Date.now()
      set(_workflows, workflows)
      set(_fetchedAt, fetchedAt)
      set(_lang, lang)

      const entry: MarketCacheEntry = { fetchedAt, lang, workflows }
      // A failed write only costs a redundant fetch next launch, so it must not
      // discard the data already applied above.
      await window.api.market
        .save({ [CACHE_KEY]: entry })
        .catch((err: unknown) => rlog.warn('[market] cache write failed', err))
    } catch (err: unknown) {
      rlog.warn('[market] fetch failed; keeping the current list', err)
    } finally {
      set(_fetching, false)
    }
  },
)
