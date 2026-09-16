import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { AgentEvent, AgentMessage } from '@shared/types'
import type { DesktopDebugTurn } from '@shared/debug-types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider, useAtomValue } = await import('jotai')
const { AgentRole } = await import('@shared/types')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { applyAgentEventAtom, messageFamily, prepareInteractionContinuationAtom, agentEventObserverAtom } = await import('@/atoms/agent')
const { DebugSessionProvider } = await import('../DebugSessionProvider')
const { DebugConversation } = await import('../DebugConversation')
const { liveDebugTurnsFamily } = await import('../live-trace-state')

const originalFetch = globalThis.fetch
const mounted: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  await act(async () => { for (const root of mounted.splice(0)) root.unmount() })
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})
afterAll(async () => { await GlobalRegistrator.unregister() })

const usage: AgentEvent = { type: 'context_usage', usage: {
  modelId: 'test-model', inputTokens: 20, outputTokens: 5, cachedInputTokens: 0,
  usedTokens: 20, usableTokens: 100, percentage: 20, source: 'provider',
  breakdown: { systemPromptTokens: 0, dynamicContextTokens: 0, toolSchemaTokens: 0, sessionHistoryTokens: 0, currentInputTokens: 20 },
} }
const start = (messageId: string): AgentEvent => ({ type: 'message_start', messageId, role: 'assistant' })
const text = (text: string, messageId = 'm'): AgentEvent => ({ type: 'text_delta', messageId, text })
const user = (id: string): AgentMessage => ({ id, role: AgentRole.User, text: 'Test request', toolCalls: [], done: true, createdAt: 1 })
const savedRow: DesktopDebugTurn = {
  id: 't', sessionId: 's', sessionOrdinal: 0, status: 'completed', createdAt: '2026-09-16T00:00:00Z',
  userInput: 'Test request', finalAnswer: 'First', error: null, executionMode: null, maxRounds: null, model: 'test-model',
  durationMs: 100, otaContext: null, otaContextSource: 'stored', agentState: null, contextUsage: null,
  otaRecords: [{ think_result: { step_content: 'First', tool_calls: [] } }],
}

