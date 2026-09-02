/**
 * Floating-menu positioning: keep the menu inside the viewport and below the title bar.
 *
 * Regression one: height was hard-coded as 260 while the mention menu can reach about 440.
 * On the landing page, roughly 300 px above the centered composer looked sufficient, so the
 * menu expanded upward and was clipped beyond recovery because it is position: fixed.
 * Regression two: after scrolling, the caret could move behind the native title-bar controls
 * and drag region, pulling the menu into that strip. z-index cannot fix native overlap.
 *
 * Stub only window.innerWidth/innerHeight because the function under test is pure and avoids the DOM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { useCaretFloatingPosition } from '../useCaretFloatingPosition'

const VIEWPORT = { innerWidth: 1400, innerHeight: 900 }
const originalWindow = globalThis.window

beforeAll(() => {
  ;(globalThis as { window?: unknown }).window = VIEWPORT
})
afterAll(() => {
  ;(globalThis as { window?: unknown }).window = originalWindow
})

/** Only left/top/bottom affect the calculation; fill other fields to satisfy DOMRect. */
function caretAt(top: number, left = 500): DOMRect {
  return { top, bottom: top + 20, left, right: left + 1, width: 1, height: 20, x: left, y: top } as DOMRect
}

/** Real mention-menu box; title bar 44 is the --titlebar-height fallback. */
const MENTION = { width: 440, height: 440 }
const CHROME = 44

describe('useCaretFloatingPosition', () => {
  it('无光标矩形时不给样式', () => {
    expect(useCaretFloatingPosition(null)).toBeNull()
  })

  it('上方放得下 → 向上展开(底边贴光标上沿)', () => {
    // Session layout: caret near the window bottom with 700 px above.
    expect(useCaretFloatingPosition(caretAt(700), MENTION)).toEqual({
      position: 'fixed',
      left: 490,
      bottom: 900 - 700 + 8,
    })
  })

  it('上方放不下但下方放得下 → 向下展开(首页居中 composer 的情形)', () => {
    // Regression: 300 px above cannot fit a 440 px menu, though the old 260 estimate chose upward.
    expect(useCaretFloatingPosition(caretAt(300), MENTION)).toEqual({
      position: 'fixed',
      left: 490,
      top: 328,
    })
  })

  it('同一位置的 slash 菜单(280 高)仍向上 —— 翻转只跟真实高度走', () => {
    expect(useCaretFloatingPosition(caretAt(300))).toEqual({
      position: 'fixed',
      left: 490,
      bottom: 608,
    })
  })

  it('两侧都放不下 → 取空间大的一侧,且向上时钉在可用区顶边而非飘出视口', () => {
    // With 445 px above and 435 below, neither fits 440+8; choose above but clamp to top: 8.
    expect(useCaretFloatingPosition(caretAt(445), MENTION)).toEqual({
      position: 'fixed',
      left: 490,
      top: 8,
    })
    // With 435 px above and 445 below, choose below and attach to the caret bottom.
    expect(useCaretFloatingPosition(caretAt(435), MENTION)).toEqual({
      position: 'fixed',
      left: 490,
      top: 463,
    })
  })

  it('光标滚到顶栏背后 / 视口下方 → 不给样式,菜单随锚点一起消失', () => {
    // The landing-page composer sits in a scroll container, so the caret can move into or above
    // the native title-bar controls and drag strip. Clamping a 440 px menu below the title bar
    // left it floating over unrelated content while still consuming Enter.
    expect(useCaretFloatingPosition(caretAt(20), { ...MENTION, topInset: CHROME })).toBeNull()
    expect(useCaretFloatingPosition(caretAt(-30), { ...MENTION, topInset: CHROME })).toBeNull()
    expect(useCaretFloatingPosition(caretAt(900), MENTION)).toBeNull()
  })

  it('光标只有一半被顶栏遮住 → 不算消失,照常贴光标下沿展开', () => {
    // bottom=50 remains visible below the 44 px title bar; hiding a partially visible anchor would flicker.
    expect(useCaretFloatingPosition(caretAt(30), { ...MENTION, topInset: CHROME })).toEqual({
      position: 'fixed',
      left: 490,
      top: 58,
    })
  })

  it('向上展开的判定也扣掉顶栏 —— 差一点够的情形不再向上', () => {
    // Without title-bar reservation, 452 >= 448 selects upward and places the menu at y=12 over the title bar.
    expect(useCaretFloatingPosition(caretAt(460), MENTION)).toEqual({
      position: 'fixed',
      left: 490,
      bottom: 448,
    })
    // Reserving the title bar leaves only 408 px, so upward placement is no longer selected.
    expect(useCaretFloatingPosition(caretAt(460), { ...MENTION, topInset: CHROME })).toEqual({
      position: 'fixed',
      left: 490,
      top: 488,
    })
  })

  it('水平方向按真实宽度夹紧,不越出左右边界', () => {
    expect(useCaretFloatingPosition(caretAt(700, 1390), MENTION)?.left).toBe(1400 - 440 - 8)
    expect(useCaretFloatingPosition(caretAt(700, 2), MENTION)?.left).toBe(8)
  })
})
