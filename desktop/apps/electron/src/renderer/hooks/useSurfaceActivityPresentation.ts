import { useEffect, useState } from 'react'

export const SURFACE_ACTIVITY_SETTLE_MS = 400
export type SurfaceActivityKind = 'agent' | 'loading' | null

/** Keep a completed activity legible briefly without extending its actual execution state. */
export function useSurfaceActivityPresentation(liveKind: SurfaceActivityKind): SurfaceActivityKind {
  const [visibleKind, setVisibleKind] = useState<SurfaceActivityKind>(liveKind)

  useEffect(() => {
    if (liveKind !== null) {
      if (visibleKind !== liveKind) {
        // This state controls presentation dwell only; the caller owns execution state.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setVisibleKind(liveKind)
      }
      return
    }
    if (visibleKind === null) return
    const timer = window.setTimeout(() => setVisibleKind(null), SURFACE_ACTIVITY_SETTLE_MS)
    return () => window.clearTimeout(timer)
  }, [liveKind, visibleKind])

  return visibleKind
}
