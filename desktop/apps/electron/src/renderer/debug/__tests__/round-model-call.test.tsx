import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { CreateDebugModelRun, DebugModelRun, DebugPromptResponse } from '@shared/debug-model-types'
import type { TraceRound } from '../types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Simulate } = await import('react-dom/test-utils')
const { createStore, Provider } = await import('jotai')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { settingsAtom } = await import('@/atoms/settings')
const { DebugDraftProvider } = await import('../DebugDrafts')
const { RoundModelCall } = await import('../RoundModelCall')
const { buildTraceRecords } = await import('../trace-records')
const originalFetch = globalThis.fetch
const roots: ReturnType<typeof createRoot>[] = []
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})
afterAll(async () => GlobalRegistrator.unregister())

function round(id = 'one', sessionId = 'a'): TraceRound {
  return buildTraceRecords([{ id, sessionId, sessionOrdinal: 0, status: 'completed', model: 'historical-model', durationMs: null, otaContext: null,
    otaRecords: [{ think_scope: { mode: 'normal', stage: 'main' }, think_result: { step_content: `Original output ${id}`, tool_calls: [] } }],
  }]).rounds[0]!
}

function assembled(value: TraceRound, content = 'Full system prompt'): DebugPromptResponse {
  return { sessionId: value.sessionId, item: { id: value.id, turnId: value.turnId, turnOrdinal: 0, roundIndex: 0,
    mode: 'normal', stage: 'main', revision: 'revision-1', availability: 'assembled', modelSource: 'round', boundary: 'cognitive_before_runtime_tail',
    request: { schemaVersion: 1, kind: 'cognitive', worker: 'NormalMain', modelId: 'historical-model', protocol: 'openai', providerId: 'openai',
      messages: [{ role: 'system', blocks: [{ block_type: 'text', text: content }], extras: {} },
        { role: 'user', blocks: [{ block_type: 'text', text: 'Native user input' }], extras: { fixture: 'preserved' } }], tools: [], extraBody: { temperature: 0.2 } } } }
}

async function mount(value: TraceRound) {
  const store = createStore()
  store.set(settingsAtom, { ...store.get(settingsAtom), locale: 'en' })
  store.set(backendSnapshotAtom, { ...store.get(backendSnapshotAtom), endpoint: { baseUrl: 'http://debug.test', token: 'fixture',
    version: null, startedAt: null, wsPath: null, runtimeFile: null, logFile: null } })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  async function render(next: TraceRound | null, sessionId = 'a') {
    await act(async () => root.render(<Provider store={store}><DebugDraftProvider sessionId={sessionId}>
      {next ? <RoundModelCall key={next.id} round={next} /> : <span>List</span>}
    </DebugDraftProvider></Provider>))
  }
  await render(value)
  return { host, render }
}

async function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.getAttribute('aria-label') === label || item.textContent?.trim() === label)
  expect(button).toBeDefined()
  await act(async () => button!.click())
}

function fixtureFetch(value: TraceRound, submit?: (body: CreateDebugModelRun) => Response) {
  const calls: { url: URL; body: Record<string, unknown> | null }[] = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : null
    calls.push({ url, body })
    if (url.pathname.endsWith('/prompts')) return Response.json(assembled(value))
    if (url.pathname.endsWith('/llm-runs') && init?.method === 'POST') return submit!(body)
    if (url.pathname.endsWith('/llm-runs')) return Response.json([])
    throw new Error(`Unexpected request ${url.pathname}`)
  }) as typeof fetch
  return calls
}

test('automatically assembles native messages, shows historical output and reuses cached assembly', async () => {
  const value = round()
  const calls = fixtureFetch(value)
  const view = await mount(value)
  expect(view.host.textContent).toContain('Full system prompt')
  expect(view.host.textContent).toContain('Native user input')
  expect(view.host.textContent).toContain('Original output one')
  expect(view.host.textContent).not.toContain('Call LLM once')
  expect(view.host.querySelector('.debug-request-item-navigation button')).toBeNull()
  await click(view.host, 'Debug experiment')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Ready when you are')
  await click(document.body, 'Close experiment')
  expect(calls.filter(item => item.url.pathname.endsWith('/prompts'))).toHaveLength(1)
  expect(calls.some(item => item.url.pathname.endsWith('/llm-runs') && item.body)).toBe(false)
  await view.render(null)
  await view.render(value)
  expect(calls.filter(item => item.url.pathname.endsWith('/prompts'))).toHaveLength(1)
})

