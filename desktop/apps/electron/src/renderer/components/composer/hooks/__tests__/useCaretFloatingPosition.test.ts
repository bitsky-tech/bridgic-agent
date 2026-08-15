/**
 * 悬浮菜单定位 —— 固化「菜单永远不许飘出视口,也不许压住顶栏」这两条不变式。
 *
 * 回归背景之一:高度估值写死 260,而 @ 菜单实际最高 ~440。首页(composer 垂直居中)
 * 光标上方约 300px,按 260 判定"放得下"→ 菜单底边贴光标向上展开,顶部被窗口顶边裁掉
 * 且无法滚回来(position:fixed)。
 * 之二:菜单跟随光标滚动后,光标会滚到顶栏背后,菜单跟着画进顶栏那条带 —— 那里是原生
 * 窗口按钮 + 拖拽区,盖住不是 z-index 能解决的问题。
 *
 * 只 stub window.innerWidth/innerHeight —— 被测函数是纯函数,不碰 DOM。
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

/** 只有 left/top/bottom 参与计算,其余字段补齐以满足 DOMRect 类型。 */
function caretAt(top: number, left = 500): DOMRect {
  return { top, bottom: top + 20, left, right: left + 1, width: 1, height: 20, x: left, y: top } as DOMRect
}

/** @ 菜单的真实盒子;顶栏 44 = --titlebar-height 的兜底值。 */
const MENTION = { width: 440, height: 440 }
const CHROME = 44

describe('useCaretFloatingPosition', () => {
  it('无光标矩形时不给样式', () => {
    expect(useCaretFloatingPosition(null)).toBeNull()
  })

  it('上方放得下 → 向上展开(底边贴光标上沿)', () => {
    // 会话页形态:光标贴近窗口底部,上方 700px。
    expect(useCaretFloatingPosition(caretAt(700), MENTION)).toEqual({
      position: 'fixed',
      left: 490,
      bottom: 900 - 700 + 8,
    })
  })

  it('上方放不下但下方放得下 → 向下展开(首页居中 composer 的情形)', () => {
    // 回归用例:上方 300px 装不下 440px 的 @ 菜单,旧逻辑按 260 判定会向上飘出窗口。
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
    // 上方 445 / 下方 435,都装不下 440+8:取上方,但钉在 top:8(遮住光标好过飘出窗口)。
    expect(useCaretFloatingPosition(caretAt(445), MENTION)).toEqual({
      position: 'fixed',
      left: 490,
      top: 8,
    })
    // 上方 435 / 下方 445:取下方,贴光标下沿。
    expect(useCaretFloatingPosition(caretAt(435), MENTION)).toEqual({
      position: 'fixed',
      left: 490,
      top: 463,
    })
  })

  it('光标滚到顶栏背后 / 视口下方 → 不给样式,菜单随锚点一起消失', () => {
    // 首页 composer 在滚动容器里,光标能滚进顶栏那条带(原生窗口按钮 + 拖拽区)甚至更上面。
    // 早前的做法是把菜单钉在顶栏下沿,结果 440px 的浮层悬在与它无关的内容上,还继续吃 Enter。
    expect(useCaretFloatingPosition(caretAt(20), { ...MENTION, topInset: CHROME })).toBeNull()
    expect(useCaretFloatingPosition(caretAt(-30), { ...MENTION, topInset: CHROME })).toBeNull()
    expect(useCaretFloatingPosition(caretAt(900), MENTION)).toBeNull()
  })

  it('光标只有一半被顶栏遮住 → 不算消失,照常贴光标下沿展开', () => {
    // bottom=50 仍露在顶栏(44)下面 → 锚点算可见。滚动是连续的,半遮就消失会闪。
    expect(useCaretFloatingPosition(caretAt(30), { ...MENTION, topInset: CHROME })).toEqual({
      position: 'fixed',
      left: 490,
      top: 58,
    })
  })

  it('向上展开的判定也扣掉顶栏 —— 差一点够的情形不再向上', () => {
    // 不预留顶栏:上方 452 ≥ 448,向上展开,菜单顶边落在 y=12,压住 44px 的顶栏。
    expect(useCaretFloatingPosition(caretAt(460), MENTION)).toEqual({
      position: 'fixed',
      left: 490,
      bottom: 448,
    })
    // 预留后可用空间只剩 408,不够 → 不再向上。
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
