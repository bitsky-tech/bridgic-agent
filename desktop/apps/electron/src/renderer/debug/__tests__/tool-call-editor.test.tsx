import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { TraceToolCall } from '../types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Simulate } = await import('react-dom/test-utils')
const { createStore, Provider } = await import('jotai')
const { settingsAtom } = await import('@/atoms/settings')
const { DebugDraftProvider } = await import('../DebugDrafts')
const { ToolCallEditor } = await import('../ToolCallEditor')

const roots: ReturnType<typeof createRoot>[] = []
const originalFetch = globalThis.fetch
afterEach(async () => {
  await act(async () => { for (const root of roots.splice(0)) root.unmount() })
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})
afterAll(async () => { await GlobalRegistrator.unregister() })

function call(argumentsValue: unknown, id = 'call-a'): TraceToolCall {
  return { id, roundId: `${id}-round`, turnId: `${id}-turn`, turnOrdinal: 0, ordinal: 1, sourceCallId: id, name: 'read_file',
    arguments: argumentsValue, result: 'Original result', error: null, hasResult: true, pairing: 'id', status: 'success', durationMs: 0,
    rawCall: { tool_arguments: argumentsValue }, rawResult: { tool_result: 'Original result' } }
}

async function mount(initial: TraceToolCall) {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  roots.push(root)
  const store = createStore()
  store.set(settingsAtom, { ...store.get(settingsAtom), locale: 'en' })
  const render = async (current: TraceToolCall, visible = true, sessionId = 'session-a') => act(async () => {
    root.render(<Provider store={store}><DebugDraftProvider sessionId={sessionId}>
      {visible ? <ToolCallEditor call={current} /> : <span>Another inspector</span>}
    </DebugDraftProvider></Provider>)
  })
  await render(initial)
  return { host, render }
}

function control(host: HTMLElement, label: string) {
  const entry = [...host.querySelectorAll<HTMLLabelElement>('label')].find(element => element.querySelector('span')?.textContent === label)
  expect(entry).toBeDefined()
  return document.getElementById(entry!.htmlFor) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
}

async function edit(host: HTMLElement, label: string, value: string) {
  const input = control(host, label)
  await act(async () => {
    input.value = value
    Simulate.change(input)
  })
}

function record(host: HTMLElement, summary: string) {
  return [...host.querySelectorAll('details')].find(element => element.querySelector('summary')?.textContent === summary)!.querySelector('pre')!.textContent!
}

describe('ToolCallEditor', () => {
  test('edits duplicate-name parameter rows as typed values without changing the historical argument snapshot', async () => {
    const argumentsValue = [
      { name: 'item', value: 'first', metadata: 'keep-first' }, { name: 'item', value: 2 },
      { name: 'enabled', value: true }, { name: 'optional', value: null }, { name: 'options', value: { level: 1 } },
    ]
    const source = call(argumentsValue)
    const view = await mount(source)
    expect(view.host.querySelectorAll('.debug-tool-editor-field')).toHaveLength(5)
    await edit(view.host, 'item · 1', '42')
    await edit(view.host, 'item · 2', '3.5')
    await edit(view.host, 'enabled · 3', 'false')
    await edit(view.host, 'options · 5', '{"level":2,"items":["kept"]}')
    expect(control(view.host, 'optional · 4').getAttribute('readonly')).not.toBeNull()
    expect(JSON.parse(record(view.host, 'Draft argument preview'))).toEqual([
      { name: 'item', value: '42', metadata: 'keep-first' }, { name: 'item', value: 3.5 },
      { name: 'enabled', value: false }, { name: 'optional', value: null }, { name: 'options', value: { level: 2, items: ['kept'] } },
    ])
    expect(JSON.parse(record(view.host, 'Original arguments · Read only'))).toEqual(argumentsValue)
    expect(argumentsValue[0]!.value).toBe('first')
    expect(source.result).toBe('Original result')
  })

  test('shows inline validation and keeps execution visibly unavailable even when all draft values are valid', async () => {
    let requests = 0
    globalThis.fetch = (() => { requests += 1; throw new Error('Unexpected backend call') }) as unknown as typeof fetch
    const view = await mount(call({ count: 0, options: {} }))
    await edit(view.host, 'count', '')
    expect(control(view.host, 'count').getAttribute('aria-invalid')).toBe('true')
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe('Enter a valid number.')
    expect(record(view.host, 'Draft argument preview')).toContain('Fix the form errors')
    await edit(view.host, 'count', '2')
    await edit(view.host, 'options', '[]')
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Enter a JSON object')
    await edit(view.host, 'options', '{')
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Invalid JSON')
    await edit(view.host, 'options', '{"enabled":false}')
    expect(view.host.querySelector('[role="alert"]')).toBeNull()
    expect(JSON.parse(record(view.host, 'Draft argument preview'))).toEqual({ count: 2, options: { enabled: false } })
    const execute = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Execute tool')!
    expect(execute.disabled).toBe(true)
    expect(document.getElementById(execute.getAttribute('aria-describedby')!)?.textContent).toBe('Execution API not connected')
    await act(async () => execute.click())
    expect(requests).toBe(0)
  })

  test('retains a local draft through polling and inspector navigation, then resets to the original snapshot', async () => {
    const source = call({ path: 'recorded.txt' })
    const view = await mount(source)
    await edit(view.host, 'path', 'local-draft.txt')
    const polled = call({ path: 'polled-server-value.txt' })
    await view.render(polled)
    expect(control(view.host, 'path').value).toBe('local-draft.txt')
    await view.render(polled, false)
    await view.render(polled)
    expect(control(view.host, 'path').value).toBe('local-draft.txt')
    await view.render(call({ path: 'another.txt' }, 'call-b'))
    expect(control(view.host, 'path').value).toBe('another.txt')
    await view.render(polled)
    expect(control(view.host, 'path').value).toBe('local-draft.txt')
    expect(JSON.parse(record(view.host, 'Original arguments · Read only'))).toEqual({ path: 'recorded.txt' })
    const reset = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Reset to original')!
    await act(async () => reset.click())
    expect(control(view.host, 'path').value).toBe('recorded.txt')
    expect(JSON.parse(record(view.host, 'Draft argument preview'))).toEqual({ path: 'recorded.txt' })
    expect(reset.disabled).toBe(true)
  })

  test('keeps drafts in their session and does not replace absent arguments with an editable empty object', async () => {
    const source = call({ path: 'original.txt' })
    const view = await mount(source)
    await edit(view.host, 'path', 'session-a-draft.txt')
    await view.render(source, true, 'session-b')
    expect(control(view.host, 'path').value).toBe('original.txt')
    await view.render(call(undefined, 'missing-call'), true, 'session-b')
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe('Arguments were not saved in this historical record.')
    expect(record(view.host, 'Original arguments · Read only')).toBe('No displayable arguments recorded')
  })
})
