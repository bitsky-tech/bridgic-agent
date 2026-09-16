import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { CognitiveRequest, DesktopDebugPromptResponse, PromptAssemblyInput } from '@shared/debug-prompt-types'
import type { DesktopDebugTurn } from '@shared/debug-types'
import { compareCognitiveRequests } from '../prompt-analysis-core'
import { validatePromptAnalysis } from '../prompt-analysis-client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider, useAtomValue } = await import('jotai')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { DebugSessionProvider, useDebugSession } = await import('../DebugSessionProvider')
const { DebugPromptsPanel } = await import('../DebugPromptsPanel')
const originalFetch = globalThis.fetch
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard')
const mounted: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  await act(async () => { for (const root of mounted.splice(0)) root.unmount() })
  globalThis.fetch = originalFetch
  if (originalClipboard) Object.defineProperty(navigator, 'clipboard', originalClipboard)
  else Reflect.deleteProperty(navigator, 'clipboard')
  document.body.replaceChildren()
})
afterAll(async () => { await GlobalRegistrator.unregister() })

function request(): CognitiveRequest {
  return { schemaVersion: 1, kind: 'cognitive', providerId: 'provider', modelId: 'model', protocol: 'chat_completions',
    messages: [{ role: 'system', blocks: [{ type: 'text', text: 'Current Cognitive system prompt' }], extras: {} },
      { role: 'assistant', blocks: [{ type: 'tool_call', id: 'call-budget', name: 'read_file', arguments: { path: '/tmp/budget.csv' } }], extras: { encrypted_reasoning: 'OPAQUE_REPLAY_SENTINEL' } },
      { role: 'tool', blocks: [{ type: 'tool_result', id: 'call-budget', content: 'Budget balance: 420' }], extras: {} }],
    tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    extraBody: { temperature: 0.25, reasoning: { effort: 'high' } } }
}
function fixture(sessionId = 'a', input: PromptAssemblyInput = { turnId: `${sessionId}-turn-0`, roundIndex: 0, stage: 'main', mode: 'normal' }): DesktopDebugPromptResponse {
  return { sessionId, item: { id: `${input.turnId}:${input.roundIndex}`, ...input,
    turnOrdinal: Number(input.turnId.split('-').at(-1)), availability: 'assembled', request: request() } }
}
function traceTurns(sessionId: string): DesktopDebugTurn[] {
  return [1, 0].map(ordinal => ({ id: `${sessionId}-turn-${ordinal}`, sessionId, sessionOrdinal: ordinal, status: 'completed', createdAt: '2026-09-15T01:00:00Z',
    userInput: `Task ${ordinal}`, finalAnswer: null, error: null, executionMode: null, maxRounds: null, model: 'model', durationMs: null,
    otaContext: null, otaContextSource: 'unavailable', agentState: null, contextUsage: null,
    otaRecords: Array.from({ length: ordinal ? 3 : 1 }, (_, index) => ({
      think_scope: { mode: 'normal', stage: ordinal ? 'clarify' : 'main' }, think_result: { step_content: `Response ${index}`, tool_calls: [] },
    })) }))
}
function requestUrl(input: string | URL | Request) {
  if (typeof input === 'string') return new URL(input, 'http://debug.test')
  return new URL(input instanceof URL ? input.href : input.url, 'http://debug.test')
}
function transport(read: (sessionId: string, input: PromptAssemblyInput) => Response = (sessionId, input) => Response.json(fixture(sessionId, input))) {
  const calls: { url: URL; init?: RequestInit }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = requestUrl(input)
    calls.push({ url, init })
    const sessionId = decodeURIComponent(url.pathname.split('/')[url.pathname.startsWith('/api/') ? 4 : 3]!)
    return url.pathname.endsWith('/prompts') ? read(sessionId, JSON.parse(String(init?.body)))
      : Response.json({ sessionId, turns: traceTurns(sessionId), nextCursor: null, hasMore: false })
  }) as typeof fetch
  return calls
}
async function mount(active = true) {
  const store = createStore()
  store.set(activeSessionIdAtom, 'a')
  store.set(settingsAtom, { ...store.get(settingsAtom), locale: 'en' })
  store.set(backendSnapshotAtom, { ...store.get(backendSnapshotAtom), endpoint: {
    baseUrl: 'http://daemon.test:7421', token: 'debug-token', clientId: 'desktop-test', version: null, startedAt: null, wsPath: '/ws', runtimeFile: null, logFile: null,
  } })
  let current!: ReturnType<typeof useDebugSession>
  function Probe({ shown }: { shown: boolean }) {
    current = useDebugSession()
    const sessionId = useAtomValue(activeSessionIdAtom)
    return sessionId ? <DebugPromptsPanel sessionId={sessionId} active={shown} onClose={() => undefined} /> : null
  }
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  mounted.push(root)
  const render = async (shown: boolean) => act(async () => {
    root.render(<Provider store={store}><DebugSessionProvider><Probe shown={shown} /></DebugSessionProvider></Provider>)
    await Promise.resolve()
  })
  await render(active)
  return { host, render, get current() { return current }, switchSession: async (id: string) => act(async () => { store.set(activeSessionIdAtom, id); await Promise.resolve() }) }
}
async function press(button: HTMLButtonElement | undefined | null) {
  expect(button).toBeDefined(); expect(button).not.toBeNull()
  await act(async () => button!.click())
}

