/**
 * Fixed-positioning math for inline widget popovers — opens on whichever side of the anchor has more room.
 *
 * Kept as its own module (rather than living in SchedFreqWidget.tsx) so it can be tested: a pure
 * function that never touches the DOM runs directly under bun:test, whereas importing from the
 * component file would drag in atoms → `window` and blow up in a test environment with no DOM.
 * Same split as the existing `segments.ts` / `matchesFilter.ts`.
 *
 * Invariant: the returned style depends **only on the anchor rect and the viewport**, never on the
 * popover's own height. Opening upward anchors with CSS `bottom` (the box grows upward from a fixed
 * bottom edge), opening downward uses `top`; both directions clamp that side's headroom with
 * `maxHeight`. Taller content therefore only scrolls inside maxHeight and **can never feed back into
 * the positioning**.
 *
 * An earlier version switched to "measure offsetHeight, then decide which way to flip", which
 * deadlocked: measure the clamped height → decide "now it fits" → drop the clamp → the box grows back
 * → it no longer fits. Together with a ResizeObserver that oscillates every frame. Height must never
 * be both an input and an output.
 *
 * Mechanically aligned with `permissions/ComposerModePill.tsx :: computeMenuPlacement` (the existing
 * solution to the same problem). The two are not merged into one shared helper yet: that one
 * right-aligns to the trigger and lets content drive the width; this one left-aligns at a fixed 420.
 * Merging would first require unifying the alignment axis, which is a separate change.
 */

/** Popover width when there is room for it; narrower when the free column cannot fit it. */
export const POPOVER_WIDTH = 420
/** Breathing gap between the anchor and the popover. */
export const POPOVER_GAP = 6
/** Minimum padding between the popover and the viewport edge. */
export const VIEWPORT_MARGIN = 8

/** Viewport coordinates of the anchor element (the subset of `getBoundingClientRect()` we need). */
export interface PopoverAnchor {
  top: number
  bottom: number
  left: number
}

/** Viewport size (`window.innerWidth/innerHeight`), plus how far right the renderer may paint. */
export interface Viewport {
  width: number
  height: number
  /**
   * Right-most x this popover may occupy; defaults to `width`.
   *
   * The embedded Browser is an Electron `WebContentsView` composited ABOVE the
   * page, so anything placed past its left edge is not dimmed or clipped — it is
   * invisible. Callers pass that edge here (see `lib/overlayBounds.ts`).
   */
  rightLimit?: number
}

/**
 * Positioning result, ready to spread straight into `style`.
 *
 * **Exactly one** of `top` / `bottom` is a number: `top` when opening downward, `bottom` when opening
 * upward (upward must anchor via bottom, otherwise the height would have to be known first — see the
 * infinite loop in the file header).
 */
export interface PopoverPos {
  left: number
  /** `POPOVER_WIDTH`, or narrower when that is all the free column can hold. */
  width: number
  top?: number
  bottom?: number
  /** Headroom on that side; content that overflows scrolls inside the popover. */
  maxHeight: number
}

/**
 * Compute the popover's fixed position for an anchor.
 *
 * It picks the "roomier" side rather than "prefer downward, flip when it doesn't fit": the latter
 * needs the popover height to judge whether it fits, and that height depends on the positioning
 * (maxHeight) — a circular dependency. This widget's chip lives inside the composer, which is pinned
 * to the bottom of the window, so there is always more room above and the observed behaviour is a
 * stable upward popover — exactly what we want. Same trade-off as ComposerModePill.
 *
 * @param anchor viewport coordinates of the anchor
 * @param viewport current viewport size
 */
export function computePopoverPos(anchor: PopoverAnchor, viewport: Viewport): PopoverPos {
  const rightLimit = Math.min(viewport.rightLimit ?? viewport.width, viewport.width)
  // Narrow before overflowing: the picker's fields already wrap, so a shorter
  // popover stays usable, whereas the overflowing part would be swallowed whole
  // by the native Browser surface (or run off the window).
  const width = Math.max(0, Math.min(POPOVER_WIDTH, rightLimit - VIEWPORT_MARGIN * 2))
  // Horizontal: never hand back a negative left offset (or one smaller than the margin), even when the window is narrower than the popover.
  const left = Math.max(
    VIEWPORT_MARGIN,
    Math.min(anchor.left, rightLimit - width - VIEWPORT_MARGIN),
  )
  const spaceAbove = anchor.top - VIEWPORT_MARGIN
  const spaceBelow = viewport.height - anchor.bottom - VIEWPORT_MARGIN
  if (spaceAbove >= spaceBelow) {
    return {
      left,
      width,
      // Grow upward from the anchor's top edge — use bottom rather than top so no measuring is needed.
      bottom: viewport.height - anchor.top + POPOVER_GAP,
      maxHeight: Math.max(0, spaceAbove - POPOVER_GAP),
    }
  }
  return {
    left,
    width,
    top: anchor.bottom + POPOVER_GAP,
    maxHeight: Math.max(0, spaceBelow - POPOVER_GAP),
  }
}
