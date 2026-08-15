/**
 * Size arithmetic for the Windows Control Overlay — the pure logic extracted
 * out of `titlebar-overlay.ts`.
 *
 * It is a separate file purely for testability: `titlebar-overlay.ts` imports
 * `electron`, and bun:test can't load Electron's module exports (the same
 * split as `logged-handle.ts` / `sanitize.ts`). This file does not import
 * electron.
 *
 * Invariant: `overlayHeightFor(level)` must equal the DIP height the TopBar
 * **actually renders at** under that zoom. The TopBar is 44 CSS px, while the
 * overlay is measured in DIP and does not follow the webContents zoom — the
 * two only stay aligned if both use the same zoom base (1.2^level, the same
 * source as `zoomPercent()`).
 */

import { clampZoomLevel } from '@app/shared/types'

/** The TopBar's CSS height — must equal the `h-11` (44px) on `TopBar.tsx`'s root node. */
export const TITLEBAR_HEIGHT = 44

/**
 * The grid the DIP height must land on — see the rounding rationale in
 * `overlayHeightFor`.
 *
 * 4 rather than 2: 150% only requires divisibility by 2, but 125% (5/4) and
 * 175% (7/4) require divisibility by 4 for the height to land on whole
 * physical pixels under all three of these common Windows scale factors.
 */
const DIP_GRID = 4

/**
 * The DIP height the TopBar actually occupies on screen, **aligned to a
 * multiple of 4**.
 *
 * `webContents.setZoomLevel(n)` scales web content by `1.2 ** n` (Chromium's
 * convention, the same algorithm as `zoomPercent()`), so a 44 CSS px TopBar
 * renders as `44 × factor` DIP. The overlay is drawn by the system **outside**
 * the web contents and is measured in DIP, so without multiplying by that
 * factor: when zoomed out the buttons are taller than the top bar and smear
 * into the content area; when zoomed in the top bar is taller than the buttons
 * and the hover highlight only covers the upper half.
 *
 * Why also align to a grid: `titleBarOverlay.height` only accepts integer DIP,
 * while Windows commonly runs at 125%/150%/175% system scaling. An odd DIP
 * value lands on half a physical pixel at 150% (e.g. 53 → 79.5px) and gets
 * force-snapped, so the geometry `getTitlebarAreaRect()` reports to the
 * renderer no longer matches the CSS — showing up as the white strip in the
 * top-right corner being noticeably taller than the top bar on the left when a
 * modal overlay is up, plus a "the right side changes first, the left side
 * after" split as soon as you press a zoom key. In the original implementation
 * 5 of the 7 steps were odd (31/37/53/63/91).
 *
 * The cost: after alignment a step deviates from the exact value by at most
 * 2px. That's acceptable — the renderer's top-bar height now follows
 * `getTitlebarAreaRect()` (see `renderer/hooks/useWindowControlsInset.ts`),
 * taking the geometry the system actually draws as the source of truth, so the
 * deviation no longer has any visible consequence.
 */
export function overlayHeightFor(zoomLevel: number): number {
  const exact = TITLEBAR_HEIGHT * 1.2 ** clampZoomLevel(zoomLevel)
  return Math.round(exact / DIP_GRID) * DIP_GRID
}