describe('on-demand Cognitive Prompt analysis', () => {
  test('lists trace rounds chronologically and assembles only the selected round using the authenticated API', async () => {
    const calls = transport()
    const view = await mount()
    expect(calls.some(call => call.url.pathname.endsWith('/prompt-capture') || call.url.pathname.endsWith('/prompts'))).toBe(false)
    const groups = [...view.host.querySelectorAll('.debug-prompt-turn')]
    expect(groups.map(group => group.querySelector('h4')?.textContent)).toEqual(['Turn 1', 'Turn 2'])
    expect(groups.map(group => [...group.querySelectorAll('.debug-prompt-request-identity code')].map(code => code.textContent))).toEqual([['R01'], ['R01', 'R02', 'R03']])
    await press(groups[1]!.querySelectorAll<HTMLButtonElement>('.debug-prompt-request-open')[2])
    const reads = calls.filter(call => call.url.pathname.endsWith('/prompts'))
    expect(reads).toHaveLength(1)
    expect(reads[0]!.url.href).toBe('http://daemon.test:7421/api/debug/sessions/a/prompts')
    expect(reads[0]!.init?.method).toBe('POST')
    expect(JSON.parse(String(reads[0]!.init?.body))).toEqual({ turnId: 'a-turn-1', roundIndex: 2, stage: 'clarify', mode: 'normal' })
    expect(reads[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer debug-token', 'X-Client-Id': 'desktop-test' })
    expect(view.host.textContent).toContain('current Cognitive code')
    expect(view.host.textContent).toContain('not a saved historical request')
  })

  test('does not assemble while hidden or merely browsing the round list', async () => {
    const calls = transport()
    const view = await mount(false)
    await view.render(true)
    expect(calls.filter(call => call.url.pathname.endsWith('/prompts'))).toHaveLength(0)
    await view.render(false)
    await act(async () => view.current.inspect('prompts', view.current.records.rounds[0]!.id))
    expect(calls.filter(call => call.url.pathname.endsWith('/prompts'))).toHaveLength(0)
    await view.render(true)
    expect(calls.filter(call => call.url.pathname.endsWith('/prompts'))).toHaveLength(1)
  })

  test('deep-links the requested round and copies every native field in the assembled response', async () => {
    transport()
    const copied: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { copied.push(value) } } })
    const view = await mount()
    const round = view.current.records.rounds.find(item => item.turnOrdinal === 1 && item.ordinal === 3)!
    await act(async () => view.current.inspect('prompts', round.id))
    expect(view.host.querySelector('.debug-inspector-source h4')?.textContent).toBe('Turn 2 · R03')
    expect(view.host.querySelectorAll('.debug-prompt-message')).toHaveLength(3)
    expect(view.host.textContent).toContain('Budget balance: 420')
    expect(view.host.textContent).toContain('OPAQUE_REPLAY_SENTINEL')
    await press(view.host.querySelector<HTMLButtonElement>('[aria-label="Copy request"]'))
    expect(JSON.parse(copied[0]!)).toEqual(request())
    await press(view.host.querySelector<HTMLButtonElement>('.debug-inspector-source .debug-inspector-actions button'))
    expect(view.current.selection).toMatchObject({ kind: 'rounds', id: round.id, sessionId: 'a' })
  })

  test('assembles only the chosen baseline when comparing requests', async () => {
    const calls = transport((sessionId, input) => {
      const data = fixture(sessionId, input)
      if (input.roundIndex === 2) data.item.request.extraBody = { temperature: 0.8 }
      return Response.json(data)
    })
    const view = await mount()
    const round = view.current.records.rounds.find(item => item.turnOrdinal === 1 && item.ordinal === 3)!
    await act(async () => view.current.inspect('prompts', round.id))
    await press([...view.host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === 'Compare requests'))
    const reads = calls.filter(call => call.url.pathname.endsWith('/prompts'))
    expect(reads.map(call => JSON.parse(String(call.init?.body)).roundIndex)).toEqual([2, 1])
    expect([...view.host.querySelectorAll('select option')]).toHaveLength(3)
    const sections = [...view.host.querySelectorAll('.debug-prompt-diff-section')]
    expect(sections).toHaveLength(1)
    expect(sections[0]!.querySelector('h4')?.textContent).toBe('Extra body')
  })

  test('shows backend assembly errors and retries without showing a fake request', async () => {
    let fail = true
    const calls = transport((sessionId, input) => fail ? Response.json({ detail: 'Unsupported worker' }, { status: 422 }) : Response.json(fixture(sessionId, input)))
    const view = await mount()
    await press(view.host.querySelector<HTMLButtonElement>('.debug-prompt-request-open'))
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Could not assemble Prompt')
    expect(view.host.querySelector('[aria-label="Copy request"]')).toBeNull()
    fail = false
    await press(view.host.querySelector<HTMLButtonElement>('[role="alert"] button'))
    expect(calls.filter(call => call.url.pathname.endsWith('/prompts'))).toHaveLength(2)
    expect(view.host.querySelector('[aria-label="Copy request"]')).not.toBeNull()
  })

  test('aborts old Session assembly and ignores late responses after switching', async () => {
    const pending: { sessionId: string; input: PromptAssemblyInput; signal: AbortSignal; resolve: (data: DesktopDebugPromptResponse) => void }[] = []
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = requestUrl(input)
      const sessionId = decodeURIComponent(url.pathname.split('/')[url.pathname.startsWith('/api/') ? 4 : 3]!)
      if (!url.pathname.endsWith('/prompts')) return Promise.resolve(Response.json({ sessionId, turns: traceTurns(sessionId), nextCursor: null, hasMore: false }))
      return new Promise<Response>(resolve => pending.push({ sessionId, input: JSON.parse(String(init?.body)), signal: init!.signal as AbortSignal, resolve: data => resolve(Response.json(data)) }))
    }) as typeof fetch
    const view = await mount()
    await press(view.host.querySelector<HTMLButtonElement>('.debug-prompt-request-open'))
    const old = pending[0]!
    await view.switchSession('b')
    expect(old.signal.aborted).toBe(true)
    await press(view.host.querySelector<HTMLButtonElement>('.debug-prompt-request-open'))
    const current = pending.at(-1)!
    await act(async () => current.resolve(fixture('b', current.input)))
    await act(async () => old.resolve(fixture('a', old.input)))
    expect(view.host.querySelector('[aria-label="Copy request"]')).not.toBeNull()
    expect(view.current.sessionId).toBe('b')
  })

  test('compares tools, extra body and provider extras independently from unchanged messages', () => {
    const before = request()
    const after = structuredClone(before)
    after.tools = [{ name: 'write_file', parameters: { type: 'object' } }]
    after.extraBody = { temperature: 0.75 }
    let differences = compareCognitiveRequests(before, after)
    expect(differences.filter(item => item.kind === 'message').every(item => item.status === 'same')).toBe(true)
    expect(differences.find(item => item.kind === 'tools')?.status).toBe('changed')
    expect(differences.find(item => item.kind === 'extraBody')?.status).toBe('changed')
    after.messages[1] = { role: 'assistant', blocks: [], extras: { encrypted_reasoning: 'changed' } }
    differences = compareCognitiveRequests(before, after)
    expect(differences.find(item => item.id === 'message:1')?.status).toBe('changed')
  })

  test('rejects responses for another Session, round or scope and missing requests', () => {
    const input = { turnId: 'a-turn-0', roundIndex: 0, mode: 'normal', stage: 'main' }
    expect(() => validatePromptAnalysis(fixture('foreign', input), 'a', input)).toThrow()
    for (const patch of [{ roundIndex: 1 }, { stage: 'clarify' }, { mode: 'presentation' }, { turnId: 'another' }]) {
      expect(() => validatePromptAnalysis(fixture('a', { ...input, ...patch }), 'a', input)).toThrow()
    }
    const missing = fixture('a', input)
    Reflect.set(missing.item, 'request', null)
    expect(() => validatePromptAnalysis(missing, 'a', input)).toThrow()
  })
})
