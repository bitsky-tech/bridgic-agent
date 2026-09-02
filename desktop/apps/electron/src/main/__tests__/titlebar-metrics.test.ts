/**
 * Tests for the Windows Control Overlay height arithmetic.
 *
 * This locks down a **cross-process** invariant: the system draws the overlay in DIP,
 * while the renderer draws TopBar in CSS pixels, and their heights must match at every
 * zoom level. The first implementation omitted the zoom factor and always used 44, so
 * the three caption buttons drifted from the top bar after a zoom shortcut. macOS could
 * not reproduce this because it uses hiddenInset and has no overlay.
 */
import { describe, it, expect } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ZOOM_LEVEL_MAX, ZOOM_LEVEL_MIN, zoomPercent } from '@app/shared/types'
import { TITLEBAR_HEIGHT, overlayHeightFor } from '../titlebar-metrics'

describe('TITLEBAR_HEIGHT', () => {
  // This previously required TopBar's className to equal h-11 literally. That invariant
  // no longer exists: the top bar now follows `--titlebar-height`, which
  // `useWindowControlsInset` sets from the measured Windows caption height. It is no
  // longer a hard-coded constant; keeping two sources equal by arithmetic caused the drift.
  //
  // The original failure mode still needs protection: the two heights can silently drift
  // while typecheck and lint stay green, with only a visual mismatch on Windows. The new
  // contract requires TopBar to consume the variable and its non-Windows/fullscreen fallback
  // to equal this file's TITLEBAR_HEIGHT.
  //
  // Read source instead of rendering TopBar because its atoms access `window`, while bun:test has no DOM.
  const read = (rel: string): string => readFileSync(join(import.meta.dir, rel), 'utf-8')

  it('is the height TopBar actually consumes, via the shared CSS variable', () => {
    const topBar = read('../../renderer/components/amphi/TopBar.tsx')
    expect(topBar).toContain('h-[var(--titlebar-height)]')
    // Negative assertion: fail if someone restores a hard-coded Tailwind height class.
    expect(topBar).not.toContain('className="h-11 ')
  })

  it('equals the CSS fallback used when no overlay can be measured', () => {
    // The fallback travels through two independent paths, both equal to TITLEBAR_HEIGHT:
    //   index.css     — static :root default used on non-Windows platforms
    //   the hook      — constant used in fullscreen when the overlay is hidden
    const css = read('../../renderer/index.css')
    expect(css).toContain(`--titlebar-height: ${TITLEBAR_HEIGHT}px`)

    const hook = read('../../renderer/hooks/useWindowControlsInset.ts')
    expect(hook).toContain(`const FALLBACK_TITLEBAR_HEIGHT = ${TITLEBAR_HEIGHT}`)
  })
})

describe('overlayHeightFor', () => {
  it('equals the bare TopBar height at 100%', () => {
    expect(overlayHeightFor(0)).toBe(TITLEBAR_HEIGHT)
  })

  it('tracks the SAME zoom base the renderer uses', () => {
    // This is the central assertion: align with `zoomPercent()` instead of duplicating
    // `1.2 **`. That function drives the percentage users see in Settings, so changing
    // the zoom base without updating the other path must fail here.
    for (let level = ZOOM_LEVEL_MIN; level <= ZOOM_LEVEL_MAX; level += 0.5) {
      const expected = Math.round((TITLEBAR_HEIGHT * zoomPercent(level)) / 100)
      // Use tolerance 2 rather than 1 because height snaps to a multiple of 4 (DIP_GRID in
      // overlayHeightFor). A half step such as level=1.5 gives 57.8 -> 56, a difference of 2.
      // This is intentional: grid alignment produces integer physical pixels at 125/150/175%,
      // while the top bar follows `getTitlebarAreaRect()`, so the difference is not visible.
      expect(Math.abs(overlayHeightFor(level) - expected)).toBeLessThanOrEqual(2)
    }
  })

  it('always lands on the DIP grid so common Windows scalings stay integral', () => {
    // Odd DIP values land on half a physical pixel at 150% and are snapped, so the system's
    // caption height differs from `getTitlebarAreaRect()`. This appeared as a taller white strip
    // at the top right of a modal. Five of the original seven values were odd (31/37/53/63/91).
    for (let level = ZOOM_LEVEL_MIN; level <= ZOOM_LEVEL_MAX; level += 0.5) {
      const h = overlayHeightFor(level)
      expect(h % 4).toBe(0)
      for (const scale of [1.25, 1.5, 1.75]) {
        expect(Number.isInteger(h * scale)).toBe(true)
      }
    }
  })

  it('grows when zoomed in and shrinks when zoomed out', () => {
    expect(overlayHeightFor(2)).toBeGreaterThan(TITLEBAR_HEIGHT)
    expect(overlayHeightFor(-2)).toBeLessThan(TITLEBAR_HEIGHT)
  })

  it('clamps a corrupt zoom level instead of returning an absurd height', () => {
    // An edited settings.json with zoomLevel: 40 produces an overlay hundreds of thousands
    // of pixels tall, letting caption buttons consume the window. clampZoomLevel must guard it.
    expect(overlayHeightFor(40)).toBe(overlayHeightFor(ZOOM_LEVEL_MAX))
    expect(overlayHeightFor(-40)).toBe(overlayHeightFor(ZOOM_LEVEL_MIN))
    expect(overlayHeightFor(Number.NaN)).toBe(TITLEBAR_HEIGHT)
  })
})
