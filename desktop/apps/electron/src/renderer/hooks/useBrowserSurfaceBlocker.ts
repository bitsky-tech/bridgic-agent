/**
 * Hold one native-Browser-surface blocker for as long as a component needs it.
 *
 * The embedded Browser is an Electron `WebContentsView` added to the window's
 * `contentView`, so the OS composites it ABOVE this page: no `z-index` can put
 * renderer UI in front of it. The only way an overlay becomes visible over the
 * Browser canvas is for the native view to hide first, which is what
 * `useEmbeddedBrowserSurfaceEligible` decides from these blockers.
 *
 * Every `source` is independent, so stacked overlays cannot release each
 * other's blocker — pass a per-instance id (`useId()`) when a component can be
 * mounted more than once at a time.
 *
 * `useLayoutEffect`, not `useEffect`: the request has to be queued in the same
 * commit that paints the overlay, otherwise the overlay's first frame is drawn
 * underneath the native view.
 */
import { useLayoutEffect } from 'react'
import { useSetAtom } from 'jotai'
import { setBrowserSurfaceBlockerAtom } from '@/atoms/browser'

/** Block the native Browser surface under `source` while `blocked` holds. */
export function useBrowserSurfaceBlocker(source: string, blocked: boolean): void {
  const setBlocker = useSetAtom(setBrowserSurfaceBlockerAtom)
  useLayoutEffect(() => {
    setBlocker({ source, blocked })
    return () => setBlocker({ source, blocked: false })
  }, [source, blocked, setBlocker])
}
