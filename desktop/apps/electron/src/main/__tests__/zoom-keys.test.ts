/**
 * Guards the keyboard responsibilities of `pickZoomDelta`.
 *
 * The key invariant is **mutual exclusion with the application menu**. The menu handles
 * `CmdOrCtrl+Plus`, `+-`, and `+0`; this module only adds unshifted `=` and numpad +/-.
 * If either side recognizes an extra key, one keypress takes both paths and zooms two levels.
 */
import { describe, it, expect } from 'bun:test'
import { ZOOM_LEVEL_STEP } from '@app/shared/types'
import { pickZoomDelta } from '../zoom-keys'

describe('pickZoomDelta', () => {
  it('handles supplemental zoom keys without duplicating menu accelerators', () => {
    expect(pickZoomDelta('=', 'Equal', false)).toBe(ZOOM_LEVEL_STEP)
    // Recognizing this would duplicate CmdOrCtrl+Plus and jump two levels per keypress.
    expect(pickZoomDelta('+', 'Equal', true)).toBeNull()
    expect(pickZoomDelta('=', 'Equal', true)).toBeNull()
    expect(pickZoomDelta('+', 'NumpadAdd', false)).toBe(ZOOM_LEVEL_STEP)
    expect(pickZoomDelta('-', 'NumpadSubtract', false)).toBe(-ZOOM_LEVEL_STEP)
    expect(pickZoomDelta('-', 'Minus', false)).toBeNull()
    expect(pickZoomDelta('0', 'Digit0', false)).toBeNull()
    expect(pickZoomDelta('w', 'KeyW', false)).toBeNull()
    expect(pickZoomDelta(undefined, undefined, false)).toBeNull()
  })
})
