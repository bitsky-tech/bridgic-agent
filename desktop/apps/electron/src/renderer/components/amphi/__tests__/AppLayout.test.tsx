import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DEFAULT_SETTINGS } from '@app/shared/types'
import type { ElectronAPI, EmbeddedBrowserTabInfo } from '@shared/types'

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
const { streamingFamily, thinkingModeFamily, workflowRunFamily } = await import('@/atoms/agent')
const {
  SessionWorkbenchSurface,
  setEmbeddedBrowserSnapshotAtom,
  setSessionWorkbenchSurfaceAtom,
} = await import('@/atoms/browser')
const {
  RIGHT_PANEL_MIN,
  RIGHT_PANEL_RAIL_WIDTH,
  browserDockWidthAtom,
  rememberRightPanelStateAtom,
  rightPanelCollapseRequestAtom,
  rightPanelCollapsedAtom,
  rightPanelWidthAtom,
  setRightPanelCollapsedAtom,
} = await import('@/atoms/layout')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const {
  closeWorkflowRunDetailsAtom,
  openWorkflowRunDetailsAtom,
} = await import('@/atoms/workflow-run-details')
const { AppLayout } = await import('../AppLayout')

function pointerEvent(type: string, clientX: number, pointerId = 7): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent
  Object.defineProperties(event, {
    button: { value: 0 },
    clientX: { value: clientX },
    isPrimary: { value: true },
    pointerId: { value: pointerId },
  })
  return event
}

function installPointerCapture(element: HTMLElement): void {
  let captured: number | null = null
  element.setPointerCapture = (pointerId) => { captured = pointerId }
  element.hasPointerCapture = (pointerId) => captured === pointerId
  element.releasePointerCapture = (pointerId) => {
    if (captured === pointerId) captured = null
  }
}

