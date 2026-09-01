/**
 * Pipeline tail-windowing — a huge transcript mounts only its most recent chunk, and a
 * top sentinel reveals older messages on demand.
 *
 * Driven through the legacy `messages` prop (same windowing code path as live
 * atom data, minus the streaming machinery) with a recording IO fake. happy-dom
 * has no layout, so scrollTop compensation is only exercised for "doesn't
 * crash"; the visual anchor check is manual (bun run dev).
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
const { createStore, Provider } = await import('jotai')
const { Pipeline, MESSAGE_TAIL_CHUNK } = await import('../Pipeline')

class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  observed: Element[] = []
  constructor(private callback: IntersectionObserverCallback) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element): void {
    this.observed.push(el)
  }
  disconnect(): void {}
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  fire(): void {
    this.callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
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

function buildMessages(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    role: i % 2 === 0 ? ('user' as const) : ('ai' as const),
    content: `msg-${i}-body`,
    messageId: `m_${i}`,
  }))
}

function mountPipeline(messages: unknown[]) {
  const store = createStore()
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  return {
    host,
    async render(next: unknown[] = messages) {
      await act(async () =>
        root.render(
          <Provider store={store}>
            <Pipeline messages={next as never} />
          </Provider>,
        ),
      )
    },
    async unmount() {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

describe('Pipeline tail windowing', () => {
  it('mounts only the tail chunk of a huge transcript, oldest rows hidden', async () => {
    const total = MESSAGE_TAIL_CHUNK * 3 + 17
    const m = mountPipeline(buildMessages(total))
    await m.render()

    expect(m.host.textContent).toContain(`msg-${total - 1}-body`) // newest
    expect(m.host.textContent).toContain(`msg-${total - MESSAGE_TAIL_CHUNK}-body`) // window head
    expect(m.host.textContent).not.toContain(`msg-${total - MESSAGE_TAIL_CHUNK - 1}-body`)
    expect(m.host.textContent).toContain('更早') // top sentinel
    await m.unmount()
  })

  it('reveals one more chunk per sentinel hit and removes the sentinel at the top', async () => {
    const total = MESSAGE_TAIL_CHUNK * 2 + 5
    const m = mountPipeline(buildMessages(total))
    await m.render()

    await act(async () => FakeIntersectionObserver.instances.at(-1)!.fire())
    expect(m.host.textContent).toContain(`msg-${total - MESSAGE_TAIL_CHUNK * 2}-body`)
    expect(m.host.textContent).toContain('msg-5-body')
    expect(m.host.textContent).not.toContain('msg-4-body')

    await act(async () => FakeIntersectionObserver.instances.at(-1)!.fire())
    expect(m.host.textContent).toContain('msg-0-body')
    expect(m.host.textContent).not.toContain('更早')
    await m.unmount()
  })

  it('small transcripts render fully with no sentinel and no observer', async () => {
    const m = mountPipeline(buildMessages(8))
    await m.render()

    expect(m.host.textContent).toContain('msg-0-body')
    expect(m.host.textContent).toContain('msg-7-body')
    expect(m.host.textContent).not.toContain('更早')
    expect(FakeIntersectionObserver.instances).toHaveLength(0)
    await m.unmount()
  })

  it('windows a transcript that hydrates in AFTER an empty first render', async () => {
    const total = MESSAGE_TAIL_CHUNK * 2
    const m = mountPipeline([])
    await m.render([])
    // Transcript lands asynchronously (session switch) — window must apply then.
    await m.render(buildMessages(total))

    expect(m.host.textContent).toContain(`msg-${total - 1}-body`)
    expect(m.host.textContent).not.toContain('msg-0-body')
    expect(m.host.textContent).toContain('更早')
    await m.unmount()
  })

  it('keeps the window head anchored when new messages append at the tail', async () => {
    const total = MESSAGE_TAIL_CHUNK + 40
    const rows = buildMessages(total)
    const m = mountPipeline(rows)
    await m.render()
    const headBody = `msg-${total - MESSAGE_TAIL_CHUNK}-body`
    expect(m.host.textContent).toContain(headBody)

    // A new turn lands: the window grows instead of sliding — the head row
    // must NOT drop out (that would shift a mid-history reader's viewport).
    await m.render([...rows, ...buildMessages(total + 2).slice(total)])
    expect(m.host.textContent).toContain(headBody)
    expect(m.host.textContent).toContain(`msg-${total + 1}-body`)
    await m.unmount()
  })
})
