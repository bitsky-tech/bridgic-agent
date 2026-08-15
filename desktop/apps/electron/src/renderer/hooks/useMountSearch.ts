/**
 * Searches files under the current session's mount roots — the search backend of the right
 * panel's session output.
 *
 * Reuses the very chain behind the `@` reference popover (`window.api.fs.searchDir`): the main
 * process walks names-only, with a time budget, and returns at most 50 hits — the whole tree
 * never crosses IPC. Do **NOT** change this to filter `mountTreeFamily` in the renderer —
 * subdirectories are lazy-loaded, so the renderer only holds the few levels the user has
 * already expanded, and results would then depend on "where you happened to click earlier",
 * which amounts to not searching at all.
 *
 * Invariants:
 *   - `query` empty after trimming → no request is sent, an empty result + `isSearching:false`
 *     is returned (the caller should render the browse tree at that point, not "not found").
 *   - A late response never overwrites a newer one (seq guard). `useDebouncedEffect` debounces
 *     the **trigger** only, it does not track in-flight results — without this guard, deleting
 *     characters quickly flashes the previous query's hits back.
 *   - **`isSearching` MUST be true on the very frame a key is pressed**, not set only once the
 *     debounce fires. `result` still belongs to the previous query (or is empty), and reporting
 *     `searching:false` there makes the caller render "not found" out of
 *     "empty hits + not searching" — a fake 120ms empty state on every single keystroke.
 *     Hence it is derived from "the query of the settled result ≠ the current query", not its own state.
 */
import { useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import type { SearchDirResult } from '@shared/dir-tree'
import type { FileSearchHit } from '@shared/file-search'
import { rlog } from '@/lib/logger'
import { useDebouncedEffect } from '@/hooks/useDebouncedEffect'
import { mountsFamily } from '@/atoms/mounts'

/** Same value as the `@` popover: per-keystroke queries are coalesced before hitting IPC. */
const SEARCH_DEBOUNCE_MS = 120

/**
 * Empty-result singleton.
 *
 * §1.32: reset constants shared by several components are always `Object.freeze`d. This one is
 * handed back on every "no result" return, so if some consumer did `hits.push(...)` /
 * `result.total = n`, what it corrupts is **every subsequent render** — without throwing at
 * runtime, which is exactly the kind of silent damage freeze exists for.
 * `hits` is frozen separately: freezing the outer object does not stop pushes into the array.
 */
// The assertion is unavoidable: `SearchDirResult.hits` is declared as a **mutable** array (it
// describes the real IPC response), whereas what we want here is a runtime-frozen empty
// singleton. The freeze is real; only the readonly is erased at the type level.
const NO_HITS = Object.freeze([]) as readonly FileSearchHit[] as FileSearchHit[]

const EMPTY: SearchDirResult = Object.freeze({ hits: NO_HITS, total: 0, partial: false })

/** The complete "not searching" state. Reused as the default prop of `SessionAssetsPanel` to
 *  avoid the two files each writing their own empty object (missing one of them when a field
 *  changes would silently diverge). */
export const EMPTY_MOUNT_SEARCH: MountSearchState = Object.freeze({
  ...EMPTY,
  isSearching: false,
})

export interface MountSearchState extends SearchDirResult {
  /** A query is in flight (including the debounce window that hasn't fired yet). Always false for an empty query. */
  isSearching: boolean
}

/** The settled result + the query string it corresponds to. Both are written in one setState, so they can't drift apart. */
interface Settled {
  query: string
  result: SearchDirResult
}

const IDLE: Settled = Object.freeze({ query: '', result: EMPTY })

/**
 * Debounced search over the current session's mount tree.
 *
 * @param query the raw query string typed by the user (trimmed internally)
 * @param sessionId the current session; when null there are no mounts to search
 */
export function useMountSearch(query: string, sessionId: string | null): MountSearchState {
  const mounts = useAtomValue(mountsFamily(sessionId ?? ''))
  const [settled, setSettled] = useState<Settled>(IDLE)
  const seqRef = useRef(0)
  const q = query.trim()
  // No existing mount = no root to walk, so `searchDir({roots: []})` is bound to come back
  // empty — not even worth an IPC round trip. This step also keeps `isSearching` from lighting
  // up for a query that is doomed to be empty.
  const isSearchable = mounts.some((m) => m.exists)

  useDebouncedEffect(
    () => {
      if (q.length === 0 || !isSearchable) {
        // Invalidate the in-flight request: otherwise, when it returns, it would refill hits
        // into a UI whose search box has already been cleared.
        seqRef.current += 1
        setSettled(IDLE)
        return
      }
      const seq = (seqRef.current += 1)
      const roots = mounts
        .filter((m) => m.exists)
        .map((m) => ({ mountId: m.id, mountName: m.name, absPath: m.path }))
      window.api.fs
        .searchDir({ roots, query: q })
        .then((res) => {
          if (seqRef.current !== seq) return
          setSettled({ query: q, result: res })
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return
          rlog.warn('[right-panel] searchDir failed', err)
          // Mark the query settled on failure too, otherwise isSearching stays true forever and it spins endlessly.
          setSettled({ query: q, result: EMPTY })
        })
    },
    [q, mounts, isSearchable],
    SEARCH_DEBOUNCE_MS,
  )

  // Derived rather than its own state: on the very frame a key is pressed settled.query is
  // already ≠ q, so isSearching turns true at once and the caller won't render "not found" (not
  // found) out of a stale empty result.
  // `isSearchable` is included: in the no-request case settled.query never catches up to q, and
  // omitting this condition would leave it stuck on "searching…" forever.
  const isSearching = isSearchable && q.length > 0 && settled.query !== q
  // Same reasoning: don't expose stale hits when the result doesn't match the current query (you'd see the previous term's results flash).
  const result = isSearching ? EMPTY : settled.result
  return { ...result, isSearching }
}
