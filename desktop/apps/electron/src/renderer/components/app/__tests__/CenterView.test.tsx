import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { thinkingModeFamily } = await import('@/atoms/agent')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { CenterView } = await import('../CenterView')

describe('CenterView', () => {
  it('replaces only history while retaining the real composer and passing the active Session', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'developer-history-a')
    const History = ({ sessionId }: { sessionId: string }) => (
      <div data-testid="custom-history">{sessionId}</div>
    )
    await act(async () => root.render(
      <Provider store={store}><CenterView ConversationHistory={History} /></Provider>,
    ))
    expect(host.querySelector('[data-testid="custom-history"]')?.textContent).toBe('developer-history-a')
    expect(host.querySelector('[contenteditable="true"]')).not.toBeNull()
    await act(async () => store.set(activeSessionIdAtom, 'developer-history-b'))
    expect(host.querySelector('[data-testid="custom-history"]')?.textContent).toBe('developer-history-b')
    expect(host.querySelector('[contenteditable="true"]')).not.toBeNull()
    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps Workflow Run conversations free of a top status rail', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'workflow-run-conversation'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <CenterView />
        </Provider>,
      )
    })

    expect(host.querySelector('[contenteditable="true"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="build-mode-status-bar"]')).toBeNull()
    expect(host.querySelector('[data-testid="workflow-run-status-bar"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })
})
