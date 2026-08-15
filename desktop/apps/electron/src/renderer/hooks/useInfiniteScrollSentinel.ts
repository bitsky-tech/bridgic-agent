/**
 * Observe a sentinel element and fire a callback whenever it scrolls into
 * view — the "load more" trigger behind DOM-windowed lists.
 *
 * Contract:
 *   - `enabled=false` mounts NO IntersectionObserver and detaches any live
 *     one (pass `hasMore` here — when everything is visible the sentinel is
 *     gone and observing would be dead weight).
 *   - `onReachEnd` is read from a ref at fire time (same latest-closure
 *     pattern as `useDebouncedEffect`), so the observer is created/torn down
 *     only when `enabled` flips — not on every parent render.
 *   - The returned ref must be attached to a rendered element while
 *     `enabled` is true; a null ref is a silent no-op.
 *
 * Extracted from FileTreeView's WindowedLevel (§1.27 — 2nd consumer arrived
 * with the list-windowing work). Kept callback-shaped rather than
 * count-shaped so consumers own their "what does more mean" semantics
 * (append a chunk, fetch a page, …).
 */
import { useEffect, useRef, type RefObject } from 'react'

export function useInfiniteScrollSentinel(
  onReachEnd: () => void,
  enabled: boolean,
): RefObject<HTMLDivElement> {
  const sentinelRef = useRef<HTMLDivElement>(null)

  // Latest closure without re-arming the observer — written in an effect,
  // not during render (react-hooks lint forbids render-phase ref writes).
  const onReachEndRef = useRef(onReachEnd)
  useEffect(() => {
    onReachEndRef.current = onReachEnd
  })

  useEffect(() => {
    const el = sentinelRef.current
    if (!el || !enabled) return
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onReachEndRef.current()
    })
    io.observe(el)
    return () => io.disconnect()
  }, [enabled])

  return sentinelRef
}
