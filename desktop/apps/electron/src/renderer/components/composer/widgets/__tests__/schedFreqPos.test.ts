/**
 * Tests for `computePopoverPos` — the sched-freq popover's placement.
 *
 * Two regressions correspond to real incidents:
 *   1. The first version always used `rect.bottom + 6`, but the chip lives in a composer fixed
 *      to the bottom, placing the entire popover outside the viewport.
 *   2. The second version flipped using measured offsetHeight and created a ResizeObserver loop:
 *      constrained height appeared to fit, removed maxHeight, grew again, and no longer fit.
 *      The function signature therefore **must not include height**; position depends only on
 *      the anchor and viewport, as the first assertion enforces.
 */
import { describe, it, expect } from 'bun:test'

import { computePopoverPos, POPOVER_WIDTH } from '../popoverPos'

/** Typical 1280 x 800 window. */
const VIEWPORT = { width: 1280, height: 800 }

describe('computePopoverPos', () => {
  it('is a pure function of anchor + viewport (no height input, no height output)', () => {
    // Structural loop guard: without a height input, constrain -> remeasure -> release cannot
    // form a feedback cycle. Adding popoverHeight back to the signature must fail this test.
    expect(computePopoverPos.length).toBe(2)
    const pos = computePopoverPos({ top: 100, bottom: 124, left: 300 }, VIEWPORT)
    expect(Object.keys(pos).sort()).toEqual(['left', 'maxHeight', 'top', 'width'])
  })

  it('opens downward when below is the roomier side', () => {
    // A chip near the top has ample space below, so downward placement follows reading order.
    const pos = computePopoverPos({ top: 100, bottom: 124, left: 300 }, VIEWPORT)
    expect(pos.top).toBe(130) // bottom + GAP
    expect(pos.bottom).toBeUndefined()
    expect(pos.left).toBe(300)
  })

  it('opens upward when the chip sits low — the original bug', () => {
    // Real layout: the composer is fixed at the bottom and the chip sits only tens of pixels above it.
    const chip = { top: 740, bottom: 764, left: 300 }
    const pos = computePopoverPos(chip, VIEWPORT)
    // A bottom anchor grows upward from the chip top without knowing popover height.
    expect(pos.bottom).toBe(VIEWPORT.height - chip.top + 6)
    expect(pos.top).toBeUndefined()
    // Available space must remain above the chip and within the viewport top.
    expect(pos.maxHeight).toBe(chip.top - 8 - 6)
  })

  it('never lets the popover overlap the anchor or leave the viewport', () => {
    // Sweep all vertical chip positions and keep the occupied interval inside the viewport without covering the chip.
    for (let top = 0; top <= VIEWPORT.height - 24; top += 8) {
      const chip = { top, bottom: top + 24, left: 0 }
      const pos = computePopoverPos(chip, VIEWPORT)
      if (pos.top !== undefined) {
        expect(pos.top).toBeGreaterThanOrEqual(chip.bottom)
        expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(VIEWPORT.height)
      } else {
        const bottomEdge = VIEWPORT.height - (pos.bottom ?? 0)
        expect(bottomEdge).toBeLessThanOrEqual(chip.top)
        expect(bottomEdge - pos.maxHeight).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('clamps left so a narrow window never yields a negative offset', () => {
    const narrow = { width: 360, height: 800 }
    expect(computePopoverPos({ top: 100, bottom: 124, left: 300 }, narrow).left).toBe(8)
  })

  it('clamps left to the right edge when the chip sits far right', () => {
    const pos = computePopoverPos({ top: 100, bottom: 124, left: 1200 }, VIEWPORT)
    expect(pos.left).toBe(VIEWPORT.width - POPOVER_WIDTH - 8)
  })

  // The embedded Browser is an Electron WebContentsView composited above the page:
  // anything the popover puts past its left edge is not dimmed or clipped, it is
  // simply invisible. `rightLimit` is that edge.
  it('stops at the native Browser surface instead of sliding under it', () => {
    const withBrowser = { width: 1280, height: 800, rightLimit: 900 }
    const pos = computePopoverPos({ top: 100, bottom: 124, left: 700 }, withBrowser)
    expect(pos.width).toBe(POPOVER_WIDTH)
    expect(pos.left + pos.width).toBeLessThanOrEqual(withBrowser.rightLimit)
  })

  it('narrows rather than hiding when the free column cannot fit the full width', () => {
    // Reachable on an ordinary window: dragging the browser dock to its widest
    // leaves the centre column under 420px. The picker's fields already wrap, so
    // a narrower popover degrades gracefully — sliding under the browser does not.
    const squeezed = { width: 1280, height: 800, rightLimit: 300 }
    const pos = computePopoverPos({ top: 100, bottom: 124, left: 120 }, squeezed)
    expect(pos.width).toBeLessThan(POPOVER_WIDTH)
    expect(pos.left).toBeGreaterThanOrEqual(8)
    expect(pos.left + pos.width).toBeLessThanOrEqual(squeezed.rightLimit)
  })

  it('falls back to the viewport when no native surface is on screen', () => {
    const pos = computePopoverPos({ top: 100, bottom: 124, left: 1200 }, VIEWPORT)
    expect(pos.width).toBe(POPOVER_WIDTH)
    expect(pos.left + pos.width).toBeLessThanOrEqual(VIEWPORT.width)
  })

  it('never returns a negative maxHeight in a degenerate viewport', () => {
    // When the window is shorter than reserved spacing, clamp to zero. Browsers ignore negative
    // maxHeight, effectively removing the limit and letting the popover fill the screen again.
    const tiny = { width: 1280, height: 10 }
    const pos = computePopoverPos({ top: 4, bottom: 8, left: 0 }, tiny)
    expect(pos.maxHeight).toBeGreaterThanOrEqual(0)
  })
})
