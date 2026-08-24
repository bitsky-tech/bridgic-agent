/**
 * How far right a renderer-drawn overlay can go and still be seen.
 *
 * The embedded Browser is an Electron `WebContentsView` composited ABOVE this
 * page. Whatever an overlay puts inside its rectangle is not dimmed or clipped —
 * it is invisible, with no hint that anything is missing.
 *
 * Two answers to that, and which one is right depends on the overlay:
 *
 *   - **A dialog blocks the surface** (`useBrowserSurfaceBlocker`). It already
 *     dims the whole window, so the browser being gone reads as intended.
 *   - **A corner card or a dropdown steps aside** — this hook. Blanking a whole
 *     web page to make room for a 380px card reads as a bug, not a decision, and
 *     the card can sit there for as long as the user ignores it.
 *
 * Live, not measured once: the browser can appear while the overlay is already
 * up (an agent opening a tab mid-task), and an overlay pinned at open time would
 * quietly sink underneath it.
 */
import { useAtomValue } from 'jotai'
import { nativeSurfaceRectAtom } from '@/atoms/browser'

/** Right-most x an overlay may occupy: the native surface's left edge, else the window's. */
export function useOverlayRightLimit(): number {
  const surface = useAtomValue(nativeSurfaceRectAtom)
  if (!surface || surface.width <= 0 || surface.height <= 0) return window.innerWidth
  return Math.max(0, Math.min(surface.x, window.innerWidth))
}
