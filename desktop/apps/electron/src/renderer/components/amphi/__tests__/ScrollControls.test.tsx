/**
 * 滚动按钮的方向意图 —— `nextScrollIntent` 纯函数的判定规则,以及
 * `ScrollControls` 按 direction 渲染正确的标签 / 滚动目标。
 *
 * 纯函数部分不需要 DOM;组件部分用 happy-dom(无布局引擎,所以滚动目标是
 * 直接读回 scrollTop,不校验动画过程)。
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import {
  INITIAL_SCROLL_INTENT,
  nextScrollIntent,
  ScrollDirection,
  type ScrollIntentState,
  type ScrollMetrics,
} from '../ScrollControls'

/** 一屏 600、内容 5000 的长列表,scrollTop 由用例给。 */
function metrics(scrollTop: number): ScrollMetrics {
  return { scrollTop, scrollHeight: 5000, clientHeight: 600 }
}

/** 从 `from` 连续滚到 `to`,每步 100px —— 模拟多次滚轮而非一次跳跃。 */
function scrollThrough(state: ScrollIntentState, from: number, to: number): ScrollIntentState {
  const step = to > from ? 100 : -100
  let current = { ...state, lastTop: from }
  for (let top = from + step; step > 0 ? top <= to : top >= to; top += step) {
    current = nextScrollIntent(current, metrics(top))
  }
  return current
}

describe('nextScrollIntent', () => {
  it('翻转到「回顶部」需要连续上滑跨过阈值', () => {
    const mid = { ...INITIAL_SCROLL_INTENT, lastTop: 3000, direction: ScrollDirection.Bottom }
    // 上滑 200px —— 还没到 300 阈值,保持原指向,不跟着单次手势抖动。
    expect(scrollThrough(mid, 3000, 2800).direction).toBe(ScrollDirection.Bottom)
    // 继续上滑到累计 400px,超过阈值 → 判定用户想回顶部。
    expect(scrollThrough(mid, 3000, 2600).direction).toBe(ScrollDirection.Top)
  })

  it('翻转到「回底部」需要连续下滑跨过阈值', () => {
    const mid = { ...INITIAL_SCROLL_INTENT, lastTop: 1000, direction: ScrollDirection.Top }
    expect(scrollThrough(mid, 1000, 1200).direction).toBe(ScrollDirection.Top)
    expect(scrollThrough(mid, 1000, 1400).direction).toBe(ScrollDirection.Bottom)
  })

  it('反向回拉清零累计 —— 上滑 500 再下滑 100 不算向下', () => {
    const mid = { ...INITIAL_SCROLL_INTENT, lastTop: 3000, direction: ScrollDirection.Bottom }
    const up = scrollThrough(mid, 3000, 2500)
    expect(up.direction).toBe(ScrollDirection.Top)
    const back = scrollThrough(up, 2500, 2600)
    // 只回拉 100,远不到阈值:指向保持「回顶部」,travel 已从 0 重新起算。
    expect(back.direction).toBe(ScrollDirection.Top)
    expect(back.travel).toBe(100)
  })

  it('贴顶时强制指向底部(此时「回顶部」是死按钮)', () => {
    const state = { ...INITIAL_SCROLL_INTENT, lastTop: 400, direction: ScrollDirection.Top }
    expect(nextScrollIntent(state, metrics(0)).direction).toBe(ScrollDirection.Bottom)
    expect(nextScrollIntent(state, metrics(80)).direction).toBe(ScrollDirection.Bottom)
  })

  it('贴底时强制指向顶部', () => {
    const state = { ...INITIAL_SCROLL_INTENT, lastTop: 1000, direction: ScrollDirection.Bottom }
    // scrollHeight - clientHeight = 4400 即最底;4400/4320 都在 80px 带内。
    expect(nextScrollIntent(state, metrics(4400)).direction).toBe(ScrollDirection.Top)
    expect(nextScrollIntent(state, metrics(4320)).direction).toBe(ScrollDirection.Top)
  })

  it('边界判定优先于累计位移', () => {
    // 从中部一路上滑到顶:累计位移指向 Top,但已经贴顶,按钮必须改指底部。
    const mid = { ...INITIAL_SCROLL_INTENT, lastTop: 1000, direction: ScrollDirection.Bottom }
    expect(scrollThrough(mid, 1000, 0).direction).toBe(ScrollDirection.Bottom)
  })

  it('是纯函数 —— 不改动传入的 state', () => {
    const state = { ...INITIAL_SCROLL_INTENT, lastTop: 1000, travel: -120 }
    const snapshot = { ...state }
    nextScrollIntent(state, metrics(1500))
    expect(state).toEqual(snapshot)
  })
})

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act, createRef } = await import('react')
const { createRoot } = await import('react-dom/client')
const { ScrollControls } = await import('../ScrollControls')

// 受控 rAF:smoothScrollTo 用 rAF + 缓动推进,happy-dom 不会自己跑帧。攒起来
// 手动喂时间戳,才能断言"最终落到哪一端"而不是只验个不崩。
const pendingFrames: FrameRequestCallback[] = []
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  pendingFrames.push(cb)) as typeof requestAnimationFrame

/**
 * 推进动画到结束:第一帧定基准 t0,第二帧超过 duration(450ms)→ 落到目标值。
 *
 * 时间戳刻意不用 0 —— smoothScrollTo 用 `t0 === 0` 当"未初始化"哨兵,喂 0 会
 * 让基准永远设不上。真实 rAF 的 DOMHighResTimeStamp 自 time origin 起算,不会
 * 是 0,所以这是测试替身要贴近的真实行为,不是生产代码的问题。
 */
function runScrollAnimation(): void {
  for (const now of [16, 466]) {
    const frames = pendingFrames.splice(0, pendingFrames.length)
    for (const frame of frames) frame(now)
  }
}

/** 挂一个带滚动容器的 ScrollControls,返回按钮 + 容器供断言。 */
async function mountControls(direction: ScrollDirection) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const scrollRef = createRef<HTMLDivElement>()
  const container = document.createElement('div')
  // happy-dom 无布局:显式喂度量,让 jump 目标可计算。
  Object.defineProperty(container, 'scrollHeight', { value: 5000, configurable: true })
  Object.defineProperty(container, 'clientHeight', { value: 600, configurable: true })
  container.scrollTop = 2000
  ;(scrollRef as { current: HTMLDivElement | null }).current = container

  const root = createRoot(host)
  await act(async () => {
    root.render(<ScrollControls scrollRef={scrollRef} visible direction={direction} />)
  })
  const button = host.querySelector('button')
  return { host, root, container, button }
}

describe('ScrollControls', () => {
  it('direction=top 时标注「回到顶部」,点击滚到最顶', async () => {
    const { host, root, container, button } = await mountControls(ScrollDirection.Top)
    expect(button?.getAttribute('aria-label')).toBe('回到顶部')
    await act(async () => {
      button?.click()
    })
    runScrollAnimation()
    expect(container.scrollTop).toBe(0)
    await act(async () => root.unmount())
    host.remove()
  })

  it('direction=bottom 时标注「回到底部」,点击滚到最底', async () => {
    const { host, root, container, button } = await mountControls(ScrollDirection.Bottom)
    expect(button?.getAttribute('aria-label')).toBe('回到底部')
    await act(async () => {
      button?.click()
    })
    runScrollAnimation()
    // scrollHeight(5000) - clientHeight(600)
    expect(container.scrollTop).toBe(4400)
    await act(async () => root.unmount())
    host.remove()
  })
})