test('edits native blocks, preserves drafts across navigation and submits a separate experiment', async () => {
  const value = round()
  let submitted: CreateDebugModelRun | undefined
  fixtureFetch(value, body => {
    submitted = body
    return Response.json({ id: 'run-1', sessionId: 'a', source: body.source, request: body.request, status: 'succeeded',
      content: 'Fresh model result', reasoning: 'Recorded reasoning', toolCalls: [{ name: 'read_file', arguments: { path: 'fixture' } }],
      usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 80 } }, durationMs: 1000, error: null,
      createdAt: '2026-09-16T00:00:00Z', retries: [] } satisfies DebugModelRun)
  })
  const view = await mount(value)
  await click(view.host, 'Debug experiment')
  const roles = document.body.querySelector<HTMLSelectElement>('[aria-label="Message 2 role"]')!
  expect([...roles.options].map(option => option.value)).toEqual(['system', 'user', 'assistant', 'tool'])
  let field = document.body.querySelector<HTMLTextAreaElement>('[aria-label="Message 2 · 1 content"]')!
  await act(async () => { field.value = 'Edited user prompt'; Simulate.change(field) })
  await view.render(null)
  await view.render(value)
  await click(view.host, 'Debug experiment')
  field = document.body.querySelector('[aria-label="Message 2 · 1 content"]')!
  expect(field.value).toBe('Edited user prompt')
  await click(document.body, 'Run experiment')
  expect(submitted!.source).toMatchObject({ turnId: 'one', roundIndex: 0, revision: 'revision-1' })
  expect(submitted!.request.messages[1]).toEqual({ role: 'user', blocks: [{ block_type: 'text', text: 'Edited user prompt' }], extras: { fixture: 'preserved' } })
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Fresh model result')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('80.0%')
  await click(document.body, 'Close experiment')
  expect(document.querySelector('[role="dialog"]')).toBeNull()
  expect(view.host.textContent).toContain('Original output one')
  expect(view.host.textContent).not.toContain('Fresh model result')
  await click(view.host, 'Debug experiment')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Fresh model result')
})

test('updates an untouched experiment opened during reassembly and submits the latest complete request', async () => {
  const value = round()
  let submitted: CreateDebugModelRun | undefined
  const calls = fixtureFetch(value, body => {
    submitted = body
    return Response.json({ id: 'refreshed-run', sessionId: 'a', source: body.source, request: body.request, status: 'succeeded',
      content: 'Refreshed result', reasoning: '', toolCalls: [], usage: null, durationMs: 100, error: null,
      createdAt: '2026-09-16T00:00:00Z', retries: [] } satisfies DebugModelRun)
  })
  const view = await mount(value)
  const baseFetch = globalThis.fetch
  let finishRefresh: (response: Response) => void = () => { throw new Error('Refresh has not started') }
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/prompts')) return new Promise<Response>(resolve => { finishRefresh = resolve })
    return baseFetch(input, init)
  }) as typeof fetch
  await click(view.host, 'Reassemble request')
  await click(view.host, 'Debug experiment')
  const systemPrompt = () => document.body.querySelector<HTMLTextAreaElement>('[aria-label="Message 1 · 1 content"]')!
  expect(systemPrompt().value).toBe('Full system prompt')
  await click(document.body, 'Run experiment')
  expect(calls.some(call => call.url.pathname.endsWith('/llm-runs') && call.body)).toBe(false)

  // Current resources can change without changing the historical round revision.
  const refreshed = assembled(value, 'Updated system prompt')
  Object.assign(refreshed.item.request, { modelId: 'new-model', providerId: 'new-provider', protocol: 'new-protocol',
    tools: [{ name: 'new_tool', description: 'New tool', parameters: { type: 'object', properties: {} } }], extraBody: { temperature: 0.8 } })
  await act(async () => finishRefresh(Response.json(refreshed)))
  expect(view.host.querySelector('.debug-message-block pre')!.textContent).toBe('Updated system prompt')
  expect(systemPrompt().value).toBe('Updated system prompt')
  const restore = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Restore assembled request')!
  expect(restore.disabled).toBe(true)
  await click(document.body, 'Run experiment')
  expect(submitted!.source.revision).toBe('revision-1')
  expect(submitted!.request).toEqual({ model: 'new-model', providerId: 'new-provider', protocol: 'new-protocol',
    messages: refreshed.item.request.messages, tools: refreshed.item.request.tools, extraBody: { temperature: 0.8 } })
})

