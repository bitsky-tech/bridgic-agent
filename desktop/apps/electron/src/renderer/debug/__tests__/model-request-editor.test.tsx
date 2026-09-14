import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { TraceRound } from '../types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Simulate } = await import('react-dom/test-utils')
const { Provider, createStore } = await import('jotai')
const { settingsAtom } = await import('@/atoms/settings')
const { DebugDraftProvider } = await import('../DebugDrafts')
const { ModelRequestEditor } = await import('../ModelRequestEditor')
const { buildTraceRecords } = await import('../trace-records')
const originalFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = originalFetch; document.body.replaceChildren() })
afterAll(async () => { await GlobalRegistrator.unregister() })

function round(recordedRequest: Record<string, unknown>, id = 'round-1'): TraceRound {
  const value = buildTraceRecords([{ id: 'turn-1', sessionId: 'session-1', sessionOrdinal: 0, status: 'completed', model: 'inherited-turn-model', durationMs: null, otaRecords: [{}], otaContext: null }]).rounds[0]!
  return { ...value, id, recordedRequest }
}

async function mount(initial: TraceRound) {
  const store = createStore()
  store.set(settingsAtom, { ...store.get(settingsAtom), locale: 'en' })
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  async function render(value: TraceRound | null, sessionId = 'session-1') {
    await act(async () => root.render(<Provider store={store}><DebugDraftProvider sessionId={sessionId}>{value ? <ModelRequestEditor round={value} /> : <span>List</span>}</DebugDraftProvider></Provider>))
  }
  await render(initial)
  return { host, render, unmount: () => act(async () => root.unmount()) }
}

async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    element.value = value
    Simulate.change(element)
  })
}

