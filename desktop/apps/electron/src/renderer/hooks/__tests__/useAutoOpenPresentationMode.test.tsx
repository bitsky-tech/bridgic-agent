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
const {
  currentSessionFocusPaneAtom,
  setSessionFocusPaneAtom,
  SessionFocusPaneKind,
} = await import('@/atoms/session-focus-pane')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { useAutoOpenPresentationMode } = await import('../useAutoOpenPresentationMode')

function Harness() {
  useAutoOpenPresentationMode()
  return null
}

describe('useAutoOpenPresentationMode', () => {
  it('opens on entry, preserves manual close, and reopens for a later cycle', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-presentation-auto-open'
    store.set(activeSessionIdAtom, sessionId)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>,
      )
    })

    await act(async () => {
      store.set(thinkingModeFamily(sessionId), { mode: 'presentation', stage: 'ppt_brief' })
    })
    expect(store.get(currentSessionFocusPaneAtom)?.kind).toBe(SessionFocusPaneKind.Presentation)

    await act(async () => {
      store.set(setSessionFocusPaneAtom, null)
      store.set(thinkingModeFamily(sessionId), { mode: 'presentation', stage: 'ppt_plan' })
    })
    expect(store.get(currentSessionFocusPaneAtom)).toBeNull()

    await act(async () => {
      store.set(thinkingModeFamily(sessionId), { mode: 'normal', stage: null })
    })
    await act(async () => {
      store.set(thinkingModeFamily(sessionId), { mode: 'presentation', stage: 'ppt_brief' })
    })
    expect(store.get(currentSessionFocusPaneAtom)?.kind).toBe(SessionFocusPaneKind.Presentation)

    await act(async () => root.unmount())
    host.remove()
  })
})