test('preserves edited drafts and invalid JSON across reassembly, then restores the latest baseline', async () => {
  const value = round()
  fixtureFetch(value)
  const view = await mount(value)
  await click(view.host, 'Debug experiment')
  const message = () => document.body.querySelector<HTMLTextAreaElement>('[aria-label="Message 2 · 1 content"]')!
  const tools = () => document.body.querySelector<HTMLTextAreaElement>('[aria-label="tools"]')!
  await act(async () => { message().value = 'Keep my edits'; Simulate.change(message()); tools().value = '[ invalid'; Simulate.change(tools()) })
  await click(document.body, 'Close experiment')

  const baseFetch = globalThis.fetch
  const refreshed = assembled(value, 'New assembled baseline')
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => String(input).includes('/prompts')
    ? Response.json(refreshed) : baseFetch(input, init)) as typeof fetch
  await click(view.host, 'Reassemble request')
  await click(view.host, 'Debug experiment')
  expect(message().value).toBe('Keep my edits')
  expect(tools().value).toBe('[ invalid')
  expect(tools().getAttribute('aria-invalid')).toBe('true')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('The assembled request has changed')
  await view.render(null)
  await view.render(value)
  await click(view.host, 'Debug experiment')
  expect(message().value).toBe('Keep my edits')
  expect(tools().value).toBe('[ invalid')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('The assembled request has changed')

  await click(document.body, 'Restore assembled request')
  expect(message().value).toBe('Native user input')
  expect(document.body.querySelector<HTMLTextAreaElement>('[aria-label="Message 1 · 1 content"]')!.value).toBe('New assembled baseline')
  expect(tools().value).toBe('[]')
  expect(tools().getAttribute('aria-invalid')).toBe('false')
  expect(document.querySelector('[role="dialog"]')!.textContent).not.toContain('The assembled request has changed')
})

test('keeps historical output readable during assembly errors and rejects foreign results', async () => {
  const value = round()
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes('/prompts')) return Response.json(assembled(round('foreign', 'b')))
    return Response.json([])
  }) as typeof fetch
  const view = await mount(value)
  expect(view.host.textContent).toContain('Original output one')
  expect(view.host.textContent).toContain('different round or an invalid request')
  expect(view.host.textContent).not.toContain('Full system prompt')
})

test('aborts a stale assembly when switching rounds and never shows it in the next round', async () => {
  const pending: { signal: AbortSignal; resolve: (response: Response) => void }[] = []
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    if (String(input).includes('/prompts')) return new Promise<Response>(resolve => pending.push({ signal: init!.signal!, resolve }))
    return Promise.resolve(Response.json([]))
  }) as typeof fetch
  const view = await mount(round())
  expect(view.host.textContent).toContain('Assembling this round')
  await view.render(round('two'))
  expect(pending[0]!.signal.aborted).toBe(true)
  await act(async () => pending[1]!.resolve(Response.json(assembled(round('two'), 'Second prompt'))))
  await act(async () => pending[0]!.resolve(Response.json(assembled(round(), 'Stale prompt'))))
  expect(view.host.textContent).toContain('Second prompt')
  expect(view.host.textContent).not.toContain('Stale prompt')
})

