/**
 * WindowedList + useInfiniteScrollSentinel — the shared DOM-windowing pair
 * extracted from FileTreeView's WindowedLevel.
 *
 * happy-dom never fires real intersections, so the tests install a recording
 * IntersectionObserver fake and drive its callback by hand — asserting both
 * the windowing behavior (chunk growth) and the lifecycle contract (no
 * observer when everything already fits).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { WindowedList } = await import('../WindowedList')

/** Recording IO fake: captures instances so tests can fire intersections. */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  observed: Element[] = []
  disconnected = false
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  disconnect(): void {
    this.disconnected = true
  }
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  fire(isIntersecting: boolean): void {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    )
  }
}

const realIO = globalThis.IntersectionObserver

beforeEach(() => {
  FakeIntersectionObserver.instances = []
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
})
afterEach(() => {
  globalThis.IntersectionObserver = realIO
})

function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  return {
    host,
    root,
    async render(next: React.ReactNode = node) {
      await act(async () => root.render(next))
    },
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

const items = (n: number) => Array.from({ length: n }, (_, i) => `row-${i}`)

describe('WindowedList', () => {
  it('mounts only the first chunk plus a sentinel when items overflow', async () => {
    const m = mount(null)
    await m.render(
      <WindowedList items={items(450)} chunk={200}>
        {(item) => <span key={item} data-row>{item}</span>}
      </WindowedList>,
    )

    expect(m.host.querySelectorAll('[data-row]')).toHaveLength(200)
    // Sentinel present and observed.
    expect(FakeIntersectionObserver.instances).toHaveLength(1)
    expect(FakeIntersectionObserver.instances[0]!.observed).toHaveLength(1)
    expect(m.host.textContent).toContain('450')
    await m.unmount()
  })

  it('appends the next chunk each time the sentinel intersects, then stops observing', async () => {
    const m = mount(null)
    await m.render(
      <WindowedList items={items(450)} chunk={200}>
        {(item) => <span key={item} data-row>{item}</span>}
      </WindowedList>,
    )

    await act(async () => FakeIntersectionObserver.instances.at(-1)!.fire(true))
    expect(m.host.querySelectorAll('[data-row]')).toHaveLength(400)

    await act(async () => FakeIntersectionObserver.instances.at(-1)!.fire(true))
    expect(m.host.querySelectorAll('[data-row]')).toHaveLength(450)

    // Everything visible → sentinel gone, every observer torn down.
    expect(m.host.textContent).not.toContain('正在载入更多')
    expect(FakeIntersectionObserver.instances.every((io) => io.disconnected)).toBe(true)
    await m.unmount()
  })

  it('ignores non-intersecting callbacks', async () => {
    const m = mount(null)
    await m.render(
      <WindowedList items={items(300)} chunk={200}>
        {(item) => <span key={item} data-row>{item}</span>}
      </WindowedList>,
    )

    await act(async () => FakeIntersectionObserver.instances.at(-1)!.fire(false))
    expect(m.host.querySelectorAll('[data-row]')).toHaveLength(200)
    await m.unmount()
  })

  it('creates no observer at all when items already fit in one chunk', async () => {
    const m = mount(null)
    await m.render(
      <WindowedList items={items(50)} chunk={200}>
        {(item) => <span key={item} data-row>{item}</span>}
      </WindowedList>,
    )

    expect(m.host.querySelectorAll('[data-row]')).toHaveLength(50)
    expect(FakeIntersectionObserver.instances).toHaveLength(0)
    await m.unmount()
  })

  it('clamps cleanly when the items array shrinks below the visible window', async () => {
    const m = mount(null)
    await m.render(
      <WindowedList items={items(450)} chunk={200}>
        {(item) => <span key={item} data-row>{item}</span>}
      </WindowedList>,
    )
    await act(async () => FakeIntersectionObserver.instances.at(-1)!.fire(true))
    expect(m.host.querySelectorAll('[data-row]')).toHaveLength(400)

    // e.g. a search filter narrows the list — no sentinel, no crash.
    await m.render(
      <WindowedList items={items(30)} chunk={200}>
        {(item) => <span key={item} data-row>{item}</span>}
      </WindowedList>,
    )
    expect(m.host.querySelectorAll('[data-row]')).toHaveLength(30)
    expect(m.host.textContent).not.toContain('正在载入更多')
    await m.unmount()
  })
})
