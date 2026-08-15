/**
 * Writes the geometry actually occupied by the Windows caption buttons
 * (minimize/maximize/close) into two CSS variables:
 *   - `--titlebar-win-inset`     horizontal width, so elements hugging the window's
 *                                top-right corner get out of the way
 *   - `--titlebar-win-inset-top` vertical height, so the fullscreen overlay starts
 *                                painting from the caption's bottom edge
 *
 * Why the JS API rather than CSS `env(titlebar-area-*)`: what that group of env
 * variables reports while the overlay is **invisible** (fullscreen etc.) is a
 * platform detail — if it is reported as `0px`,
 * `calc(100vw - 0px - 0px)` computes a 100vw padding and the whole TopBar's content
 * gets squeezed out of existence; if the definition is withdrawn instead, we fall
 * back to a hardcoded value and leave a dead strip of whitespace in fullscreen. Both
 * would be guesswork. `navigator.windowControlsOverlay` has an explicit `visible`
 * boolean, which distinguishes "there is no overlay" from "the overlay's width is 0"
 * outright — no need to gamble.
 *
 * Why the vertical variable exists: the three WCO buttons are drawn by the **system**
 * and composited on top of the WebContents picture, so z-index has no effect on them
 * — a fullscreen overlay (Modal / RunLogDrawer) can't cover that area, leaving an
 * isolated un-dimmed rectangle in the top-right corner. Have the overlay start
 * painting from the caption's bottom edge and the seam disappears.
 *
 * Invariants:
 *   - Non-Windows / overlay not enabled (API absent) → both variables keep the 0px
 *     from the CSS, so for every consumer it's as if this padding / this getting-out-
 *     of-the-way had never been written.
 *   - `visible === false` (fullscreen) → both are 0px. In fullscreen the system draws
 *     no caption buttons, so reserving space would just waste a strip and the overlay
 *     should cover everything.
 *   - The unit is **CSS px**: what `getTitlebarAreaRect()` returns has already been
 *     converted for the webContents zoom, so no extra handling is needed when the
 *     user changes the zoom — which is also why the vertical value takes
 *     `rect.height` instead of hardcoding 44px: it shares a source with the height
 *     the main process's `overlayHeightFor(zoomLevel)` actually draws, so zoom / DPI
 *     changes are followed automatically.
 *
 * Non-obvious dep: what gets written is the inline style of
 * `document.documentElement`, which overrides the `:root` defaults in `index.css` —
 * consumers (TopBar / RunLogDrawer / Modal) only read the variables and don't care
 * who wrote them.
 */
import { useEffect } from 'react'

/** The minimal WCO interface — lib.dom doesn't include it yet, so the part we need
 *  is hand-written here following the spec. */
interface WindowControlsOverlayLike {
  visible: boolean
  getTitlebarAreaRect: () => DOMRect
  addEventListener: (type: 'geometrychange', listener: () => void) => void
  removeEventListener: (type: 'geometrychange', listener: () => void) => void
}

const CSS_VAR = '--titlebar-win-inset'
const CSS_VAR_TOP = '--titlebar-win-inset-top'
const CSS_VAR_HEIGHT = '--titlebar-height'

/**
 * Fallback value for the top bar height (CSS px) — must equal `TITLEBAR_HEIGHT` in
 * `main/titlebar-metrics.ts`, which `titlebar-metrics.test.ts` locks down.
 *
 * Used in the two scenarios where the overlay can't be measured: non-Windows
 * platforms, and fullscreen (the system puts the caption buttons away,
 * `visible === false`).
 */
const FALLBACK_TITLEBAR_HEIGHT = 44

/**
 * The top chrome band's height in CSS px — the TopBar, which also hosts the native
 * window buttons (macOS traffic lights / the Windows caption strip).
 *
 * For overlays positioned **in JS** (`position: fixed` with a computed `top`), which
 * cannot express `var(--titlebar-height)` the way the CSS consumers do. Reading the
 * variable rather than re-hardcoding 44 keeps the single source of truth: on Windows
 * `useWindowControlsInset` overwrites it with the height the system actually draws.
 *
 * Drawing into this band is not a z-index question — the native buttons are composited
 * above the WebContents, and the band is the window's drag region, which an overlay on
 * top of it silently makes undraggable.
 */