function editor(host: HTMLElement, label: string) {
  const element = [...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')].find((item) => item.getAttribute('aria-label') === label)
  if (!element) throw new Error(`Missing editor: ${label}`)
  return element
}
function button(host: HTMLElement, label: string) {
  const element = [...host.querySelectorAll<HTMLButtonElement>('button')].find((item) => item.textContent === label || item.getAttribute('aria-label') === label)
  if (!element) throw new Error(`Missing button: ${label}`)
  return element
}
function preview(host: HTMLElement, label = 'Debug draft JSON') {
  const details = [...host.querySelectorAll('details')].find((item) => item.querySelector(':scope > summary')?.textContent === label)
  return JSON.parse(details?.querySelector('pre')?.textContent ?? 'null')
}

describe('ModelRequestEditor', () => {
  it('creates an honest editable manual draft without inheriting a historical model or making requests', async () => {
    let requests = 0
    globalThis.fetch = (() => { requests++; throw new Error('Unexpected request') }) as unknown as typeof fetch
    const view = await mount(round({ model_options: { temperature: 0 } }))
    expect(view.host.textContent).toContain('No readable prompt was saved')
    expect(view.host.querySelector('textarea')).toBeNull()
    expect(button(view.host, 'Call LLM once').disabled).toBe(true)
    await act(async () => button(view.host, 'Create debug request').click())
    expect(view.host.textContent).toContain('Manually created draft')
    expect(editor(view.host, 'Message 1 content').value).toBe('')
    expect(editor(view.host, 'model').value).toBe('')
    await input(editor(view.host, 'Message 1 content'), 'Write a short response')
    await input(editor(view.host, 'model'), 'debug-model')
    expect(preview(view.host)).toEqual({ model_options: { temperature: 0 }, messages: [{ role: 'user', content: 'Write a short response' }], model: 'debug-model' })
    expect(preview(view.host, 'Original request · Recorded fields')).toEqual({ model_options: { temperature: 0 } })
    expect(view.host.textContent).toContain('Execution API pending')
    expect(requests).toBe(0)
    await view.unmount()
  })

  it('edits native content blocks while retaining tool-call metadata and unknown provider options', async () => {
    const original = { llm_request: { payload: { model: 'captured-model', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Before' }],
      tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"a":1}' } }], extra_signature: 'fixture' }], vendor: { reasoning: true }, temperature: 0, tools: [{ type: 'function', function: { name: 'read' } }] } } }
    const view = await mount(round(original))
    await input(editor(view.host, 'Message 1 content (JSON)'), '[{"type":"text","text":"After"},{"type":"image_url","image_url":{"url":"fixture.png"}}]')
    await input(editor(view.host, 'llm_request.payload.model'), 'edited-model')
    const draft = preview(view.host)
    expect(draft.llm_request.payload.messages[0]).toEqual({ ...original.llm_request.payload.messages[0], content: [
      { type: 'text', text: 'After' }, { type: 'image_url', image_url: { url: 'fixture.png' } },
    ] })
    expect(draft.llm_request.payload.vendor).toEqual({ reasoning: true })
    expect(draft.llm_request.payload.tools).toEqual(original.llm_request.payload.tools)
    expect(preview(view.host, 'Original request · Recorded fields')).toEqual(original)
    await input(editor(view.host, 'Parameters & other fields · llm_request.payload'), '{ invalid')
    expect(view.host.querySelector('[role=alert]')).not.toBeNull()
    expect(button(view.host, 'Add message').disabled).toBe(true)
    expect(preview(view.host)).toBeNull()
    expect(view.host.textContent).toContain('The draft contains invalid JSON')
    await input(editor(view.host, 'Parameters & other fields · llm_request.payload'), '{"vendor":{"reasoning":true},"temperature":0.4}')
    expect(view.host.querySelector('[role=alert]')).toBeNull()
    expect(preview(view.host).llm_request.payload.temperature).toBe(0.4)
    await view.unmount()
  })

  it('keeps edits across polling and inspector navigation, while session changes clear drafts', async () => {
    const stored = round({ request_messages: [{ role: 'user', content: 'Stored prompt' }] })
    const view = await mount(stored)
    await input(editor(view.host, 'Message 1 content'), 'Local draft')
    await view.render(round({ request_messages: [{ role: 'user', content: 'Polled prompt' }] }))
    expect(editor(view.host, 'Message 1 content').value).toBe('Local draft')
    await view.render(null)
    await view.render(stored)
    expect(editor(view.host, 'Message 1 content').value).toBe('Local draft')
    await view.render(round({ prompt_messages: [{ role: 'user', content: 'Another round' }] }, 'round-2'))
    expect(editor(view.host, 'Message 1 content').value).toBe('Another round')
    await view.render(stored)
    expect(editor(view.host, 'Message 1 content').value).toBe('Local draft')
    await view.render(stored, 'session-2')
    expect(editor(view.host, 'Message 1 content').value).toBe('Stored prompt')
    await view.unmount()
  })

  it('adds and removes messages and edits roles without affecting the recorded request', async () => {
    const stored = { system_prompt: '  Exact instruction\n', prompt_messages: [{ role: 'user', content: 'Question' }] }
    const view = await mount(round(stored))
    expect(editor(view.host, 'system_prompt').value).toBe('  Exact instruction\n')
    await act(async () => button(view.host, 'Add message').click())
    await input(editor(view.host, 'Message 2 content'), 'An assistant reply')
    const role = view.host.querySelector<HTMLSelectElement>('select[aria-label="Message 2 role"]')!
    await act(async () => { role.value = 'assistant'; Simulate.change(role) })
    await act(async () => button(view.host, 'Remove Message 1').click())
    expect(preview(view.host).prompt_messages).toEqual([{ role: 'assistant', content: 'An assistant reply' }])
    expect(preview(view.host, 'Original request · Recorded fields')).toEqual(stored)
    await view.unmount()
  })

  it('can extend a recorded scalar prompt without calling the historical prompt missing', async () => {
    const view = await mount(round({ system_prompt: 'Original instructions', prompt: 'Original question' }))
    await act(async () => button(view.host, 'Add message list').click())
    expect(view.host.textContent).not.toContain('Historical prompt remains unavailable')
    expect(preview(view.host)).toEqual({ system_prompt: 'Original instructions', prompt: 'Original question', messages: [{ role: 'user', content: '' }] })
    await view.unmount()
  })

  it('restores the missing historical prompt after resetting a manually created draft', async () => {
    const historical = { model_options: { temperature: 0 } }
    const view = await mount(round(historical))
    await act(async () => button(view.host, 'Create debug request').click())
    await input(editor(view.host, 'Message 1 content'), 'Manual prompt')
    await input(editor(view.host, 'model'), 'Manual model')
    await act(async () => button(view.host, 'Restore original request').click())
    expect(view.host.textContent).toContain('No readable prompt was saved')
    expect(view.host.querySelector('textarea')).toBeNull()
    expect(preview(view.host, 'Original request · Recorded fields')).toEqual(historical)
    await act(async () => button(view.host, 'Create debug request').click())
    expect(editor(view.host, 'Message 1 content').value).toBe('')
    expect(editor(view.host, 'model').value).toBe('')
    await view.unmount()
  })

  it('hides stale valid JSON during parse errors and restores all original fields and buffers', async () => {
    const historical = { request: { messages: [{ role: 'user', content: 'Original prompt' }], model: 'original-model', temperature: 0.2, tools: [] } }
    const view = await mount(round(historical))
    expect(button(view.host, 'Restore original request').disabled).toBe(true)
    await input(editor(view.host, 'Message 1 content'), 'Edited prompt')
    await input(editor(view.host, 'request.tools'), '[invalid')
    const raw = [...view.host.querySelectorAll('details')].find((item) => item.querySelector(':scope > summary')?.textContent === 'Debug draft JSON')!
    expect(raw.querySelector('pre')).toBeNull()
    expect(raw.querySelector('[role=alert]')?.textContent).toContain('Correct the editor errors')
    await view.render(null)
    await view.render(round(historical))
    expect(editor(view.host, 'request.tools').value).toBe('[invalid')
    expect(preview(view.host)).toBeNull()
    await act(async () => button(view.host, 'Restore original request').click())
    expect(view.host.querySelector('[role=alert]')).toBeNull()
    expect(editor(view.host, 'Message 1 content').value).toBe('Original prompt')
    expect(editor(view.host, 'request.tools').value).toBe('[]')
    expect(preview(view.host)).toEqual(historical)
    expect(button(view.host, 'Restore original request').disabled).toBe(true)
    await view.unmount()
  })
})
