import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AgentMessage } from '@/atoms/agent'
import type { DesktopDebugTurn } from '@shared/debug-types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { AgentRole } = await import('@shared/types')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { messageFamily } = await import('@/atoms/agent')
const { DebugConversation } = await import('../DebugConversation')
const { DebugSessionProvider } = await import('../DebugSessionProvider')

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})
afterAll(async () => { await GlobalRegistrator.unregister() })

function message(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return { id: 'assistant-1', turnId: 'turn-1', role: AgentRole.Assistant, text: 'Transcript response',
    toolCalls: [], done: true, createdAt: 1, ...overrides }
}

function turn(otaRecords: unknown): DesktopDebugTurn {
  return { id: 'turn-1', sessionId: 'debug-content-session', sessionOrdinal: 1, status: 'completed',
    createdAt: '2026-09-11T00:00:00Z', userInput: 'Question', finalAnswer: null, error: null,
    executionMode: null, maxRounds: null, model: 'stored-model', durationMs: 25,
    otaRecords, otaContext: null, otaContextSource: 'unavailable', agentState: null, contextUsage: null }
}

function round(body: string) {
  return { think_result: { step_content: body, tool_calls: [] }, action_result: { results: [] } }
}

async function mount(messages: AgentMessage[], storedTurn: DesktopDebugTurn) {
  const store = createStore()
  store.set(activeSessionIdAtom, storedTurn.sessionId)
  store.set(messageFamily(storedTurn.sessionId), messages)
  globalThis.fetch = (async (input: string | URL | Request) => {
    let url: string
    if (typeof input === 'string') url = input
    else if (input instanceof URL) url = input.href
    else url = input.url
    if (!url.startsWith('/__debug-api/sessions/')) throw new Error(`Unexpected test fetch: ${url}`)
    return new Response(JSON.stringify({ sessionId: storedTurn.sessionId, turns: [storedTurn], nextCursor: null, hasMore: false }), {
      headers: { 'content-type': 'application/json' },
    })
  }) as typeof fetch
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<Provider store={store}><DebugSessionProvider><DebugConversation sessionId={storedTurn.sessionId} /></DebugSessionProvider></Provider>)
    await Promise.resolve()
  })
  return { host, unmount: async () => act(async () => root.unmount()) }
}

