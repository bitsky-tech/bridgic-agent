import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AgentMessage } from '@/atoms/agent'
import type { PipelineProps } from '../Pipeline'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { AgentRole } = await import('@shared/types')
const { messageFamily, streamingFamily, transcriptPagingFamily } = await import('@/atoms/agent')
const { setHumanRequestAtom } = await import('@/atoms/human-request')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { BackendState } = await import('../../../../main/python-client/types')
const { Pipeline, MESSAGE_TAIL_CHUNK } = await import('../Pipeline')

const originalFetch = globalThis.fetch
const originalRAF = globalThis.requestAnimationFrame
const originalCancelRAF = globalThis.cancelAnimationFrame
const originalIO = globalThis.IntersectionObserver
const originalScrollIntoView = HTMLElement.prototype.scrollIntoView
const frames = new Map<number, FrameRequestCallback>()
const scrolled: HTMLElement[] = []
let nextFrameId = 0

class FakeIntersectionObserver {
  static latest: FakeIntersectionObserver | null = null
  constructor(private callback: IntersectionObserverCallback) { FakeIntersectionObserver.latest = this }
  observe() {}
  disconnect() {}
  fire() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
}

beforeEach(() => {
  frames.clear()
  scrolled.length = 0
  FakeIntersectionObserver.latest = null
  globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrameId, callback); return nextFrameId }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  globalThis.IntersectionObserver = FakeIntersectionObserver as unknown as typeof IntersectionObserver
  HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this) }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  globalThis.requestAnimationFrame = originalRAF
  globalThis.cancelAnimationFrame = originalCancelRAF
  globalThis.IntersectionObserver = originalIO
  HTMLElement.prototype.scrollIntoView = originalScrollIntoView
  document.body.replaceChildren()
})

afterAll(async () => { await GlobalRegistrator.unregister() })

async function flushFrames() {
  for (let count = 0; count < 4 && frames.size; count += 1) {
    const pending = [...frames.values()]
    frames.clear()
    await act(async () => { for (const callback of pending) callback(performance.now()) })
  }
}

