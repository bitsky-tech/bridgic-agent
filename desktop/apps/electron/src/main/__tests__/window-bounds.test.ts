/**
 * Tests for window-bounds.ts — saved-bounds validation against connected
 * displays. Reproduces the real "always opens maximized" bug: bounds saved on
 * a since-disconnected external monitor → off all current displays → adjusted
 * (so the caller drops the stale maximized flag).
 */
import { describe, it, expect } from 'bun:test'
import { intersectionArea, pickStartupBounds, type Rect } from '../window-bounds'

const DEFAULT: Rect = { x: 100, y: 100, width: 1280, height: 800 }
const PRIMARY: Rect = { x: 0, y: 0, width: 1440, height: 900 }

describe('intersectionArea', () => {
  it('is 0 for disjoint rects, positive for overlap', () => {
    expect(intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 })).toBe(0)
    expect(intersectionArea({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(25)
  })
})

describe('pickStartupBounds', () => {
  it('keeps fully on-screen bounds untouched (adjusted=false → honor maximized)', () => {
    // Fits inside PRIMARY (1440×900) with margin: right=1320<1440, bottom=820<900.
    const saved = { x: 120, y: 60, width: 1200, height: 760 }
    const { bounds, adjusted } = pickStartupBounds(saved, [PRIMARY], DEFAULT)
    expect(adjusted).toBe(false)
    expect(bounds).toEqual(saved)
  })

  it('the real bug: bounds from a disconnected monitor → fallback + adjusted', () => {
    // x/y from a monitor positioned above-left, now gone; no overlap with primary.
    const stale = { x: -358, y: -1313, width: 1710, height: 1011 }
    const { bounds, adjusted } = pickStartupBounds(stale, [PRIMARY], DEFAULT)
    expect(adjusted).toBe(true) // → caller drops maximized:true (root-cause fix)
    expect(bounds).toEqual(DEFAULT)
  })

  it('oversized-but-overlapping bounds clamp strictly inside the work area', () => {
    const oversized = { x: 0, y: 0, width: 1710, height: 1011 }
    const { bounds, adjusted } = pickStartupBounds(oversized, [PRIMARY], DEFAULT)
    expect(adjusted).toBe(true)
    // Strictly smaller than the work area → never reported as maximized.
    expect(bounds.width).toBeLessThan(PRIMARY.width)
    expect(bounds.height).toBeLessThan(PRIMARY.height)
    expect(bounds.x).toBeGreaterThanOrEqual(PRIMARY.x)
    expect(bounds.y).toBeGreaterThanOrEqual(PRIMARY.y)
  })

  it('picks the display the window actually sits on (multi-monitor)', () => {
    const second: Rect = { x: -2560, y: 0, width: 2560, height: 1440 }
    const onSecond = { x: -2000, y: 200, width: 1280, height: 800 }
    const { bounds, adjusted } = pickStartupBounds(onSecond, [PRIMARY, second], DEFAULT)
    expect(adjusted).toBe(false)
    expect(bounds).toEqual(onSecond)
  })

  it('no displays / no saved bounds → fallback + adjusted', () => {
    expect(pickStartupBounds(undefined, [PRIMARY], DEFAULT)).toEqual({ bounds: DEFAULT, adjusted: true })
    expect(pickStartupBounds({ x: 0, y: 0, width: 800, height: 600 }, [], DEFAULT)).toEqual({
      bounds: DEFAULT,
      adjusted: true,
    })
  })
})
