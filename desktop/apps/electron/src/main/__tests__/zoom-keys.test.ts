/**
 * `pickZoomDelta` 的键位分工守卫。
 *
 * 核心不变式是**与应用菜单互斥**:菜单挂 `CmdOrCtrl+Plus` / `+-` / `+0`,本模块只补
 * 未加 Shift 的 `=` 和小键盘 +/-。任何一边多认一个键,一次按键就会走两条路、缩放跳两级。
 */
import { describe, it, expect } from 'bun:test'
import { ZOOM_LEVEL_STEP } from '@app/shared/types'
import { pickZoomDelta } from '../zoom-keys'

describe('pickZoomDelta', () => {
  it('handles supplemental zoom keys without duplicating menu accelerators', () => {
    expect(pickZoomDelta('=', 'Equal', false)).toBe(ZOOM_LEVEL_STEP)
    // 认了就会与 CmdOrCtrl+Plus 重复触发,一次按键跳两级。
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
