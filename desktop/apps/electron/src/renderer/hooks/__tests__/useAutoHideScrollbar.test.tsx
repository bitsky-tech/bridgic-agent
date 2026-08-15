import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

afterEach(() => {
  delete document.documentElement.dataset.platform
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act, useRef } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useAutoHideScrollbar } = await import('../useAutoHideScrollbar')

function Harness({ idleMs = 10 }: { idleMs?: number }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useAutoHideScrollbar(scrollRef, idleMs)
  return <div ref={scrollRef} className="auto-hide-scrollbar" data-testid="scroller" />
}

async function mount() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => root.render(<Harness />))
  return { host, root, scroller: host.querySelector('[data-testid="scroller"]') as HTMLDivElement }
}

describe('useAutoHideScrollbar', () => {
  it('shows the Windows thumb during interaction and hides it after idling', async () => {
    document.documentElement.dataset.platform = 'win32'
    const { host, root, scroller } = await mount()

    scroller.dispatchEvent(new Event('scroll'))
    expect(scroller.classList.contains('auto-hide-scrollbar-active')).toBe(true)

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 20))
    })
    expect(scroller.classList.contains('auto-hide-scrollbar-active')).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })

  it('leaves macOS native scrollbar behaviour untouched', async () => {
    document.documentElement.dataset.platform = 'darwin'
    const { host, root, scroller } = await mount()

    scroller.dispatchEvent(new Event('scroll'))
    expect(scroller.classList.contains('auto-hide-scrollbar-active')).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })
})