test('streams result snapshots without concatenating them into historical output', async () => {
  const value = round()
  let run: DebugModelRun
  fixtureFetch(value, body => {
    run = { id: 'stream-run', sessionId: 'a', source: body.source, request: body.request, status: 'running', content: '', reasoning: '',
      toolCalls: [], usage: null, durationMs: null, error: null, createdAt: '2026-09-16T00:00:00Z', retries: [] }
    return Response.json(run)
  })
  const baseFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      for (const snapshot of [{ ...run, content: 'Hello' }, { ...run, content: 'Hello world', status: 'succeeded', durationMs: 600 }]) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(snapshot) + '\n'))
      }
      controller.close()
    } }))
    return baseFetch(input, init)
  }) as typeof fetch
  const view = await mount(value)
  await click(view.host, 'Debug experiment')
  await click(document.body, 'Run experiment')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Hello world')
  expect(document.body.textContent).not.toContain('HelloHello world')
  expect(view.host.textContent).toContain('Original output one')
})

test('reuses the submission ID after an uncertain response and inspector navigation', async () => {
  const value = round()
  const submitted: CreateDebugModelRun[] = []
  fixtureFetch(value, body => {
    submitted.push(body)
    if (submitted.length === 1) throw new Error('Connection interrupted after submission')
    return Response.json({ id: 'recovered-run', sessionId: 'a', source: body.source, request: body.request, status: 'succeeded',
      content: 'Recovered result', reasoning: '', toolCalls: [], usage: null, durationMs: 100, error: null,
      createdAt: '2026-09-16T00:00:00Z', retries: [] } satisfies DebugModelRun)
  })
  const view = await mount(value)
  await click(view.host, 'Debug experiment')
  await click(document.body, 'Run experiment')
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Connection interrupted')
  await view.render(null)
  await view.render(value)
  await click(view.host, 'Debug experiment')
  await click(document.body, 'Run experiment')
  expect(submitted).toHaveLength(2)
  expect(submitted[0]!.clientRequestId).toBe(submitted[1]!.clientRequestId)
  expect(document.querySelector('[role="dialog"]')!.textContent).toContain('Recovered result')
})

test('shows the complete native Message List in order with separate tool blocks and source identity', async () => {
  const value = round()
  const response = assembled(value)
  response.item.request.messages = [
    { role: 'system', blocks: [{ block_type: 'text', text: 'System prompt' }], extras: {} },
    { role: 'user', blocks: [{ block_type: 'text', text: 'Earlier user request' }], extras: {} },
    { role: 'ai', blocks: [{ block_type: 'text', text: 'Reading the file' }, { block_type: 'tool_call', id: 'call-42', name: 'read_file', arguments: { path: 'example.txt' } }], extras: { reasoning_content: 'Recorded thought' } },
    { role: 'tool', blocks: [{ block_type: 'tool_result', id: 'call-42', content: 'Full tool result\nSecond line' }], extras: {} },
    { role: 'user', blocks: [{ block_type: 'text', text: 'Current user request' }, { block_type: 'text', text: 'Additional context' }], extras: {} },
  ]
  const original = JSON.stringify(response.item.request.messages)
  globalThis.fetch = (async (input: string | URL | Request) => Response.json(String(input).includes('/prompts') ? response : [])) as typeof fetch
  const view = await mount(value)
  const list = view.host.querySelector('[aria-label="Message List"]')!
  const rows = [...list.querySelectorAll('li > button')]
  expect(rows).toHaveLength(5)
  expect(rows.map(row => row.querySelector('strong')!.textContent)).toEqual(['system', 'user', 'ai', 'tool', 'user'])
  expect(view.host.querySelectorAll('.debug-call-message')).toHaveLength(1)
  await click(view.host, '3 · ai')
  expect(view.host.querySelector('.debug-message-path')!.textContent).toContain('messages[2]')
  expect(view.host.querySelectorAll('.debug-message-block')).toHaveLength(2)
  expect(view.host.querySelector('[data-block-type="tool_call"]')!.textContent).toContain('read_file')
  expect(view.host.querySelector('[data-block-type="tool_call"]')!.textContent).toContain('call-42')
  await click(view.host, '4 · tool')
  expect(view.host.querySelector('[data-block-type="tool_result"] pre')!.textContent).toBe('Full tool result\nSecond line')
  await click(view.host, '5 · user')
  expect(view.host.querySelectorAll('[data-block-type="text"]')).toHaveLength(2)
  expect(view.host.querySelector('.debug-call-source')!.textContent).toContain('Turn 1 · R01')
  expect(JSON.stringify(response.item.request.messages)).toBe(original)
})

