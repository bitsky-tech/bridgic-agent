/**
 * Pure function: correct persisted window bounds into the currently connected
 * displays.
 *
 * Why: if the bounds came from a display that has since been disconnected (or
 * are larger than the current screen), handing them straight to BrowserWindow
 * makes the OS clamp them to fill the work area, and `win.isMaximized()`
 * misreads that "filled" state as the user having maximized and persists
 * `maximized:true` — the next launch then calls `win.maximize()` on that
 * basis, forming a self-sustaining "fills the screen every time" loop (see the
 * close-time persistence logic in window-manager.ts). Correcting up front at
 * the entry point eliminates the loop at its root.
 *
 * Pure logic (does not import electron) so it can be unit-tested with
 * bun:test — the real display query via electron's `screen` stays in
 * window-manager.ts and is passed in (§H: never import electron inside
 * bun:test).
 */
import type { WindowBounds } from '@app/shared/types'

/** A rectangle (shared by window bounds and display workArea). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Leave a small margin against the work area after clamping, so we never exactly fill it → misread by isMaximized() as maximized. */
const FILL_MARGIN = 24

/** Intersection area of two rectangles (0 when they don't intersect). */
export function intersectionArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Fit bounds inside a work area, keeping them strictly smaller than it (reserving FILL_MARGIN). */
function clampToWorkArea(b: WindowBounds, wa: Rect): WindowBounds {
  const width = Math.min(b.width, wa.width - FILL_MARGIN)
  const height = Math.min(b.height, wa.height - FILL_MARGIN)
  const x = Math.min(Math.max(b.x, wa.x), wa.x + wa.width - width)
  const y = Math.min(Math.max(b.y, wa.y), wa.y + wa.height - height)
  return { x, y, width, height }
}

/**
 * Given the persisted bounds and the workAreas of every connected display,
 * compute the bounds to actually open the window with.
 *
 * @returns `bounds` = the rectangle actually used; `adjusted` = whether the
 *   persisted bounds were stale (off-screen or overflowing the work area).
 *   When `adjusted` is true the caller **must discard** a persisted
 *   `maximized:true` — that was recorded from an OS-fill misread, not from the
 *   user actually maximizing.
 */
export function pickStartupBounds(
  saved: WindowBounds | undefined,
  workAreas: Rect[],
  fallback: WindowBounds,
): { bounds: WindowBounds; adjusted: boolean } {
  if (!saved || workAreas.length === 0) return { bounds: fallback, adjusted: true }

  // Pick the display with the largest overlap area against the persisted bounds.
  let best: Rect | null = null
  let bestArea = 0
  for (const wa of workAreas) {
    const area = intersectionArea(saved, wa)
    if (area > bestArea) {
      bestArea = area
      best = wa
    }
  }
  if (!best) return { bounds: fallback, adjusted: true } // the whole window is outside every display

  const bounds = clampToWorkArea(saved, best)
  const adjusted =
    bounds.x !== saved.x ||
    bounds.y !== saved.y ||
    bounds.width !== saved.width ||
    bounds.height !== saved.height
  return { bounds, adjusted }
}
