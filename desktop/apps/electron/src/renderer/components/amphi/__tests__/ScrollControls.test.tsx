/**
 * Scroll-button direction intent: rules in pure `nextScrollIntent`, plus labels and scroll
 * targets rendered by `ScrollControls` for each direction.
 *
 * Pure logic needs no DOM. Component tests use happy-dom, which has no layout engine, so they
 * read scrollTop directly and do not validate intermediate animation frames.
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

/** Long list with a 600 px viewport and 5000 px content; each test supplies scrollTop. */
function metrics(scrollTop: number): ScrollMetrics {
  return { scrollTop, scrollHeight: 5000, clientHeight: 600 }
}

/** Scroll from `from` to `to` in 100 px steps to model repeated wheel input rather than a jump. */
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
    // Moving up 200 px stays below the 300 px threshold, preserving direction across a small gesture.
    expect(scrollThrough(mid, 3000, 2800).direction).toBe(ScrollDirection.Bottom)
    // Continuing to 400 px exceeds the threshold and indicates intent to return to the top.
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
    // Reversing only 100 px stays below the threshold, keeps the top intent, and restarts travel from zero.
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
    // scrollHeight - clientHeight = 4400 is the bottom; both 4400 and 4320 lie within the 80 px band.
    expect(nextScrollIntent(state, metrics(4400)).direction).toBe(ScrollDirection.Top)
    expect(nextScrollIntent(state, metrics(4320)).direction).toBe(ScrollDirection.Top)
  })

  it('边界判定优先于累计位移', () => {
    // After scrolling from the middle to the top, cumulative intent points up but the button must point down.
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

// Controlled rAF: smoothScrollTo advances with rAF and easing, while happy-dom runs no frames.
// Queue callbacks and feed timestamps manually to assert the final endpoint, not merely no crash.
const pendingFrames: FrameRequestCallback[] = []
globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) =>
  pendingFrames.push(cb)) as typeof requestAnimationFrame

/**
 * Advance animation to completion: the first frame sets t0 and the second exceeds 450 ms.
 *
 * Deliberately avoid timestamp zero because smoothScrollTo uses `t0 === 0` as an uninitialized
 * sentinel. A real rAF DOMHighResTimeStamp starts from the time origin and is nonzero, so the
 * test double must match browser behavior rather than exposing an artificial production issue.
 */
function runScrollAnimation(): void {
  for (const now of [16, 466]) {
    const frames = pendingFrames.splice(0, pendingFrames.length)
    for (const frame of frames) frame(now)
  }
}

/** Mount ScrollControls with a scroll container and return both for assertions. */
async function mountControls(direction: ScrollDirection) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const scrollRef = createRef<HTMLDivElement>()
  const container = document.createElement('div')
  // happy-dom has no layout, so provide metrics explicitly to make the jump target computable.
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