async function mount() {
  const store = createStore()
  store.set(settingsAtom, { ...store.get(settingsAtom), locale: 'en' })
  store.set(activeSessionIdAtom, 's')
  store.set(messageFamily('s'), [user('u-local')])
  let rows: DesktopDebugTurn[] = []
  globalThis.fetch = (async (input: string | URL | Request) => {
    let address: string
    if (typeof input === 'string') address = input
    else address = input instanceof URL ? input.href : input.url
    const url = new URL(address, 'http://debug.test')
    const id = url.pathname.split('/')[3]!
    return Response.json({ sessionId: id, turns: rows.filter(turn => turn.sessionId === id), hasMore: false, nextCursor: null })
  }) as typeof fetch
  function View() {
    const sessionId = useAtomValue(activeSessionIdAtom)
    return sessionId ? <DebugConversation sessionId={sessionId} /> : null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mounted.push(root)
  await act(async () => root.render(<Provider store={store}><DebugSessionProvider><View /></DebugSessionProvider></Provider>))
  return { store, host, setRows: (value: DesktopDebugTurn[]) => { rows = value },
    send: async (events: AgentEvent[], sessionId = 's') => act(async () => {
      for (const event of events) store.set(applyAgentEventAtom, { sessionId, event })
    }) }
}

describe('debug streaming execution cards', () => {
  test('keeps saved cards inspectable while a later turn refreshes history', async () => {
    const view = await mount()
    await view.send([start('m'), text('First'), usage, { type: 'message_stop', messageId: 'm', finalAnswer: 'First' }])
    view.setRows([savedRow])
    await act(async () => view.store.set(messageFamily('s'), [user('u-local'), {
      id: 'saved-m', turnId: 't', role: AgentRole.Assistant, text: 'First', finalAnswer: 'First',
      toolCalls: [], done: true, createdAt: 2,
    }]))
    const firstDetails = () => view.host.querySelector<HTMLButtonElement>('.debug-round-card > summary > button')!
    expect(firstDetails().disabled).toBe(false)
    globalThis.fetch = (() => new Promise<Response>(() => {})) as unknown as typeof fetch
    await act(async () => view.store.set(messageFamily('s'), [...view.store.get(messageFamily('s')), user('u-next')]))
    await view.send([start('next')])
    expect(firstDetails().disabled).toBe(false)
    expect(view.host.querySelectorAll('[data-live-trace]')).toHaveLength(1)
  })

  test('preserves the transcript when resumed before debug history loads, then adopts complete records', async () => {
    const view = await mount()
    const oldTool = { type: 'tool' as const, toolUseId: 'old-call', name: 'read_file', input: { path: 'old.txt' },
      result: { output: 'Earlier file contents', isError: false, durationMs: 12 } }
    await act(async () => view.store.set(messageFamily('s'), [user('u-local'), {
      id: 'saved-m', turnId: 't', role: AgentRole.Assistant, text: 'Earlier work',
      blocks: [{ type: 'thinking', text: 'Earlier reasoning' }, { type: 'text', text: 'Earlier work' }, oldTool],
      toolCalls: [oldTool], done: true, createdAt: 2,
    }]))
    await act(async () => view.store.set(prepareInteractionContinuationAtom, { sessionId: 's' }))
    await view.send([start('next'), text('Continuing', 'next'), usage])
    const fallback = view.host.querySelector<HTMLDetailsElement>('.debug-product-trace')
    expect(fallback?.open).toBe(true)
    expect(fallback?.textContent).toContain('Earlier work')
    expect(fallback?.textContent).toContain('Earlier reasoning')
    expect(fallback?.textContent).toContain('old.txt')
    expect(view.host.querySelector('.debug-round-card')?.textContent).toContain('Continuing')
    view.setRows([{ ...savedRow, finalAnswer: 'Continuing', otaRecords: [
      { reasoning_content: 'Earlier reasoning', think_result: { step_content: 'Earlier work', tool_calls: [
        { call_id: 'old-call', tool: 'read_file', tool_arguments: { path: 'old.txt' } },
      ] }, action_result: { results: [{ tool_id: 'old-call', tool_name: 'read_file', tool_result: 'Earlier file contents', success: true }] } },
      { think_result: { step_content: 'Continuing', tool_calls: [] } },
    ] }])
    await view.send([{ type: 'message_stop', messageId: 'next', finalAnswer: 'Continuing' }])
    await act(async () => view.store.set(messageFamily('s'), view.store.get(messageFamily('s')).map(message =>
      message.id === 'next' ? { ...message, id: 'saved-next', turnId: 't' } : message)))
    expect(view.host.querySelector('[data-live-trace]')).toBeNull()
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(2)
    expect(view.host.querySelector('.debug-round-card')?.textContent).toContain('Earlier work')
  })

  test('retains every card across consecutive continuations while the saved trace lags behind', async () => {
    const view = await mount()
    await view.send([start('m'), text('First'), usage, { type: 'message_stop', messageId: 'm', finalAnswer: '' }])
    view.setRows([savedRow])
    await act(async () => view.store.set(messageFamily('s'), view.store.get(messageFamily('s')).map(message =>
      message.id === 'm' ? { ...message, id: 'server-first', turnId: 't' } : message)))
    await act(async () => view.store.set(prepareInteractionContinuationAtom, { sessionId: 's' }))
    await view.send([start('second'), text('Second', 'second'), usage, { type: 'message_stop', messageId: 'second', finalAnswer: '' }])
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(2)
    await act(async () => {
      view.store.set(messageFamily('s'), view.store.get(messageFamily('s')).map(message =>
        message.id === 'second' ? { ...message, id: 'server-second', turnId: 't' } : message))
      view.store.set(prepareInteractionContinuationAtom, { sessionId: 's' })
    })
    await view.send([start('third'), text('Third', 'third'), usage])
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(3)
    expect(view.host.querySelectorAll('.debug-round-card')[1]!.textContent).toContain('Second')
    expect(view.host.querySelector('.debug-product-trace')).toBeNull()
  })

  test('renders immediately and preserves every round when multiple events arrive in one React batch', async () => {
    const view = await mount()
    await view.send([start('m')])
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(1)
    expect(view.host.querySelector('.debug-round-card')?.textContent).toContain('Running')
    await view.send([
      { type: 'stage', position: { mode: 'normal', stage: null } },
      { type: 'thinking_delta', messageId: 'm', text: 'Reasoning' }, text('First response'), usage,
      { type: 'tool_call', messageId: 'm', toolUseId: 'a', toolName: 'read_file', input: { path: 'a.txt' } },
      { type: 'tool_call', messageId: 'm', toolUseId: 'b', toolName: 'read_file', input: { path: 'b.txt' } },
    ])
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(1)
    expect(view.host.querySelectorAll('.debug-live-tool')).toHaveLength(2)
    expect(view.host.querySelector('.debug-round-card')?.textContent).toContain('Reasoning')
    expect(view.host.querySelector('.debug-metrics')?.textContent).toContain('20')
    await view.send([
      { type: 'tool_result', toolUseId: 'b', output: 'Missing', isError: true, durationMs: 12 },
      { type: 'tool_result', toolUseId: 'a', output: 'File contents', isError: false, durationMs: 0 },
      text('Second response'), usage,
    ])
    const cards = view.host.querySelectorAll('.debug-round-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.textContent).toContain('First response')
    expect(cards[0]!.textContent).toContain('File contents')
    expect(cards[0]!.textContent).toContain('Failed')
    expect(cards[1]!.textContent).toContain('Second response')
    expect(view.host.querySelector('.debug-product-trace')).toBeNull()
    await act(async () => view.host.querySelectorAll<HTMLButtonElement>('.debug-view-switch button')[1]!.click())
    expect(view.host.querySelector('.debug-round-card')).toBeNull()
    expect(view.host.textContent).toContain('Second response')
    await act(async () => view.host.querySelectorAll<HTMLButtonElement>('.debug-view-switch button')[0]!.click())
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(2)
  })

  test('keeps settled cards until persisted rounds arrive, then replaces the live projection once', async () => {
    const view = await mount()
    await view.send([start('m'), text('First'), usage, text('Final'), usage,
      { type: 'message_stop', messageId: 'm', finalAnswer: 'Final' }])
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(2)
    expect(view.host.querySelectorAll('.debug-final-answer')).toHaveLength(0)
    view.setRows([{ id: 't', sessionId: 's', sessionOrdinal: 0, status: 'completed', createdAt: '2026-09-16T00:00:00Z',
      userInput: 'Test request', finalAnswer: 'Final', error: null, executionMode: null, maxRounds: null, model: 'test-model',
      durationMs: 100, otaContext: null, otaContextSource: 'stored', agentState: null, contextUsage: null,
      otaRecords: ['First', 'Final'].map(body => ({ think_result: { step_content: body, tool_calls: [] } })),
    }])
    await act(async () => view.store.set(messageFamily('s'), [user('u-local'), {
      id: 'persisted-message', turnId: 't', role: AgentRole.Assistant, text: 'Final', finalAnswer: 'Final',
      toolCalls: [], done: true, createdAt: 2,
    }]))
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(2)
    expect(view.host.querySelector('[data-live-trace]')).toBeNull()
    expect(view.host.querySelector<HTMLButtonElement>('.debug-round-card > summary > button')?.disabled).toBe(false)
  })

  test('keeps interrupted content and never turns a missing tool result into success', async () => {
    const view = await mount()
    await view.send([start('m'), text('Partial😀'),
      { type: 'model_retry', active: true, attempt: 1, maxRetries: 3, delaySeconds: 1, discardTextChars: 8, discardReasoningChars: 0 },
      text('Retry text'), usage,
      { type: 'tool_call', messageId: 'm', toolUseId: 'pending', toolName: 'read_file', input: {} },
      { type: 'message_stop', messageId: 'm', reason: 'cancelled' },
      { type: 'done', reason: 'cancelled', messageId: 'm' },
    ])
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(1)
    expect(view.host.querySelector('.debug-round-card')?.textContent).toContain('Retry text')
    expect(view.host.querySelector('.debug-round-card')?.textContent).not.toContain('Partial')
    expect(view.host.querySelector('.debug-live-tool')?.textContent).toContain('No result received')
    expect(view.host.querySelector('.debug-live-tool .debug-status-success')).toBeNull()
  })

  test('continues a paused reply without replaying its earlier cards or hiding the interaction', async () => {
    const view = await mount()
    await view.send([start('m'), text('Choose scope'), usage,
      { type: 'permission_request', requestId: 'approval', items: [], questions: [] },
      { type: 'message_stop', messageId: 'm', finalAnswer: '' }])
    expect(view.host.querySelector('.debug-round-card')?.textContent).toContain('Waiting for input')
    await act(async () => view.store.set(prepareInteractionContinuationAtom, { sessionId: 's' }))
    await view.send([start('resumed'), text('Continuing', 'resumed'), usage])
    const cards = view.host.querySelectorAll('.debug-round-card')
    expect(cards).toHaveLength(2)
    expect(cards[0]!.textContent).toContain('Choose scope')
    expect(cards[1]!.textContent).toContain('Continuing')
    expect(view.host.querySelectorAll('[data-message-role="ai"]')).toHaveLength(1)
  })

  test('isolates session switches while continuing to capture background events', async () => {
    const view = await mount()
    await view.send([start('m'), text('Session A')])
    await act(async () => view.store.set(activeSessionIdAtom, 'b'))
    await view.send([start('b-message'), text('Session B', 'b-message')], 'b')
    await view.send([usage, text('A next round')])
    expect(view.host.textContent).toContain('Session B')
    expect(view.host.textContent).not.toContain('Session A')
    await act(async () => view.store.set(activeSessionIdAtom, 's'))
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(2)
    expect(view.host.textContent).toContain('A next round')
    expect(view.host.textContent).not.toContain('Session B')
  })

  test('retains paused cards when transcript ids change before the trace request catches up', async () => {
    const view = await mount()
    await view.send([start('m'), text('Keep the paused response'), usage,
      { type: 'message_stop', messageId: 'm', finalAnswer: '' }])
    await act(async () => {
      const messages = view.store.get(messageFamily('s'))
      view.store.set(messageFamily('s'), messages.map(message => message.id === 'm'
        ? { ...message, id: 'server-message', turnId: 'server-turn' } : message))
      view.store.set(prepareInteractionContinuationAtom, { sessionId: 's' })
    })
    await view.send([start('next'), text('Resumed response', 'next'), usage])
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(2)
    expect(view.host.querySelectorAll('.debug-round-card')[0]!.textContent).toContain('Keep the paused response')
    expect(view.host.querySelectorAll('.debug-round-card')[1]!.textContent).toContain('Resumed response')
  })

  test('retains interactive Child Agent entries attached to a live tool call', async () => {
    const view = await mount()
    await view.send([start('m'), text('Delegating'), usage,
      { type: 'tool_call', messageId: 'm', toolUseId: 'delegate', toolName: 'call_subagent', input: {} },
      { type: 'subagent_event', invocationId: 'child-preview', parentToolCallId: 'delegate', mode: 'blocking', goal: 'Inspect files in child session', status: 'running', phase: 'started' },
    ])
    expect(view.host.querySelectorAll('.debug-round-card')).toHaveLength(1)
    expect([...view.host.querySelectorAll('button')].some(button => button.textContent?.includes('Inspect files in child session'))).toBe(true)
  })

  test('leaves the ordinary reducer free of debug state when no extension is mounted', () => {
    const store = createStore()
    expect(store.get(agentEventObserverAtom)).toBeNull()
    store.set(applyAgentEventAtom, { sessionId: 's', event: start('ordinary') })
    store.set(applyAgentEventAtom, { sessionId: 's', event: text('Ordinary', 'ordinary') })
    expect(store.get(liveDebugTurnsFamily('s'))).toEqual([])
  })
})