export function readTitlebarHeight(): number {
  if (typeof document === 'undefined') return FALLBACK_TITLEBAR_HEIGHT
  const raw = getComputedStyle(document.documentElement).getPropertyValue(CSS_VAR_HEIGHT)
  const px = Number.parseFloat(raw)
  return Number.isFinite(px) ? px : FALLBACK_TITLEBAR_HEIGHT
}

function readOverlay(): WindowControlsOverlayLike | null {
  const wco = (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlayLike })
    .windowControlsOverlay
  return wco ?? null
}

/**
 * Computes the width on the right taken up by the caption buttons (CSS px).
 *
 * `getTitlebarAreaRect()` gives the title bar area **left to the web page**; when the
 * buttons are on the right, `x = 0` and `width = window width - button width`, so
 * button width = window width - x - width. `x` is folded into the formula to stay
 * compatible with systems that put the buttons on the left (some Linux desktops); in
 * that case nothing on the right needs to get out of the way and the result is
 * naturally 0.
 */
function insetFrom(wco: WindowControlsOverlayLike): number {
  if (!wco.visible) return 0
  const rect = wco.getTitlebarAreaRect()
  const right = window.innerWidth - rect.x - rect.width
  if (!Number.isFinite(right) || right <= 0) return 0
  // Clamping the upper bound is just as necessary: a transitional state where
  // `visible === true` but the rect is still 0×0 (right after the overlay was set,
  // maximize/restore, a DPI switch) computes `right === innerWidth` — which is
  // exactly the whole bar's content being squeezed out by padding, the very failure
  // mode this file's header claims to avoid. However wide the caption buttons get,
  // they can never take up half the window.
  return Math.min(right, window.innerWidth / 2)
}

/**
 * The height of the caption button strip (CSS px) — i.e. the vertical extent the
 * system actually paints the overlay over.
 *
 * Unlike the horizontal value it needs no clamping: the worst transitional state of
 * `rect.height` is 0 (the overlay covers everything, which equals the behavior before
 * this change), so the "computes half the window" failure mode doesn't exist.
 */
function topInsetFrom(wco: WindowControlsOverlayLike): number {
  if (!wco.visible) return 0
  const { height } = wco.getTitlebarAreaRect()
  return Number.isFinite(height) && height > 0 ? height : 0
}

/** Subscribes to WCO geometry changes and maintains the two `--titlebar-win-inset*`.
 *  Call once at the App root. */
export function useWindowControlsInset(): void {
  useEffect(() => {
    const wco = readOverlay()
    if (!wco) return
    const root = document.documentElement
    const sync = () => {
      const top = topInsetFrom(wco)
      root.style.setProperty(CSS_VAR, `${insetFrom(wco)}px`)
      root.style.setProperty(CSS_VAR_TOP, `${top}px`)
      // Note that these two variables are **deliberately different** in fullscreen:
      // when the overlay is put away the mask must cover everything (top=0), but the
      // top bar itself is still there and still needs a height, so this falls back to
      // the fallback value instead of also taking 0.
      root.style.setProperty(CSS_VAR_HEIGHT, `${top || FALLBACK_TITLEBAR_HEIGHT}px`)
    }
    sync()
    wco.addEventListener('geometrychange', sync)
    // geometrychange only fires when the overlay's own geometry changes; on a
    // horizontal window resize rect.width changes along with it but the button width
    // doesn't — we still subscribe to resize to cover implementation differences.
    window.addEventListener('resize', sync)
    return () => {
      wco.removeEventListener('geometrychange', sync)
      window.removeEventListener('resize', sync)
      root.style.removeProperty(CSS_VAR)
      root.style.removeProperty(CSS_VAR_TOP)
      root.style.removeProperty(CSS_VAR_HEIGHT)
    }
  }, [])
}
