/**
 * Tests for `computePopoverPos` — the sched-freq popover's placement.
 *
 * 两条回归各锁一个真实事故:
 *   1. 首版永远 `rect.bottom + 6`,而 chip 长在钉死于窗口底部的 composer 里 ——
 *      弹层整个落到视口外、用户点不到。
 *   2. 第二版改成「实测 offsetHeight 决定翻转」,与 ResizeObserver 组成死循环:
 *      测到被 maxHeight 夹住的高度 → 判定"这下放得下了" → 撤掉夹子 → 盒子长回去
 *      → 再次放不下。故本函数**签名里就不该有高度参数** —— 下面第一条断言的正是
 *      这一点(定位只依赖锚点与视口)。
 */
import { describe, it, expect } from 'bun:test'

import { computePopoverPos, POPOVER_WIDTH } from '../popoverPos'

/** 典型窗口:1280×800。 */
const VIEWPORT = { width: 1280, height: 800 }

describe('computePopoverPos', () => {
  it('is a pure function of anchor + viewport (no height input, no height output)', () => {
    // 这条是防死循环的结构性断言:只要定位不吃高度,「夹住 → 重测 → 放开」的
    // 反馈环就构造不出来。签名变了(比如有人加回 popoverHeight 参数)这里会红。
    expect(computePopoverPos.length).toBe(2)
    const pos = computePopoverPos({ top: 100, bottom: 124, left: 300 }, VIEWPORT)
    expect(Object.keys(pos).sort()).toEqual(['left', 'maxHeight', 'top', 'width'])
  })

  it('opens downward when below is the roomier side', () => {
    // chip 在页面顶部 → 下方空间大 → 向下,阅读顺序自然。
    const pos = computePopoverPos({ top: 100, bottom: 124, left: 300 }, VIEWPORT)
    expect(pos.top).toBe(130) // bottom + GAP
    expect(pos.bottom).toBeUndefined()
    expect(pos.left).toBe(300)
  })

  it('opens upward when the chip sits low — the original bug', () => {
    // 实际场景:composer 钉在底部,chip 距底缘只有几十像素。
    const chip = { top: 740, bottom: 764, left: 300 }
    const pos = computePopoverPos(chip, VIEWPORT)
    // 用 bottom 锚定 = 从 chip 上沿往上长,不需要知道自己多高。
    expect(pos.bottom).toBe(VIEWPORT.height - chip.top + 6)
    expect(pos.top).toBeUndefined()
    // 净空必须落在 chip 上方且不越视口顶。
    expect(pos.maxHeight).toBe(chip.top - 8 - 6)
  })

  it('never lets the popover overlap the anchor or leave the viewport', () => {
    // 扫一遍 chip 的所有纵向位置,断言"占用区间"始终既在视口内、又不压到 chip。
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
    // 窗口被压到比留白还矮时,夹子取 0 而不是负数(负 maxHeight 会被浏览器忽略,
    // 等于不限高 —— 那就又回到弹层铺满屏幕的老问题)。
    const tiny = { width: 1280, height: 10 }
    const pos = computePopoverPos({ top: 4, bottom: 8, left: 0 }, tiny)
    expect(pos.maxHeight).toBeGreaterThanOrEqual(0)
  })
})
