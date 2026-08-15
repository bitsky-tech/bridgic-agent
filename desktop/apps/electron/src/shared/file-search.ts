/**
 * File-search scorer — tiered fuzzy matching over breadcrumbed file entries.
 *
 * SHARED between the main process (the `fs.searchDir` walker scores entries
 * where the data lives, so whole trees never cross IPC) and renderer tests.
 * Pure functions only — no fs, no electron, no react.
 *
 * Search contract (spec'd with the user, keep in sync with tests):
 *   - Match = query is a SUBSEQUENCE of the name or of the full path
 *     (`aaa` hits `.agents/skills/bridgic-browser/references/cli-sdk-api-mapping.md`
 *     via letters scattered across the path).
 *   - Tier ranking: name-prefix > name-substring > name-subsequence >
 *     path-substring > path-subsequence. Within a tier: non-hidden before
 *     hidden, shallower before deeper, then locale order.
 *   - Both sides are NFC-normalized + lowercased (macOS stores NFD names;
 *     IME input is NFC — without this "café" never matches).
 *   - Results cap at SEARCH_MAX_RESULTS; `total` reports the real count.
 */

/** One searchable entry: a file/folder with its parent breadcrumb. */
export interface FileSearchEntry {
  name: string
  kind: 'file' | 'folder'
  /** POSIX path relative to the mount root — the mention block's `path`. */
  relPath: string
  /** Parent segments for display, mount name first: ['fapiao', 'amap-ride-invoices'] ("Amap ride
   *  receipts" — folder names may be non-ASCII; see dir-tree.test.ts). */
  crumb: string[]
  /** Sizes are stat'ed lazily for displayed hits only; null = unknown. */
  sizeBytes: number | null
  mountId: string
  mountName: string
}

/** A ranked search hit. Ranges are [start, end) char spans for highlight;
 *  a hit matched across crumb AND name renders without highlight (rare,
 *  not worth the index gymnastics). */
export interface FileSearchHit extends FileSearchEntry {
  tier: number
  nameRanges: Array<[number, number]>
  crumbRanges: Array<[number, number]>
}

export interface FileSearchResult {
  hits: FileSearchHit[]
  /** Real match count before the cap. */
  total: number
}

export const SEARCH_MAX_RESULTS = 50

function norm(s: string): string {
  return s.normalize('NFC').toLowerCase()
}

/** Greedy subsequence match; returns matched char positions or null. */
function subsequence(hay: string, needle: string): number[] | null {
  const positions: number[] = []
  let i = 0
  for (const ch of needle) {
    i = hay.indexOf(ch, i)
    if (i < 0) return null
    positions.push(i)
    i += 1
  }
  return positions
}

/** Merge adjacent positions into [start, end) ranges for <mark> rendering. */
function toRanges(positions: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const p of positions) {
    const last = ranges[ranges.length - 1]
    if (last && last[1] === p) {
      ranges[ranges.length - 1] = [last[0], p + 1]
    } else {
      ranges.push([p, p + 1])
    }
  }
  return ranges
}

/** Hidden = any dotted segment in the entry's own path (mount name excluded —
 *  mounting a dot-folder on purpose shouldn't demote its whole subtree). */
function isHiddenEntry(e: FileSearchEntry): boolean {
  return e.relPath.split('/').some((seg) => seg.startsWith('.'))
}

interface TierMatch {
  tier: number
  nameRanges: Array<[number, number]>
  crumbRanges: Array<[number, number]>
}

/** Classify one entry against the normalized query; null = no match. */
function matchEntry(e: FileSearchEntry, q: string): TierMatch | null {
  const name = norm(e.name)
  const crumbStr = norm(e.crumb.join('/'))
  // Tier 0/1: contiguous in name.
  const nameIdx = name.indexOf(q)
  if (nameIdx === 0) return { tier: 0, nameRanges: [[0, q.length]], crumbRanges: [] }
  if (nameIdx > 0) {
    return { tier: 1, nameRanges: [[nameIdx, nameIdx + q.length]], crumbRanges: [] }
  }
  // Tier 2: subsequence within the name alone.
  const namePos = subsequence(name, q)
  if (namePos) return { tier: 2, nameRanges: toRanges(namePos), crumbRanges: [] }
  // Tier 3/4: the full path (crumb + name). Highlight only when the match
  // stays inside the crumb; a span across crumb→name renders unhighlighted.
  const full = `${crumbStr}/${name}`
  const crumbIdx = crumbStr.indexOf(q)
  if (crumbIdx >= 0) {
    return { tier: 3, nameRanges: [], crumbRanges: [[crumbIdx, crumbIdx + q.length]] }
  }
  if (full.includes(q)) return { tier: 3, nameRanges: [], crumbRanges: [] }
  const crumbPos = subsequence(crumbStr, q)
  if (crumbPos) return { tier: 4, nameRanges: [], crumbRanges: toRanges(crumbPos) }
  if (subsequence(full, q)) return { tier: 4, nameRanges: [], crumbRanges: [] }
  return null
}

/**
 * Rank `entries` against `query`. Empty/whitespace query → no hits (the
 * caller renders browse mode instead).
 */
export function searchEntries(
  entries: FileSearchEntry[],
  query: string,
  limit: number = SEARCH_MAX_RESULTS,
): FileSearchResult {
  const q = norm(query.trim())
  if (q.length === 0) return { hits: [], total: 0 }

  const hits: FileSearchHit[] = []
  for (const e of entries) {
    const m = matchEntry(e, q)
    if (m) hits.push({ ...e, ...m })
  }
  hits.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    const aHidden = isHiddenEntry(a) ? 1 : 0
    const bHidden = isHiddenEntry(b) ? 1 : 0
    if (aHidden !== bHidden) return aHidden - bHidden
    if (a.crumb.length !== b.crumb.length) return a.crumb.length - b.crumb.length
    return a.name.localeCompare(b.name)
  })
  return { hits: hits.slice(0, limit), total: hits.length }
}
