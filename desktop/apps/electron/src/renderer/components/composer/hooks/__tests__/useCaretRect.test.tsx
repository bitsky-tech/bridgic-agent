/**
 * 光标矩形跟随 —— 固化「菜单打开期间,祖先容器滚动/窗口 resize 后必须重新量」。
 *
 * 回归背景:原实现只在打开和每次输入时量一次。首页 composer 处在 overflow-auto 容器里,
 * 打完 `@` 一滚页面,菜单(position:fixed)就留在原地,和输入框脱节。
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { RefObject } from 'react'
import type { RichTextInputHandle } from '../../RichTextInput'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act, useRef } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useCaretRect } = await import('../useCaretRect')

/** 可控的假 editor handle:只实现 getCaretRect,返回 `top` 由测试驱动。 */
function makeEditor(): { handle: { getCaretRect: () => DOMRect | null }; setTop: (t: number) => void; calls: () => number } {
  let top = 100
  let calls = 0
  return {
    handle: {
      getCaretRect: () => {
        calls += 1
        return { top, bottom: top + 20, left: 50 } as DOMRect
      },
    },
    setTop: (t: number) => { top = t },
    calls: () => calls,
  }
}

/** rAF 在 happy-dom 下是异步的,throttleRaf 的回调要等一帧。 */
const nextFrame = (): Promise<void> =>
  new Promise((resolve) => { requestAnimationFrame(() => resolve()) })

describe('useCaretRect', () => {
  it('滚动后按新位置重新量,并在 active=false 时不再订阅', async () => {
    const editor = makeEditor()
    const seen: (DOMRect | null)[] = []

    function Probe({ active }: { active: boolean }) {
      const ref = useRef(editor.handle)
      const rect = useCaretRect(ref as unknown as RefObject<RichTextInputHandle | null>, active, 'k')
      seen.push(rect)
      return null
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => { root.render(<Probe active />) })
    expect(seen.at(-1)?.top).toBe(100)

    // 容器滚动:事件不冒泡到 window,所以监听必须在捕获阶段 —— 这里从一个子节点派发来验证。
    editor.setTop(40)
    await act(async () => {
      host.dispatchEvent(new Event('scroll', { bubbles: false }))
      await nextFrame()
    })
    expect(seen.at(-1)?.top).toBe(40)

    // 关掉菜单后解绑:再滚不应该产生新的量测。
    await act(async () => { root.render(<Probe active={false} />) })
    const before = editor.calls()
    editor.setTop(999)
    await act(async () => {
      host.dispatchEvent(new Event('scroll', { bubbles: false }))
      await nextFrame()
    })
    expect(editor.calls()).toBe(before)

    await act(async () => { root.unmount() })
    host.remove()
  })

  it('位置没变时不产生新的 rect 引用 —— 每帧重渲整个菜单的防护', async () => {
    const editor = makeEditor()
    const seen: (DOMRect | null)[] = []

    function Probe() {
      const ref = useRef(editor.handle)
      const rect = useCaretRect(ref as unknown as RefObject<RichTextInputHandle | null>, true, 'k')
      seen.push(rect)
      return null
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => { root.render(<Probe />) })
    const first = seen.at(-1)

    await act(async () => {
      host.dispatchEvent(new Event('scroll', { bubbles: false }))
      await nextFrame()
    })
    expect(seen.at(-1)).toBe(first)

    await act(async () => { root.unmount() })
    host.remove()
  })
})