describe('AppLayout focused right pane', () => {
  it('keeps collapsed content closed while the Agent is actively using Browser', async () => {
    const store = createStore()
    const sessionId = 'layout-browser-activity'
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      layout: { ...DEFAULT_SETTINGS.layout, rightPanelCollapsed: true },
    })
    store.set(activeSessionIdAtom, sessionId)
    store.set(streamingFamily(sessionId), {
      messageId: 'browser-activity',
      content: '',
      toolCalls: [{
        toolUseId: 'browser-open',
        name: 'browser_open',
        input: { url: 'https://example.com' },
      }],
      blocks: [],
      startedAt: Date.now(),
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout
            left={<div>left</div>}
            center={<div>center</div>}
            right={<div>browser notice</div>}
          />
        </Provider>,
      )
    })

    const busyDock = host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')
    expect(busyDock?.dataset.contentOpen).toBe('false')
    expect(busyDock?.style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)

    await act(async () => {
      store.set(streamingFamily(sessionId), undefined)
    })
    const restoredDock = host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')
    expect(restoredDock?.dataset.contentOpen).toBe('false')
    expect(restoredDock?.style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps the right rail mounted and force-opens Run details without changing collapse preference', async () => {
    const store = createStore()
    const sessionId = 'layout-run-details'
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      layout: { ...DEFAULT_SETTINGS.layout, rightPanelCollapsed: true },
    })
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily(sessionId), {
      workflowId: 'wf-layout',
      generation: 'gen-layout',
      workflowName: '布局测试',
      sourceSessionId: sessionId,
      phase: 'execute',
      stepIndex: 0,
      executionSteps: ['执行'],
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout
            titleBar={false}
            left={<div>left</div>}
            center={<div>center</div>}
            right={<div data-testid="layout-right-content">right</div>}
          />
        </Provider>,
      )
    })
    const collapsedDock = host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')
    expect(collapsedDock).not.toBeNull()
    expect(collapsedDock?.dataset.contentOpen).toBe('false')
    expect(collapsedDock?.style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)
    expect(host.querySelector('[data-testid="layout-right-content"]')).not.toBeNull()
    const rightToggle = () => host.querySelector<HTMLButtonElement>(
      '[data-testid="toggle-right-panel"]',
    )
    expect(rightToggle()).not.toBeNull()
    expect(rightToggle()?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => store.set(openWorkflowRunDetailsAtom))
    const openDock = host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')
    expect(openDock?.dataset.contentOpen).toBe('true')
    expect(openDock?.style.width).not.toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(rightToggle()?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => store.set(closeWorkflowRunDetailsAtom))
    const restoredDock = host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')
    expect(restoredDock?.dataset.contentOpen).toBe('false')
    expect(restoredDock?.style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)
    expect(host.querySelector('[data-testid="layout-right-content"]')).not.toBeNull()
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(rightToggle()?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => root.unmount())
    host.remove()
  })

  it('routes the top-right global collapse control through the dock handoff', async () => {
    const store = createStore()
    const sessionId = 'layout-global-right-collapse'
    store.set(activeSessionIdAtom, sessionId)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout
            titleBar={false}
            left={<div>left</div>}
            center={<div>center</div>}
            right={<div>right</div>}
          />
        </Provider>,
      )
    })
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="toggle-right-panel"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => toggle?.click())
    expect(store.get(rightPanelCollapseRequestAtom)).toBe(true)
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })

  it('reopens collapsed dock content from the top-right global control', async () => {
    const store = createStore()
    const sessionId = 'layout-global-right-expand'
    store.set(activeSessionIdAtom, sessionId)
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      layout: { ...DEFAULT_SETTINGS.layout, rightPanelCollapsed: true },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout
            titleBar={false}
            left={<div>left</div>}
            center={<div>center</div>}
            right={<div>right</div>}
          />
        </Provider>,
      )
    })
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="toggle-right-panel"]')
    expect(toggle).not.toBeNull()
    expect(toggle?.getAttribute('aria-expanded')).toBe('false')

    await act(async () => toggle?.click())
    expect(store.get(rightPanelCollapsedAtom)).toBe(false)
    expect(store.get(rightPanelCollapseRequestAtom)).toBe(false)
    expect(toggle?.getAttribute('aria-expanded')).toBe('true')

    await act(async () => root.unmount())
    host.remove()
  })

  it('opens and closes only the dock content through the explicit collapse setter', async () => {
    const store = createStore()
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      layout: { ...DEFAULT_SETTINGS.layout, rightPanelCollapsed: true },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout
            left={<div>left</div>}
            center={<div>center</div>}
            right={<div data-testid="layout-right-content">right</div>}
          />
        </Provider>,
      )
    })
    const dock = () => host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')
    expect(dock()?.style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)

    await act(async () => store.set(setRightPanelCollapsedAtom, false))
    expect(dock()?.dataset.contentOpen).toBe('true')
    expect(dock()?.style.width).not.toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)

    await act(async () => store.set(setRightPanelCollapsedAtom, true))
    expect(dock()?.dataset.contentOpen).toBe('false')
    expect(dock()?.style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps the inner dock at its remembered width while the outer shell reveals it', async () => {
    const store = createStore()
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      layout: {
        ...DEFAULT_SETTINGS.layout,
        rightPanelCollapsed: true,
        rightPanelWidth: 380,
      },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout left={<div>left</div>} center={<div>center</div>} right={<div>right</div>} />
        </Provider>,
      )
    })
    const dock = () => host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')!
    const stage = () => host.querySelector<HTMLElement>('[data-testid="session-right-dock-stage"]')!
    const rememberedTotal = 380 + RIGHT_PANEL_RAIL_WIDTH
    expect(dock().className).not.toContain('overflow-hidden')
    expect(host.querySelector('[data-testid="session-right-dock-clip"]')?.className)
      .toContain('overflow-hidden')
    expect(dock().style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)
    expect(stage().style.width).toBe(`${rememberedTotal}px`)

    await act(async () => store.set(setRightPanelCollapsedAtom, false))
    expect(dock().style.width).toBe(`${rememberedTotal}px`)
    expect(stage().style.width).toBe(`${rememberedTotal}px`)

    await act(async () => store.set(setRightPanelCollapsedAtom, true))
    expect(dock().style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)
    expect(stage().style.width).toBe(`${rememberedTotal}px`)
    expect(store.get(settingsAtom).layout.rightPanelWidth).toBe(380)

    await act(async () => root.unmount())
    host.remove()
  })

  it('uses the minimum panel width before the user has resized it', async () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout left={<div>left</div>} center={<div>center</div>} right={<div>right</div>} />
        </Provider>,
      )
    })
    const expected = RIGHT_PANEL_MIN + RIGHT_PANEL_RAIL_WIDTH
    const dock = host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')!
    expect(dock.style.width).toBe(`${expected}px`)
    expect(dock.className).toContain('border-l')
    expect(dock.className).toContain('border-border-strong/60')
    expect(host.querySelector<HTMLElement>('[data-testid="session-right-dock-stage"]')?.style.width)
      .toBe(`${expected}px`)

    await act(async () => root.unmount())
    host.remove()
  })

  it('matches the standard right-panel divider for the open Browser dock', async () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout
            left={<div>left</div>}
            center={<div>center</div>}
            right={<div>browser</div>}
            rightKind="browser"
          />
        </Provider>,
      )
    })

    const dock = host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')!
    const stage = host.querySelector<HTMLElement>('[data-testid="session-right-dock-stage"]')!
    const rememberedBrowserWidth = dock.style.width
    expect(dock.className).toContain('border-l')
    expect(dock.className).toContain('border-border-strong/60')
    expect(dock.style.boxShadow).toBe('')
    expect(stage.style.width).toBe(rememberedBrowserWidth)
    expect(host.querySelector('[data-testid="resize-handle-right"]')).not.toBeNull()

    await act(async () => store.set(setRightPanelCollapsedAtom, true))
    expect(dock.style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)
    expect(dock.style.boxShadow).toBe('')
    expect(dock.className).not.toContain('border-l')
    expect(stage.style.width).toBe(rememberedBrowserWidth)

    await act(async () => store.set(setRightPanelCollapsedAtom, false))
    expect(dock.style.width).toBe(rememberedBrowserWidth)
    expect(dock.className).toContain('border-l')
    expect(dock.className).toContain('border-border-strong/60')
    expect(stage.style.width).toBe(rememberedBrowserWidth)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout
            left={<div>left</div>}
            center={<div>center</div>}
            right={<div>browser</div>}
            rightExpanded
            rightKind="browser"
          />
        </Provider>,
      )
    })
    expect(dock.style.boxShadow).toBe('')
    expect(dock.className).not.toContain('border-l')
    expect(host.querySelector('[data-testid="resize-handle-right"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('reflows the inner dock only while the user is actively resizing it', async () => {
    const store = createStore()
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      layout: { ...DEFAULT_SETTINGS.layout, rightPanelWidth: 380 },
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout left={<div>left</div>} center={<div>center</div>} right={<div>right</div>} />
        </Provider>,
      )
    })
    const handle = host.querySelector<HTMLElement>('[data-testid="resize-handle-right"]')!
    installPointerCapture(handle)
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', 600))
      handle.dispatchEvent(pointerEvent('pointermove', 640))
    })
    const resizedTotal = 380 + RIGHT_PANEL_RAIL_WIDTH - 40
    expect(host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')?.style.width)
      .toBe(`${resizedTotal}px`)
    expect(host.querySelector<HTMLElement>('[data-testid="session-right-dock-stage"]')?.style.width)
      .toBe(`${resizedTotal}px`)

    await act(async () => handle.dispatchEvent(pointerEvent('pointerup', 640)))
    expect(store.get(settingsAtom).layout.rightPanelWidth)
      .toBe(resizedTotal - RIGHT_PANEL_RAIL_WIDTH)

    await act(async () => root.unmount())
    host.remove()
  })

  it('restores each Session panel width and cancels an in-flight cross-Session drag', async () => {
    const store = createStore()
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      layout: { ...DEFAULT_SETTINGS.layout, rightPanelWidth: 380 },
    })
    store.set(activeSessionIdAtom, 'layout-width-a')
    store.set(rememberRightPanelStateAtom, 'layout-width-a')
    store.set(activeSessionIdAtom, 'layout-width-b')
    store.set(rememberRightPanelStateAtom, 'layout-width-b')
    store.set(activeSessionIdAtom, 'layout-width-a')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout left={<div>left</div>} center={<div>center</div>} right={<div>right</div>} />
        </Provider>,
      )
    })
    const dock = () => host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')!
    const initialTotal = 380 + RIGHT_PANEL_RAIL_WIDTH
    const resizedTotal = initialTotal - 40
    expect(dock().style.width).toBe(`${initialTotal}px`)

    const interruptedHandle = host.querySelector<HTMLElement>('[data-testid="resize-handle-right"]')!
    installPointerCapture(interruptedHandle)
    await act(async () => {
      interruptedHandle.dispatchEvent(pointerEvent('pointerdown', 600))
      interruptedHandle.dispatchEvent(pointerEvent('pointermove', 640))
    })
    expect(dock().style.width).toBe(`${resizedTotal}px`)

    await act(async () => store.set(activeSessionIdAtom, 'layout-width-b'))
    expect(dock().style.width).toBe(`${initialTotal}px`)
    expect(host.querySelector('[data-testid="resize-handle-right"]')).not.toBe(interruptedHandle)

    await act(async () => store.set(activeSessionIdAtom, 'layout-width-a'))
    expect(dock().style.width).toBe(`${initialTotal}px`)
    const committedHandle = host.querySelector<HTMLElement>('[data-testid="resize-handle-right"]')!
    installPointerCapture(committedHandle)
    await act(async () => {
      committedHandle.dispatchEvent(pointerEvent('pointerdown', 600))
      committedHandle.dispatchEvent(pointerEvent('pointermove', 640))
      committedHandle.dispatchEvent(pointerEvent('pointerup', 640))
    })
    expect(store.get(rightPanelWidthAtom)).toBe(340)
    expect(dock().style.width).toBe(`${resizedTotal}px`)

    await act(async () => store.set(activeSessionIdAtom, 'layout-width-b'))
    expect(store.get(rightPanelWidthAtom)).toBe(380)
    expect(dock().style.width).toBe(`${initialTotal}px`)

    await act(async () => store.set(activeSessionIdAtom, 'layout-width-a'))
    expect(store.get(rightPanelWidthAtom)).toBe(340)
    expect(dock().style.width).toBe(`${resizedTotal}px`)

    await act(async () => root.unmount())
    host.remove()
  })

  it('restores each Session Browser width after dragging the divider', async () => {
    const originalInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 })
    const store = createStore()
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      layout: { ...DEFAULT_SETTINGS.layout, browserPanelWidth: 640 },
    })
    store.set(activeSessionIdAtom, 'layout-browser-width-a')
    store.set(rememberRightPanelStateAtom, 'layout-browser-width-a')
    store.set(activeSessionIdAtom, 'layout-browser-width-b')
    store.set(rememberRightPanelStateAtom, 'layout-browser-width-b')
    store.set(activeSessionIdAtom, 'layout-browser-width-a')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <AppLayout
              left={<div>left</div>}
              center={<div>center</div>}
              right={<div>browser</div>}
              rightKind="browser"
            />
          </Provider>,
        )
      })
      const dock = () => host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')!
      const initialTotal = 640 + RIGHT_PANEL_RAIL_WIDTH
      const resizedTotal = initialTotal - 40
      expect(dock().style.width).toBe(`${initialTotal}px`)

      const handle = host.querySelector<HTMLElement>('[data-testid="resize-handle-right"]')!
      installPointerCapture(handle)
      await act(async () => {
        handle.dispatchEvent(pointerEvent('pointerdown', 600))
        handle.dispatchEvent(pointerEvent('pointermove', 640))
        handle.dispatchEvent(pointerEvent('pointerup', 640))
      })
      expect(store.get(browserDockWidthAtom)).toBe(600)
      expect(dock().style.width).toBe(`${resizedTotal}px`)

      await act(async () => store.set(activeSessionIdAtom, 'layout-browser-width-b'))
      expect(store.get(browserDockWidthAtom)).toBe(640)
      expect(dock().style.width).toBe(`${initialTotal}px`)

      await act(async () => store.set(activeSessionIdAtom, 'layout-browser-width-a'))
      expect(store.get(browserDockWidthAtom)).toBe(600)
      expect(dock().style.width).toBe(`${resizedTotal}px`)
    } finally {
      await act(async () => root.unmount())
      host.remove()
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        value: originalInnerWidth,
      })
    }
  })

  it('removes empty Browser content from the layout only after the final tab closes', async () => {
    const store = createStore()
    const sessionId = 'layout-browser-final-tab-close'
    const tab = (tabId: string): EmbeddedBrowserTabInfo => ({
      tabId,
      targetId: `target-${tabId}`,
      webContentsId: tabId === 'tab-a' ? 21 : 22,
      title: tabId,
      url: 'https://example.com',
      loading: false,
      canGoBack: false,
      canGoForward: false,
      faviconUrl: null,
      crashed: false,
    })
    store.set(activeSessionIdAtom, sessionId)
    store.set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Browser)
    store.set(setEmbeddedBrowserSnapshotAtom, {
      sessions: [{
        sessionId,
        activeTabId: 'tab-a',
        tabs: [tab('tab-a'), tab('tab-b')],
      }],
    })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <AppLayout
            left={<div>left</div>}
            center={<div>center</div>}
            right={<div data-testid="layout-browser-content">browser</div>}
          />
        </Provider>,
      )
    })
    const dock = () => host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')
    expect(dock()?.dataset.contentOpen).toBe('true')
    expect(dock()?.style.width).not.toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)

    await act(async () => {
      store.set(setEmbeddedBrowserSnapshotAtom, {
        sessions: [{ sessionId, activeTabId: 'tab-b', tabs: [tab('tab-b')] }],
      })
      await Promise.resolve()
    })
    expect(dock()?.dataset.contentOpen).toBe('true')

    await act(async () => {
      store.set(setEmbeddedBrowserSnapshotAtom, { sessions: [] })
      await Promise.resolve()
    })
    expect(store.get(rightPanelCollapsedAtom)).toBe(true)
    expect(dock()?.dataset.contentOpen).toBe('false')
    expect(dock()?.style.width).toBe(`${RIGHT_PANEL_RAIL_WIDTH}px`)

    await act(async () => root.unmount())
    host.remove()
  })
})
