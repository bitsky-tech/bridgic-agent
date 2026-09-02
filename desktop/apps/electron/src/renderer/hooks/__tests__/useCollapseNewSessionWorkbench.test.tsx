import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'
import type { ElectronAPI } from '@shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(window as typeof window & { api: ElectronAPI }).api = {
  workbench: {
    ensure: async () => undefined,
    activate: async () => undefined,
    close: async () => undefined,
  },
  settings: {
    get: mock(async () => DEFAULT_SETTINGS),
    set: mock(async (_settings: GuiSettings) => undefined),
  },
} as unknown as ElectronAPI

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } = await import('@/atoms/layout')
const { newSessionAtom, selectSessionAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { useCollapseNewSessionWorkbench } = await import('../useCollapseNewSessionWorkbench')
const { useRememberRightPanelState } = await import('../useRememberRightPanelState')

function Harness() {
  useRememberRightPanelState()
  useCollapseNewSessionWorkbench()
  return null
}

describe('useCollapseNewSessionWorkbench', () => {
  it('collapses ordinary workbench content every time new Session is explicitly entered', async () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<Provider store={store}><Harness /></Provider>)
    })

    let draftId = ''
    await act(async () => {
      store.set(setRightPanelCollapsedAtom, false)
      draftId = store.set(newSessionAtom)
    })
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)

    await act(async () => {
      store.set(selectSessionAtom, 'session-existing')
      store.set(setRightPanelCollapsedAtom, false)
      store.set(newSessionAtom)
    })
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(store.get(settingsAtom).layout.rightPanelCollapsed).toBe(true)
    expect(draftId).not.toBe('')

    await act(async () => store.set(selectSessionAtom, 'session-existing'))
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)

    await act(async () => store.set(selectSessionAtom, draftId))
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)

    // Materializing the reused draft gives it a fresh daemon id. That id has no
    // in-memory override yet, so it must inherit the draft's rail-only fallback.
    await act(async () => store.set(selectSessionAtom, 'session-materialized-from-draft'))
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)

    await act(async () => root.unmount())
    host.remove()
  })
})
