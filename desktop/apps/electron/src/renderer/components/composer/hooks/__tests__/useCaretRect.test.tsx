/**
 * Caret rectangle tracking: remeasure after ancestor scrolling or window resize while a menu is open.
 *
 * Regression: the original implementation measured only on open and input. The landing-page
 * composer is inside an overflow-auto container, so scrolling after typing `@` left the fixed menu behind.
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

/** Controllable editor handle implementing only getCaretRect, with test-driven `top`. */
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

/** rAF is asynchronous in happy-dom, so throttleRaf callbacks need one frame. */
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

    // Container scroll events do not bubble to window, so capture is required; dispatch from a child to verify it.
    editor.setTop(40)
    await act(async () => {
      host.dispatchEvent(new Event('scroll', { bubbles: false }))
      await nextFrame()
    })
    expect(seen.at(-1)?.top).toBe(40)

    // Closing the menu removes listeners, so later scrolling must not trigger another measurement.
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