test('browses long message lists, keeps original indices after filtering and separates request views', async () => {
  const value = round()
  const response = assembled(value)
  response.item.request.messages = Array.from({ length: 55 }, (_, index) => ({ role: index % 2 ? 'tool' : 'assistant',
    blocks: [{ block_type: 'text', text: index === 44 ? 'x'.repeat(200) + ' distant-search-match' : `Message body ${index}` }], extras: {} }))
  response.item.request.tools = Array.from({ length: 52 }, (_, index) => ({ name: `tool_${index}`, description: `Tool description ${index}`, parameters: { type: 'object', properties: { path: { type: 'string' } } } }))
  globalThis.fetch = (async (input: string | URL | Request) => Response.json(String(input).includes('/prompts') ? response : [])) as typeof fetch
  const view = await mount(value)
  expect(view.host.querySelectorAll('[aria-label="Message List"] li')).toHaveLength(20)
  expect(view.host.querySelectorAll('.debug-call-message')).toHaveLength(1)
  expect(view.host.querySelector('.debug-request-raw')).toBeNull()
  await click(view.host, 'Next page')
  expect(view.host.querySelector('.debug-message-path')!.textContent).toContain('messages[20]')
  await click(view.host, 'Next page')
  expect(view.host.querySelectorAll('[aria-label="Message List"] li')).toHaveLength(15)
  const search = view.host.querySelector<HTMLInputElement>('[aria-label="Search messages"]')!
  await act(async () => { search.value = 'distant-search-match'; Simulate.change(search) })
  expect(view.host.querySelectorAll('[aria-label="Message List"] li')).toHaveLength(1)
  expect(view.host.querySelector('.debug-message-path')!.textContent).toContain('messages[44]')
  const role = view.host.querySelector<HTMLSelectElement>('[aria-label="Filter message role"]')!
  await act(async () => { role.value = 'tool'; Simulate.change(role) })
  expect(view.host.textContent).toContain('No matching results')
  expect(view.host.querySelector('.debug-call-message')).toBeNull()
  await act(async () => { role.value = ''; Simulate.change(role) })
  await click(view.host, 'Tool definitions')
  expect(view.host.querySelector('[aria-label="Message List"]')).toBeNull()
  expect(view.host.querySelectorAll('[aria-label="Tool definitions"] li')).toHaveLength(20)
  await click(view.host, 'Next page')
  expect(view.host.querySelector('.debug-request-item-navigation')!.textContent).toContain('tool_20')
  await click(view.host, 'Call parameters')
  expect(view.host.querySelector('.debug-request-parameters')!.textContent).toContain('historical-model')
  expect(view.host.querySelector('.debug-request-parameters')!.textContent).toContain('temperature')
  await click(view.host, 'View complete request JSON')
  const raw = JSON.parse(view.host.querySelector('.debug-request-raw pre')!.textContent!)
  expect(raw.messages).toHaveLength(55)
  expect(raw.tools).toHaveLength(52)
  await click(view.host, 'Back to structured view')
  await click(view.host, 'Messages')
  expect(view.host.querySelector<HTMLInputElement>('[aria-label="Search messages"]')!.value).toBe('distant-search-match')
  expect(view.host.querySelector('.debug-message-path')!.textContent).toContain('messages[44]')
})
