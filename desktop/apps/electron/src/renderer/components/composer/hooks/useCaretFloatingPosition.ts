/**
 * Compute floating menu position from caret rect.
 *
 * The returned style is passed straight to the menu's root <div style={...}>.
 * Boundaries: the menu is kept inside the viewport horizontally, below the top chrome band
 * (`topInset`) vertically, and flips to whichever side of the caret it actually fits on.
 *
 * Note: despite the `use*` prefix, this is a **pure function** — no React
 * state/effects. It is named as a hook for callsite consistency with the
 * other composer hooks.
 */
export interface CaretFloatingStyle {
  position: 'fixed'
  left: number
  bottom?: number
  top?: number
}

/** Defaults = the slash menu's own box (`w-[300px] max-h-[280px]` in SlashMenu.tsx). */
const MENU_HEIGHT = 280
const MENU_WIDTH = 300

/** Distance kept between the caret and the menu, and between the menu and the viewport edges. */
const GAP = 8

/** The menu's own box, plus the band it must stay out of. Every field has a default so a
 *  caller rendering the slash menu can pass nothing at all. */
export interface CaretMenuBox {
  /** The menu's actual width. The mention popover (440px, to fit resource details) is wider than
   *  the slash menu, and clamp must use the real width or the right edge overflows the viewport. */
  width?: number
  /** Same for the height: the flip decision is only as good as this number. Underestimating it
   *  ("prefer upwards" wins on a caret that only *looks* like it has room) anchors the menu's
   *  bottom above the caret and lets its top run off the top of the window — where it cannot be
   *  scrolled back, because the menu is position:fixed. */
  height?: number
  /** Height of the app chrome at the top of the window (`readTitlebarHeight()`). The menu must
   *  stay below it: that band holds the native window buttons and is the window's drag region,
   *  so a menu drawn over it is both visually wrong and silently steals the drag area. Default 0
   *  = no reserved band. */
  topInset?: number
}

export function useCaretFloatingPosition(
  rect: DOMRect | null,
  { width = MENU_WIDTH, height = MENU_HEIGHT, topInset = 0 }: CaretMenuBox = {},
): CaretFloatingStyle | null {
  if (!rect) return null
  const vw = typeof window === 'undefined' ? 1280 : window.innerWidth
  const vh = typeof window === 'undefined' ? 800 : window.innerHeight

  // Horizontal clamp
  const left = Math.max(GAP, Math.min(vw - width - GAP, rect.left - 10))

  // The anchor itself can scroll out of the usable area — the home page's composer lives in a
  // scroll box, so the caret disappears behind the top chrome or past the bottom edge. The menu
  // goes with it (null = render nothing): pinning it to an edge would leave a 440px popover
  // floating over content it is no longer anchored to. The caller also stops routing keys to a
  // menu it is not rendering, so Enter goes back to sending the message.
  if (rect.bottom <= topInset || rect.top >= vh) return null

  // The topmost pixel the menu may occupy. The downwards anchor needs no clamping against it:
  // the guard above leaves rect.bottom > topInset, so `rect.bottom + GAP` is already below.
  const minTop = topInset + GAP
  const belowTop = rect.bottom + GAP
  const spaceAbove = rect.top - minTop
  const spaceBelow = vh - rect.bottom
  // Prefer floating upwards (the menu's bottom sits GAP above the caret's top) — the composer
  // usually sits at the bottom of the window, where upwards is the only side with room.
  if (spaceAbove >= height + GAP) {
    return { position: 'fixed', left, bottom: vh - rect.top + GAP }
  }
  // Then downwards — this is what the home page takes, where the composer is vertically centred.
  if (spaceBelow >= height + GAP) {
    return { position: 'fixed', left, top: belowTop }
  }
  // Neither side fits (short window / zoomed in): take the roomier one, and when that is upwards
  // pin the menu to the top of the usable area instead of anchoring it to the caret. It then
  // covers the caret, which is recoverable — a menu that overflows off-screen is not.
  return {
    position: 'fixed',
    left,
    top: spaceAbove >= spaceBelow ? minTop : belowTop,
  }
}
