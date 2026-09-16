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
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { backendSnapshotAtom } = await import('@/atoms/backend')
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
  store.set(backendSnapshotAtom, { ...store.get(backendSnapshotAtom), endpoint: {
    baseUrl: 'http://daemon.test:7421', token: 'debug-token', clientId: 'desktop-test', version: null, startedAt: null, wsPath: '/ws', runtimeFile: null, logFile: null,
  } })
  const render = async (current: TraceToolCall, visible = true, sessionId = 'session-a') => act(async () => {
    store.set(activeSessionIdAtom, sessionId)
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
  test('sends edited parameters once through the authenticated API and keeps the historical result', async () => {
    const requests: { url: string; init?: RequestInit }[] = []
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      const input = JSON.parse(String(init?.body))
      return Response.json({ sessionId: 'session-a', durationMs: 12, result: {
        tool_id: 'test-run', tool_name: input.toolName, tool_arguments: input.arguments,
        tool_result: { output: 'Fresh result' }, success: true, error: null,
      } })
    }) as unknown as typeof fetch
    const source = call([{ name: 'file_path', value: 'original.txt' }, { name: 'limit', value: 1 }])
    const view = await mount(source)
    await edit(view.host, 'file_path · 1', 'edited.txt')
    await edit(view.host, 'limit · 2', '4')
    expect(requests).toHaveLength(0)
    await act(async () => view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!.click())
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('http://daemon.test:7421/api/debug/sessions/session-a/tools/execute')
    expect(requests[0]!.init?.method).toBe('POST')
    expect(requests[0]!.init?.headers).toMatchObject({ Authorization: 'Bearer debug-token', 'X-Client-Id': 'desktop-test' })
    expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({ toolName: 'read_file', arguments: { file_path: 'edited.txt', limit: 4 } })
    expect(view.host.querySelector('.debug-tool-test-result')?.textContent).toContain('Fresh result')
    expect(source.result).toBe('Original result')
    expect(source.arguments).toEqual([{ name: 'file_path', value: 'original.txt' }, { name: 'limit', value: 1 }])
    await view.render(source, false)
    await view.render(source)
    expect(view.host.querySelector('.debug-tool-test-result')?.textContent).toContain('Fresh result')
    expect(requests).toHaveLength(1)
  })

  test('retains pending executions across navigation, prevents double submits and ignores old Session results', async () => {
    const pending: ((response: Response) => void)[] = []
    let requests = 0
    globalThis.fetch = (() => {
      requests += 1
      return new Promise<Response>(done => { pending.push(done) })
    }) as unknown as typeof fetch
    const source = call({ file_path: 'original.txt' })
    const view = await mount(source)
    await act(async () => {
      const button = view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!
      button.click()
      button.click()
    })
    expect(requests).toBe(1)
    expect(view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!.disabled).toBe(true)
    await view.render(source, false)
    await view.render(source)
    expect(view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!.disabled).toBe(true)
    await edit(view.host, 'file_path', 'next-run.txt')
    expect(view.host.querySelector('.debug-tool-test-result')?.textContent).toContain('original.txt')
    await view.render(source, true, 'session-b')
    await act(async () => view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!.click())
    expect(requests).toBe(2)
    await act(async () => pending[0]!(Response.json({ sessionId: 'session-a', durationMs: 1, result: {
      tool_id: 'old-run', tool_name: 'read_file', tool_arguments: {}, tool_result: 'Old Session result', success: true, error: null,
    } })))
    expect(view.host.textContent).not.toContain('Old Session result')
    expect(view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!.disabled).toBe(true)
    await act(async () => pending[1]!(Response.json({ sessionId: 'session-b', durationMs: 1, result: {
      tool_id: 'new-run', tool_name: 'read_file', tool_arguments: {}, tool_result: 'New Session result', success: true, error: null,
    } })))
    expect(view.host.querySelector('.debug-tool-test-result')?.textContent).toContain('New Session result')
  })

  test('shows tool failures and request errors without automatically retrying', async () => {
    let requests = 0
    globalThis.fetch = (async () => {
      requests += 1
      if (requests === 2) return Response.json({ detail: 'Resource unavailable' }, { status: 409 })
      return Response.json({ sessionId: 'session-a', durationMs: 1, result: {
        tool_id: 'failed', tool_name: 'read_file', tool_arguments: {}, tool_result: null, success: false, error: 'File is missing',
      } })
    }) as unknown as typeof fetch
    const view = await mount(call({ file_path: 'missing.txt' }))
    const button = view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!
    await act(async () => button.click())
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('File is missing')
    expect(requests).toBe(1)
    await act(async () => button.click())
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Resource unavailable')
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('may still have executed')
    expect(requests).toBe(2)
    expect(button.disabled).toBe(false)
  })

  test('rejects ambiguous argument names and supports argument-free tools', async () => {
    const view = await mount(call([{ name: 'file_path', value: 'one' }, { name: 'file_path', value: 'two' }]))
    expect(view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!.disabled).toBe(true)
    await view.render(call([], 'empty'))
    expect(view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!.disabled).toBe(false)
  })

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
    expect(control(view.host, 'item · 1').value).toBe('42')
    expect(control(view.host, 'item · 2').value).toBe('3.5')
    expect(control(view.host, 'enabled · 3').value).toBe('false')
    expect(control(view.host, 'options · 5').value).toBe('{"level":2,"items":["kept"]}')
    expect(view.host.textContent).not.toContain('Draft argument preview')
    expect(JSON.parse(record(view.host, 'Original arguments · Read only'))).toEqual(argumentsValue)
    expect(argumentsValue[0]!.value).toBe('first')
    expect(source.result).toBe('Original result')
  })

  test('blocks invalid parameters and does not execute automatically when they become valid', async () => {
    let requests = 0
    globalThis.fetch = (() => { requests += 1; throw new Error('Unexpected backend call') }) as unknown as typeof fetch
    const view = await mount(call({ count: 0, options: {} }))
    await edit(view.host, 'count', '')
    expect(control(view.host, 'count').getAttribute('aria-invalid')).toBe('true')
    expect(view.host.querySelector('[role="alert"]')?.textContent).toBe('Enter a valid number.')
    expect(view.host.querySelector<HTMLButtonElement>('.debug-tool-execute')!.disabled).toBe(true)
    await edit(view.host, 'count', '2')
    await edit(view.host, 'options', '[]')
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Enter a JSON object')
    await edit(view.host, 'options', '{')
    expect(view.host.querySelector('[role="alert"]')?.textContent).toContain('Invalid JSON')
    await edit(view.host, 'options', '{"enabled":false}')
    expect(view.host.querySelector('[role="alert"]')).toBeNull()
    const execute = [...view.host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Execute tool')!
    expect(execute.disabled).toBe(false)
    expect(document.getElementById(execute.getAttribute('aria-describedby')!)?.textContent).toContain('current Session resources')
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