describe('DebugConversation content preservation', () => {
  it('uses the shared Markdown file links for recorded model output and the final answer', async () => {
    const body = '**Prepared draft** [Draft](file:///tmp/debug-draft.txt)'
    const finalAnswer = 'Delivered [Final artifact](file:///tmp/debug-final.txt)'
    const view = await mount([message({ text: finalAnswer, finalAnswer })], turn([round(body)]))
    expect(view.host.querySelector('.debug-round-body strong')?.textContent).toBe('Prepared draft')
    expect(view.host.querySelector('a[href="/tmp/debug-draft.txt"]')?.textContent).toBe('Draft')
    expect(view.host.querySelector('a[href="/tmp/debug-final.txt"]')?.textContent).toBe('Final artifact')
    expect(view.host.querySelectorAll('a[href="/tmp/debug-final.txt"]')).toHaveLength(1)
    expect(view.host.querySelector('button[aria-label*="debug-final.txt"]')).not.toBeNull()
    await act(async () => view.host.querySelectorAll<HTMLButtonElement>('.debug-view-switch button')[1]!.click())
    expect(view.host.querySelector('.debug-turn-tree')).toBeNull()
    expect(view.host.querySelector('a[href="/tmp/debug-final.txt"]')?.textContent).toBe('Final artifact')
    expect(view.host.querySelectorAll('button[aria-label="反馈"], button[aria-label="Feedback"]')).toHaveLength(1)
    await view.unmount()
  })

  it('retains the original interaction card and its expand/collapse control alongside the trace', async () => {
    const view = await mount([message({
      text: 'Recorded final response', finalAnswer: 'Recorded final response',
      blocks: [
        { type: 'confirmation', question: 'Which scope?', response: '**Only current files**' },
        { type: 'text', text: 'Recorded final response' },
      ],
    })], turn([round('Recorded final response')]))
    const interaction = [...view.host.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')]
      .find((button) => button.textContent?.includes('Which scope?'))
    expect(interaction).toBeDefined()
    expect(interaction?.getAttribute('aria-expanded')).toBe('false')
    await act(async () => interaction!.click())
    expect(interaction?.getAttribute('aria-expanded')).toBe('true')
    expect([...view.host.querySelectorAll('strong')].some((element) => element.textContent === 'Only current files')).toBe(true)
    await act(async () => interaction!.click())
    expect(interaction?.getAttribute('aria-expanded')).toBe('false')
    const trace = view.host.querySelector('.debug-turn-tree')!
    expect(trace.compareDocumentPosition(interaction!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(view.host.querySelector('.debug-product-trace')).toBeNull()
    await view.unmount()
  })

  it('renders one trace for a legacy Turn with multiple Assistant messages while preserving the earlier reply', async () => {
    const view = await mount([
      message({ id: 'assistant-earlier', text: 'Earlier response must survive' }),
      message({ id: 'assistant-final', text: 'Recorded last response', finalAnswer: 'Recorded last response' }),
    ], turn([round('Recorded last response')]))
    expect(view.host.textContent).toContain('Earlier response must survive')
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(1)
    const ids = [...view.host.querySelectorAll('.debug-round-card[id]')].map((element) => element.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(view.host.querySelectorAll('[data-message-role="ai"]')).toHaveLength(2)
    await view.unmount()
  })

  for (const [name, otaRecords] of [
    ['missing OTA records', null],
    ['a round with no model body', [{}]],
    ['a tool-only round', [{ think_result: { tool_calls: [{ call_id: 'call-1', tool: 'read_file', tool_arguments: {} }] } }]],
  ] as const) {
    it(`keeps the original transcript with ${name}`, async () => {
      const view = await mount([message({ text: '**Original transcript** [Artifact](file:///tmp/preserved.txt)' })], turn(otaRecords))
      expect([...view.host.querySelectorAll('strong')].some((element) => element.textContent === 'Original transcript')).toBe(true)
      expect(view.host.querySelector('a[href="/tmp/preserved.txt"]')?.textContent).toBe('Artifact')
      if (otaRecords !== null) {
        const fallback = view.host.querySelector<HTMLDetailsElement>('.debug-product-trace')!
        const trace = view.host.querySelector('.debug-turn-tree')!
        expect(fallback.open).toBe(false)
        expect(fallback.querySelector('a[href="/tmp/preserved.txt"]')).not.toBeNull()
        expect(trace.compareDocumentPosition(fallback) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      }
      await view.unmount()
    })
  }

  it('preserves a transcript artifact from a missing OTA body even when another round has text', async () => {
    const view = await mount([message({ text: 'Recorded step\n\n[Additional artifact](file:///tmp/unrecorded-artifact.txt)', blocks: [
      { type: 'text', text: 'Recorded step' },
      { type: 'text', text: '[Additional artifact](file:///tmp/unrecorded-artifact.txt)' },
    ] })], turn([round('Recorded step'), {}]))
    expect(view.host.querySelector('a[href="/tmp/unrecorded-artifact.txt"]')?.textContent).toBe('Additional artifact')
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(2)
    const fallback = view.host.querySelector<HTMLDetailsElement>('.debug-product-trace')!
    expect(fallback.open).toBe(false)
    expect(fallback.querySelector('a[href="/tmp/unrecorded-artifact.txt"]')).not.toBeNull()
    expect(view.host.querySelector('.debug-turn-tree')!.compareDocumentPosition(fallback) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await view.unmount()
  })

  it('preserves Markdown-significant leading spaces in the final answer', async () => {
    const finalAnswer = '    const answer = 42\n    print(answer)'
    const view = await mount([message({ text: finalAnswer, finalAnswer })], turn([round('The output follows.')]))
    const code = view.host.querySelector('.debug-final-answer pre code')
    expect(code).not.toBeNull()
    expect(code?.textContent).toContain('const answer = 42')
    expect(code?.textContent).toContain('print(answer)')
    await view.unmount()
  })
})