function rows(count: number, prefix = 'turn'): AgentMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${prefix}-message-${index}`,
    turnId: `${prefix}-${Math.floor(index / 2)}`,
    role: index % 2 ? AgentRole.Assistant : AgentRole.User,
    text: `${prefix}-body-${index}`,
    toolCalls: [], done: true, createdAt: index,
  }))
}

function mount(sessionId: string, messages: AgentMessage[]) {
  const store = createStore()
  store.set(activeSessionIdAtom, sessionId)
  store.set(messageFamily(sessionId), messages)
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  return {
    host, store,
    render: async (props: PipelineProps = {}) => act(async () => root.render(<Provider store={store}><Pipeline {...props} /></Provider>)),
    unmount: async () => act(async () => root.unmount()),
  }
}

function installBackend(store: ReturnType<typeof createStore>) {
  store.set(backendSnapshotAtom, {
    state: BackendState.Ready,
    endpoint: { baseUrl: 'http://127.0.0.1:7421', token: 'test', version: null, startedAt: null, wsPath: null },
    lastError: null,
  } as never)
}

describe('Pipeline extensions', () => {
  it('overrides persisted Assistant bodies while retaining Markdown fallback, actions, errors and live rendering', async () => {
    const messages = rows(4)
    messages[0]!.text = '**literal user**'
    messages[1] = { ...messages[1]!, text: '**Markdown fallback**', error: 'saved error', stopped: true }
    const view = mount('body-extension', messages)
    view.store.set(streamingFamily('body-extension'), {
      messageId: 'live-message', content: 'live response', toolCalls: [], blocks: [{ type: 'text', text: 'live response' }], startedAt: 1,
    })
    const rendered = new Set<string>()
    await view.render({ renderAssistantBody: (message, defaultBody) => {
      rendered.add(message.messageId!)
      return message.turnId === 'turn-0' ? defaultBody : <div data-testid="custom-reply">Debug reply</div>
    } })
    expect(view.host.querySelector('strong')?.textContent).toBe('Markdown fallback')
    expect(view.host.textContent).toContain('**literal user**')
    expect(view.host.textContent).toContain('saved error')
    expect(view.host.textContent).toContain('本次生成已停止')
    expect(view.host.querySelector('[data-testid="custom-reply"]')).not.toBeNull()
    expect(view.host.querySelectorAll('button[aria-label="反馈"]')).toHaveLength(2)
    expect(rendered).toEqual(new Set(['turn-message-1', 'turn-message-3']))
    expect(view.host.textContent).toContain('live response')
    await view.unmount()
  })

  it('preserves the pending human interaction state when an extension uses the default body', async () => {
    const messages = rows(2)
    messages[1] = { ...messages[1]!, text: '', finalAnswer: '', blocks: [{ type: 'thinking', text: 'Plan' }, { type: 'text', text: 'Choose an option' }] }
    const view = mount('body-human-request', messages)
    view.store.set(setHumanRequestAtom, {
      sessionId: 'body-human-request', kind: 'choose', requestId: 'choice',
      questions: [{ question: 'Which?', options: [{ label: 'One' }, { label: 'Two' }] }],
    })
    await view.render({ renderAssistantBody: (_message, defaultBody) => defaultBody })
    const processLabel = [...view.host.querySelectorAll('span')].find((element) => element.textContent === '执行过程')
    expect(processLabel?.parentElement?.firstElementChild?.className).toContain('rotate-90')
    expect(view.host.querySelectorAll('button[aria-label="反馈"]')).toHaveLength(0)
    expect(view.host.textContent).toContain('等待你的回答')
    await view.unmount()
  })

  it('mounts a hidden Turn, expands its nested details, and reveals the same target again with a new nonce', async () => {
    const view = mount('reveal-tail', rows(MESSAGE_TAIL_CHUNK * 2))
    const props: PipelineProps = {
      renderAssistantBody: (message, body) => message.turnId === 'turn-1'
        ? <details><summary>Round</summary><div id="target-round" tabIndex={-1}>{body}</div></details>
        : body,
    }
    await view.render(props)
    expect(view.host.querySelector('[data-message-turn="turn-1"]')).toBeNull()
    await view.render({ ...props, revealRequest: { sessionId: 'reveal-tail', turnId: 'turn-1', targetId: 'target-round', nonce: 1 } })
    await flushFrames()
    const target = view.host.querySelector<HTMLElement>('#target-round')!
    expect(scrolled).toEqual([target])
    expect(target.closest('details')?.open).toBe(true)
    expect(document.activeElement).toBe(target)
    await view.render({ ...props, revealRequest: { sessionId: 'reveal-tail', turnId: 'turn-1', targetId: 'target-round', nonce: 2 } })
    await flushFrames()
    expect(scrolled).toEqual([target, target])
    await view.unmount()
  })

  it('joins an in-flight sentinel page and pages further before revealing an older Turn', async () => {
    const view = mount('reveal-paging', rows(2, 'recent'))
    installBackend(view.store)
    view.store.set(transcriptPagingFamily('reveal-paging'), { hasMore: true, nextBefore: 300 })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let requests = 0
    globalThis.fetch = mock(async () => {
      requests += 1
      if (requests === 1) await gate
      return new Response(JSON.stringify({
        messages: requests === 1 ? rows(150, 'middle') : rows(2, 'old'),
        has_more: requests === 1,
        next_before: requests === 1 ? 150 : null,
      }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const failed = mock(() => {})
    await view.render()
    await act(async () => FakeIntersectionObserver.latest!.fire())
    await view.render({ revealRequest: { sessionId: 'reveal-paging', turnId: 'old-0', nonce: 1 }, onRevealFailed: failed })
    expect(failed).not.toHaveBeenCalled()
    expect(requests).toBe(1)
    await act(async () => { release(); await Promise.resolve(); await Promise.resolve() })
    await flushFrames()
    expect(requests).toBe(2)
    expect(failed).not.toHaveBeenCalled()
    expect(scrolled.at(-1)?.dataset.messageTurn).toBe('old-0')
    await view.unmount()
  })

  it('ignores a request for another Session and cancels paging scrolls when the viewed Session changes', async () => {
    const view = mount('reveal-source', rows(2))
    installBackend(view.store)
    view.store.set(transcriptPagingFamily('reveal-source'), { hasMore: true, nextBefore: 5 })
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    globalThis.fetch = mock(async () => {
      await gate
      return new Response(JSON.stringify({ messages: rows(2, 'old'), has_more: false }), { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const failed = mock(() => {})
    await view.render({ revealRequest: { sessionId: 'other', turnId: 'turn-0', nonce: 1 }, onRevealFailed: failed })
    await flushFrames()
    expect(scrolled).toHaveLength(0)
    await view.render({ revealRequest: { sessionId: 'reveal-source', turnId: 'old-0', nonce: 2 }, onRevealFailed: failed })
    await act(async () => {
      view.store.set(activeSessionIdAtom, 'reveal-destination')
      view.store.set(messageFamily('reveal-destination'), rows(2, 'destination'))
      release()
      await Promise.resolve()
    })
    await flushFrames()
    expect(scrolled).toHaveLength(0)
    expect(failed).not.toHaveBeenCalled()
    expect(view.host.textContent).toContain('destination-body-1')
    await view.unmount()
  })

  it('cancels a scheduled reveal on a newer request and reports a missing Turn once', async () => {
    const view = mount('reveal-replaced', rows(4))
    await view.render({ revealRequest: { sessionId: 'reveal-replaced', turnId: 'turn-0', nonce: 1 } })
    await view.render({ revealRequest: { sessionId: 'reveal-replaced', turnId: 'turn-1', nonce: 2 } })
    await flushFrames()
    expect(scrolled.map((element) => element.dataset.messageTurn)).toEqual(['turn-1'])
    const failed = mock(() => {})
    await view.render({ revealRequest: { sessionId: 'reveal-replaced', turnId: 'missing', nonce: 3 }, onRevealFailed: failed })
    expect(failed).toHaveBeenCalledTimes(1)
    await view.unmount()
    await flushFrames()
    expect(scrolled).toHaveLength(1)
  })

  it('cancels stale send animations and stays at the revealed Turn when later content arrives', async () => {
    const messages = rows(3)
    const view = mount('reveal-scroll-intent', messages)
    await view.render()
    const container = view.host.querySelector<HTMLElement>('[aria-label="消息列表"]')
      ?? view.host.querySelector<HTMLElement>('.overflow-auto')!
    Object.defineProperties(container, { scrollHeight: { value: 1000 }, clientHeight: { value: 100 } })
    container.scrollTop = 900
    HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); container.scrollTop = 220 }
    await view.render({ revealRequest: { sessionId: 'reveal-scroll-intent', turnId: 'turn-0', nonce: 1 } })
    await flushFrames()
    expect(container.scrollTop).toBe(220)
    await act(async () => container.dispatchEvent(new Event('scroll')))
    await act(async () => view.store.set(messageFamily('reveal-scroll-intent'), [...messages, rows(4)[3]!]))
    await flushFrames()
    expect(container.scrollTop).toBe(220)
    await view.unmount()
  })

  it('does not scroll or report a failure after a scheduled reveal is unmounted', async () => {
    const view = mount('reveal-unmount', rows(2))
    const failed = mock(() => {})
    await view.render({ revealRequest: { sessionId: 'reveal-unmount', turnId: 'turn-0', nonce: 1 }, onRevealFailed: failed })
    await view.unmount()
    await flushFrames()
    expect(scrolled).toHaveLength(0)
    expect(failed).not.toHaveBeenCalled()
  })
})
