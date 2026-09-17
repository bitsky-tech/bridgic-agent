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
const {
  SessionWorkbenchSurface,
  setSessionWorkbenchSurfaceAtom,
} = await import('@/atoms/browser')
const { settingsAtom } = await import('@/atoms/settings')
const { excelExpandedAtom } = await import('@/atoms/excel')
const { materializeSessionAtom, newSessionAtom } = await import('@/atoms/sessions')
const { wordHostSnapshotAtom } = await import('@/atoms/word')
const { RIGHT_PANEL_RAIL_WIDTH, setRightPanelCollapsedAtom } = await import('@/atoms/layout')
const { CANVAS_DOCK_MIN } = await import('@/components/amphi/AppLayout')
const { AppWorkspaceLayout } = await import('../AppWorkspaceLayout')

describe('AppWorkspaceLayout Session dock composition', () => {
  it.each([undefined, 680])('shares default, saved and dragged widths across Office and Browser (saved: %s)', async (savedWidth) => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1800 })
    const store = createStore()
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      layout: { ...DEFAULT_SETTINGS.layout, rightPanelWidth: 380, browserPanelWidth: savedWidth },
    })
    const sessionId = store.set(newSessionAtom)
    store.set(materializeSessionAtom, sessionId)
    const surfaces = [SessionWorkbenchSurface.Presentation, SessionWorkbenchSurface.Word, SessionWorkbenchSurface.Excel, SessionWorkbenchSurface.Browser]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const dock = () => host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')!
    const stage = () => host.querySelector<HTMLElement>('[data-testid="session-right-dock-stage"]')!
    let expectedWidth = (savedWidth ?? CANVAS_DOCK_MIN) + RIGHT_PANEL_RAIL_WIDTH
    try {
      await act(async () => {
        root.render(<Provider store={store}><AppWorkspaceLayout left={<div>left</div>} center={<div>center</div>} right={<div>tools</div>} /></Provider>)
      })
      // A resize from every tool must immediately carry over to the next tool.
      for (const surface of surfaces) {
        await act(async () => store.set(setSessionWorkbenchSurfaceAtom, surface))
        expect(dock().style.width).toBe(`${expectedWidth}px`)
        expect(stage().style.width).toBe(`${expectedWidth}px`)
        const handle = host.querySelector<HTMLElement>('[data-testid="resize-handle-right"]')!
        let captured = false
        handle.setPointerCapture = () => { captured = true }
        handle.hasPointerCapture = () => captured
        handle.releasePointerCapture = () => { captured = false }
        await act(async () => {
          for (const [type, clientX] of [['pointerdown', 600], ['pointermove', 560], ['pointerup', 560]] as const) {
            const event = new Event(type, { bubbles: true, cancelable: true })
            Object.defineProperties(event, { button: { value: 0 }, clientX: { value: clientX }, isPrimary: { value: true }, pointerId: { value: 7 } })
            handle.dispatchEvent(event)
          }
        })
        expectedWidth += 40
        expect(dock().style.width).toBe(`${expectedWidth}px`)
        expect(store.get(settingsAtom).layout.browserPanelWidth).toBe(expectedWidth - RIGHT_PANEL_RAIL_WIDTH)
      }
      for (const surface of surfaces) {
        await act(async () => {
          store.set(setSessionWorkbenchSurfaceAtom, surface)
          store.set(setRightPanelCollapsedAtom, true)
        })
        expect(dock().style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)
        await act(async () => store.set(setRightPanelCollapsedAtom, false))
        expect(dock().style.width).toBe(`${expectedWidth}px`)
      }
      await act(async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 })
        window.dispatchEvent(new Event('resize'))
      })
      const compactWidth = dock().style.width
      expect(Number.parseFloat(compactWidth)).toBeLessThan(expectedWidth)
      for (const surface of surfaces) {
        await act(async () => store.set(setSessionWorkbenchSurfaceAtom, surface))
        expect(dock().style.width).toBe(compactWidth)
      }
      await act(async () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1800 })
        window.dispatchEvent(new Event('resize'))
      })
      expect(dock().style.width).toBe(`${expectedWidth}px`)
      // Files and Agent panes still keep their separate ordinary panel width.
      await act(async () => store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Files))
      expect(dock().style.width).toBe(`${380 + RIGHT_PANEL_RAIL_WIDTH}px`)
      expect(store.get(settingsAtom).layout.rightPanelWidth).toBe(380)
    } finally {
      await act(async () => root.unmount())
      host.remove()
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalInnerWidth })
    }
  })

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
            center={<div data-testid="workspace-center">center</div>}
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
      store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Word)
      store.set(wordHostSnapshotAtom, { sessions: [{
        sessionId, targetId: 'word-a', webContentsId: 3, loading: false, crashed: false,
        documentCount: 1, persistenceStatus: 'saved', expanded: true,
      }] })
    })

    expect(host.querySelector('[data-testid="workspace-center"]')?.parentElement?.className)
      .toContain('hidden')
    expect(host.querySelector('[data-testid="session-right-dock"]')?.className)
      .toContain('flex-1')

    await act(async () => {
      store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Excel)
      store.set(excelExpandedAtom, true)
    })
    expect(host.querySelector('[data-testid="workspace-center"]')?.parentElement?.className).toContain('hidden')
    expect(host.querySelector('[data-testid="session-right-dock"]')?.className).toContain('flex-1')

    await act(async () => root.unmount())
    host.remove()
  })
})
