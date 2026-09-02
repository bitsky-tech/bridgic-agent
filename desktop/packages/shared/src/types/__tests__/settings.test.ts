/**
 * Pure-logic guards for interface zoom: range clamping and percentage conversion.
 *
 * These two helpers are the single source of truth **shared** by the main process and
 * renderer (menu shortcuts, settings, and window-state restoration all use them), so
 * their boundary behavior must be locked down here. This is especially important for
 * `clampZoomLevel`, the only guard between malformed configuration (an edited or
 * imported gui-settings.json) and a UI zoomed so far that no control is reachable.
 *
 * Implicit dependencies: none. These pure functions do not touch Electron or disk.
 */
import { describe, it, expect } from 'bun:test'
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  ZOOM_LEVEL_MAX,
  ZOOM_LEVEL_MIN,
  clampZoomLevel,
  zoomPercent,
} from '../settings'

describe('clampZoomLevel', () => {
  it('keeps valid levels, clamps bounds, and rejects non-finite input', () => {
    for (const level of [ZOOM_LEVEL_MIN, -0.5, 0, 1.5, ZOOM_LEVEL_MAX]) {
      expect(clampZoomLevel(level)).toBe(level)
    }
    expect(clampZoomLevel(40)).toBe(ZOOM_LEVEL_MAX)
    expect(clampZoomLevel(-40)).toBe(ZOOM_LEVEL_MIN)
    // An edited or imported configuration can contain zoomLevel: null, which becomes
    // NaN. Passing it to setZoomLevel breaks the whole window with no recovery path.
    expect(clampZoomLevel(Number.NaN)).toBe(0)
    expect(clampZoomLevel(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('zoomPercent', () => {
  it('maps representative and clamped levels to percentages', () => {
    expect(zoomPercent(0)).toBe(100)
    // The 0.5 step exists for this level. An integer step would jump straight to 120%,
    // which is too coarse when the user only finds the text slightly small.
    expect(zoomPercent(0.5)).toBe(110)
    expect(zoomPercent(999)).toBe(zoomPercent(ZOOM_LEVEL_MAX))
  })
})

describe('DEFAULT_SETTINGS', () => {
  it('carries current defaults without the removed font slice', () => {
    expect(DEFAULT_SETTINGS.zoomLevel).toBe(0)
    expect(DEFAULT_SETTINGS.version).toBe(SETTINGS_VERSION)
    expect(DEFAULT_SETTINGS.ui.telemetryOptIn).toBe(true)
    expect(DEFAULT_SETTINGS.layout.rightPanelWidth).toBe(320)
    // font.family / font.size used to populate --font-family / --font-size, but CSS reads
    // --font-sans and no rule reads --font-size. These dead settings were removed in v2.
    expect('font' in DEFAULT_SETTINGS).toBe(false)
  })
})
