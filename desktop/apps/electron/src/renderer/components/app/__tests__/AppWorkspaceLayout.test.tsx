import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DEFAULT_SETTINGS } from '@app/shared/types'
import type { ElectronAPI } from '@shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
;(window as typeof window & { api: ElectronAPI }).api = {
  settings: {
    get: async () => DEFAULT_SETTINGS,
    set: async () => undefined,
  },
} as unknown as ElectronAPI

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { settingsAtom } = await import('@/atoms/settings')
const { excelExpandedAtom } = await import('@/atoms/excel')
const { SessionWorkbenchSurface, setSessionWorkbenchSurfaceAtom } = await import('@/atoms/browser')
const { materializeSessionAtom, newSessionAtom } = await import('@/atoms/sessions')
const { AppWorkspaceLayout } = await import('../AppWorkspaceLayout')

describe('AppWorkspaceLayout Session dock composition', () => {
  it('keeps Landing clear and mounts the dock after the draft becomes a real conversation', async () => {
    const store = createStore()
    store.set(settingsAtom, DEFAULT_SETTINGS)
    const sessionId = store.set(newSessionAtom)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppWorkspaceLayout
            left={<div>left</div>}
            center={<div data-testid="center-content">center</div>}
            right={<div>session tools</div>}
          />
        </Provider>,
      )
    })

    expect(host.querySelector('[data-testid="session-right-dock"]')).toBeNull()

    await act(async () => {
      store.set(materializeSessionAtom, sessionId)
    })

    expect(host.querySelector('[data-testid="session-right-dock"]')).not.toBeNull()
    expect(host.textContent).toContain('session tools')

    await act(async () => {
      store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Excel)
      store.set(excelExpandedAtom, true)
    })
    expect(host.querySelector('[data-testid="center-content"]')?.parentElement?.className).toContain('hidden')
    expect(host.querySelector('[data-testid="session-right-dock"]')?.className).toContain('flex-1')

    await act(async () => root.unmount())
    host.remove()
  })
})
