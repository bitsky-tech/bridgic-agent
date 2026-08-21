import { afterAll, afterEach, beforeEach, describe, expect, it, jest } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ReactNode } from 'react'
import type { ElectronAPI, EmbeddedBrowserTabInfo } from '@shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { createInstance } = await import('i18next')
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const { default: zh } = await import('@app/shared/i18n/locales/zh.json')
const {
  browserExpandedAtom,
  browserSurfaceBlockedAtom,
  embeddedBrowserSnapshotAtom,
  setEmbeddedBrowserSnapshotAtom,
  setBrowserSurfaceBlockerAtom,
} = await import('@/atoms/browser')
const {
  BROWSER_OVERFLOW_INSPECTION_DELAY_MS,
} = await import('@/hooks/useBrowserOverflowReminder')
const { closeIssueReportAtom, openIssueReportAtom } = await import('@/atoms/issue-report')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const {
  EmbeddedBrowserPanel,
  normalizeAddress,
} = await import('../EmbeddedBrowserPanel')
const { SESSION_STATUS_BAR_HEIGHT_PX } = await import('../SessionStatusBar')
const {
  AppLayout,
  BROWSER_DOCK_MIN,
  browserDockGeometry,
} = await import('../../amphi/AppLayout')
const { RIGHT_PANEL_RAIL_WIDTH } = await import('@/atoms/layout')
const {
  RESIZE_COLLAPSE_DWELL_MS,
  ResizeHandle,
} = await import('../../amphi/ResizeHandle')

const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
let animationFrame: FrameRequestCallback | null = null

class FakeResizeObserver implements ResizeObserver {
  readonly callback: ResizeObserverCallback
  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  animationFrame = null
  globalThis.ResizeObserver = FakeResizeObserver
  globalThis.requestAnimationFrame = (callback) => {
    animationFrame = callback
    return 1
  }
  globalThis.cancelAnimationFrame = () => {
    animationFrame = null
  }
})

afterEach(() => {
  document.body.replaceChildren()
})

afterAll(async () => {
  globalThis.ResizeObserver = originalResizeObserver
  globalThis.requestAnimationFrame = originalRequestAnimationFrame
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  await GlobalRegistrator.unregister()
})

function withZhTranslation(children: ReactNode): ReactNode {
  const i18n = createInstance()
  void i18n
    .use(initReactI18next)
    .init({
      lng: 'zh',
      fallbackLng: 'zh',
      initImmediate: false,
      interpolation: { escapeValue: false },
      resources: { zh: { translation: zh } },
    })
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}

function tab(overrides: Partial<EmbeddedBrowserTabInfo> = {}): EmbeddedBrowserTabInfo {
  return {
    tabId: 'tab-a',
    targetId: 'target-a',
    webContentsId: 10,
    title: 'Amphi Docs',
    url: 'https://example.com/docs',
    loading: false,
    canGoBack: true,
    canGoForward: false,
    faviconUrl: null,
    crashed: false,
    ...overrides,
  }
}

function browserApiCalls() {
  const calls: string[] = []
  const api: ElectronAPI['browser'] = {
    snapshot: async () => ({ sessions: [] }),
    closeSession: async (sessionId) => { calls.push(`closeSession:${sessionId}`) },
    activateSession: async (sessionId) => { calls.push(`activateSession:${sessionId}`) },
    createTab: async (sessionId) => {
      calls.push(`createTab:${sessionId}`)
      return tab({ tabId: 'created' })
    },
    activateTab: async (sessionId, tabId) => { calls.push(`activateTab:${sessionId}:${tabId}`) },
    closeTab: async (sessionId, tabId) => { calls.push(`closeTab:${sessionId}:${tabId}`) },
    navigateTab: async (sessionId, tabId, url) => {
      calls.push(`navigateTab:${sessionId}:${tabId}:${url}`)
    },
    goBack: async (sessionId, tabId) => { calls.push(`goBack:${sessionId}:${tabId}`) },
    goForward: async (sessionId, tabId) => { calls.push(`goForward:${sessionId}:${tabId}`) },
    reload: async (sessionId, tabId) => { calls.push(`reload:${sessionId}:${tabId}`) },
    hasHorizontalOverflow: async () => false,
    setBounds: async ({ x, y, width, height }) => {
      calls.push(`setBounds:${x}:${y}:${width}:${height}`)
    },
    setVisible: async (visible) => { calls.push(`setVisible:${visible}`) },
  }
  ;(window as typeof window & { api: ElectronAPI }).api = { browser: api } as ElectronAPI
  return calls
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function flushMicrotasks(turns = 8): Promise<void> {
  for (let turn = 0; turn < turns; turn += 1) await Promise.resolve()
}

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

function installPointerCapture(element: HTMLElement): () => number | null {
  let captured: number | null = null
  element.setPointerCapture = (pointerId) => { captured = pointerId }
  element.hasPointerCapture = (pointerId) => captured === pointerId
  element.releasePointerCapture = (pointerId) => {
    if (captured === pointerId) captured = null
  }
  return () => captured
}

describe('EmbeddedBrowserPanel', () => {
  it('opens a browser once from the Session empty state and reports progress', async () => {
    browserApiCalls()
    const createCalls: string[] = []
    let resolveCreate: ((value: EmbeddedBrowserTabInfo) => void) | null = null
    window.api.browser.createTab = (sessionId) => {
      createCalls.push(sessionId)
      return new Promise((resolve) => {
        resolveCreate = resolve
      })
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-user')

    await act(async () => {
      root.render(withZhTranslation(<Provider store={store}><EmbeddedBrowserPanel /></Provider>))
    })

    expect(host.textContent).toContain('打开浏览器')
    expect(host.querySelector<HTMLElement>('[data-testid="browser-empty-header"]')?.style.height)
      .toBe(`${SESSION_STATUS_BAR_HEIGHT_PX}px`)
    const open = host.querySelector<HTMLButtonElement>('[data-testid="browser-open-session"]')!
    await act(async () => {
      open.click()
      open.click()
      await Promise.resolve()
    })

    expect(createCalls).toEqual(['session-user'])
    expect(open.disabled).toBe(true)
    expect(host.querySelector('[data-testid="browser-open-status"]')?.textContent).toContain(
      '正在创建浏览器标签页',
    )

    await act(async () => {
      resolveCreate?.(tab({ tabId: 'created' }))
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(createCalls).toEqual(['session-user'])
    expect(open.textContent).toContain('浏览器已打开')
    expect(host.querySelector('[data-testid="browser-open-status"]')?.textContent).toContain(
      '正在同步标签页',
    )

    await act(async () => root.unmount())
  })

  it('shows an open failure and allows one explicit retry', async () => {
    browserApiCalls()
    let attempts = 0
    window.api.browser.createTab = async () => {
      attempts += 1
      if (attempts === 1) throw new Error('controller unavailable')
      return tab({ tabId: 'created' })
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()

    await act(async () => {
      root.render(withZhTranslation(
        <Provider store={store}>
          <EmbeddedBrowserPanel sessionId="session-user" browserSession={null} />
        </Provider>,
      ))
    })
    const open = host.querySelector<HTMLButtonElement>('[data-testid="browser-open-session"]')!

    await act(async () => {
      open.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(attempts).toBe(1)
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('controller unavailable')
    expect(open.textContent).toContain('重新打开')
    expect(open.disabled).toBe(false)

    await act(async () => {
      open.click()
      open.click()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(attempts).toBe(2)
    expect(open.textContent).toContain('浏览器已打开')
    expect(host.querySelector('[role="alert"]')).toBeNull()

    await act(async () => root.unmount())
  })

  it('renders session tabs and exposes tab, navigation, expansion, and close controls', async () => {
    const calls = browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{
        sessionId: 'session-a',
        activeTabId: 'tab-a',
        tabs: [tab(), tab({ tabId: 'tab-b', title: 'Second tab', canGoBack: false })],
      }],
    })

    await act(async () => {
      root.render(withZhTranslation(<Provider store={store}><EmbeddedBrowserPanel /></Provider>))
    })

    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(2)
    expect(host.querySelector<HTMLElement>('[data-testid="browser-tab-strip"]')?.parentElement?.style.height)
      .toBe(`${SESSION_STATUS_BAR_HEIGHT_PX}px`)
    expect(host.textContent).toContain('Amphi Docs')
    expect(host.textContent).toContain('Second tab')

    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })
    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toContain('setBounds:420:96:640:600')

    await act(async () => {
      host.querySelectorAll<HTMLElement>('[role="tab"]')[1]!.click()
      host.querySelector<HTMLButtonElement>('[data-testid="browser-new-tab"]')!.click()
      host.querySelector<HTMLButtonElement>('[aria-label="后退"]')!.click()
      host.querySelector<HTMLButtonElement>('[aria-label="重新加载"]')!.click()
      host.querySelector<HTMLButtonElement>('[data-testid="browser-toggle-expanded"]')!.click()
      await Promise.resolve()
    })

    expect(calls).toContain('activateTab:session-a:tab-b')
    expect(calls).toContain('createTab:session-a')
    expect(calls).toContain('goBack:session-a:tab-a')
    expect(calls).toContain('reload:session-a:tab-a')
    expect(store.get(browserExpandedAtom)).toBe(true)

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="browser-close-session"]')!.click()
      await Promise.resolve()
    })
    expect(calls).toContain('closeSession:session-a')
    expect(store.get(browserExpandedAtom)).toBe(false)

    await act(async () => root.unmount())
  })

  it('checks a loaded page once per Browser presentation and supports dismiss and expand actions', async () => {
    const calls = browserApiCalls()
    const overflowChecks: string[] = []
    window.api.browser.hasHorizontalOverflow = async (sessionId, tabId) => {
      overflowChecks.push(`${sessionId}:${tabId}`)
      return true
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{
        sessionId: 'session-a',
        activeTabId: 'tab-a',
        tabs: [tab(), tab({ tabId: 'tab-b', title: 'Second tab' })],
      }],
    })
    let presentationVisible = false
    const renderPanel = () => withZhTranslation(
      <Provider store={store}>
        <EmbeddedBrowserPanel presentationVisible={presentationVisible} />
      </Provider>,
    )

    await act(async () => {
      root.render(renderPanel())
    })
    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    let canvasWidth = 640
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: canvasWidth,
      height: 600,
      top: 96,
      right: 420 + canvasWidth,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })

    jest.useFakeTimers()
    try {
      await act(async () => {
        presentationVisible = true
        root.render(renderPanel())
        await flushMicrotasks()
      })

      expect(calls).toContain('setVisible:true')
      expect(overflowChecks).toEqual([])
      await act(async () => {
        jest.advanceTimersByTime(BROWSER_OVERFLOW_INSPECTION_DELAY_MS - 1)
        await flushMicrotasks()
      })
      expect(overflowChecks).toEqual([])
      await act(async () => {
        jest.advanceTimersByTime(1)
        await flushMicrotasks()
      })

      expect(overflowChecks).toEqual(['session-a:tab-a'])
      expect(host.querySelector('[data-testid="browser-overflow-reminder"]')?.textContent)
        .toContain('页面较宽')

      await act(async () => {
        host.querySelector<HTMLButtonElement>(
          '[data-testid="browser-overflow-reminder-dismiss"]',
        )?.click()
        await flushMicrotasks()
      })
      expect(host.querySelector('[data-testid="browser-overflow-reminder"]')).toBeNull()

      canvasWidth = 620
      await act(async () => {
        window.dispatchEvent(new Event('resize'))
        animationFrame?.(0)
        await flushMicrotasks()
        jest.advanceTimersByTime(BROWSER_OVERFLOW_INSPECTION_DELAY_MS)
        await flushMicrotasks()
      })
      expect(overflowChecks).toEqual(['session-a:tab-a'])

      await act(async () => {
        presentationVisible = false
        root.render(renderPanel())
        await flushMicrotasks()
      })
      await act(async () => {
        presentationVisible = true
        root.render(renderPanel())
        await flushMicrotasks()
      })
      await act(async () => {
        jest.advanceTimersByTime(BROWSER_OVERFLOW_INSPECTION_DELAY_MS)
        await flushMicrotasks()
      })

      expect(overflowChecks).toEqual(['session-a:tab-a', 'session-a:tab-a'])
      expect(host.querySelector('[data-testid="browser-overflow-reminder"]')).not.toBeNull()

      await act(async () => {
        host.querySelector<HTMLButtonElement>(
          '[data-testid="browser-overflow-reminder-action"]',
        )?.click()
        await flushMicrotasks()
      })
      expect(store.get(browserExpandedAtom)).toBe(true)
      expect(host.querySelector('[data-testid="browser-overflow-reminder"]')).toBeNull()
    } finally {
      await act(async () => root.unmount())
      jest.useRealTimers()
    }
  })

  it('waits for an Agent-revealed blank page to finish navigation before checking once', async () => {
    browserApiCalls()
    const overflowChecks: string[] = []
    window.api.browser.hasHorizontalOverflow = async (sessionId, tabId) => {
      overflowChecks.push(`${sessionId}:${tabId}`)
      return true
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{
        sessionId: 'session-a',
        activeTabId: 'tab-a',
        tabs: [tab({ title: 'New tab', url: 'about:blank' })],
      }],
    })
    const renderPanel = () => withZhTranslation(
      <Provider store={store}>
        <EmbeddedBrowserPanel presentationVisible />
      </Provider>,
    )

    await act(async () => root.render(renderPanel()))
    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })

    await act(async () => {
      animationFrame?.(0)
      await flushMicrotasks()
    })
    expect(overflowChecks).toEqual([])

    jest.useFakeTimers()
    try {
      await act(async () => {
        jest.advanceTimersByTime(BROWSER_OVERFLOW_INSPECTION_DELAY_MS)
        await flushMicrotasks()
      })
      expect(overflowChecks).toEqual([])

      await act(async () => {
        store.set(setEmbeddedBrowserSnapshotAtom, {
          sessions: [{
            sessionId: 'session-a',
            activeTabId: 'tab-a',
            tabs: [tab({
              loading: true,
              title: 'Loading example',
              url: 'https://example.com/search',
            })],
          }],
        })
        await flushMicrotasks()
        jest.advanceTimersByTime(BROWSER_OVERFLOW_INSPECTION_DELAY_MS)
        await flushMicrotasks()
      })
      expect(overflowChecks).toEqual([])

      await act(async () => {
        store.set(setEmbeddedBrowserSnapshotAtom, {
          sessions: [{
            sessionId: 'session-a',
            activeTabId: 'tab-a',
            tabs: [tab({
              loading: false,
              title: 'Example search',
              url: 'https://example.com/search',
            })],
          }],
        })
        await flushMicrotasks()
      })
      await act(async () => {
        jest.advanceTimersByTime(BROWSER_OVERFLOW_INSPECTION_DELAY_MS - 1)
        await flushMicrotasks()
      })
      expect(overflowChecks).toEqual([])
      await act(async () => {
        jest.advanceTimersByTime(1)
        await flushMicrotasks()
      })

      expect(overflowChecks).toEqual(['session-a:tab-a'])
      expect(host.querySelector('[data-testid="browser-overflow-reminder"]')).not.toBeNull()

      await act(async () => {
        store.set(setEmbeddedBrowserSnapshotAtom, {
          sessions: [{
            sessionId: 'session-a',
            activeTabId: 'tab-a',
            tabs: [tab({
              loading: false,
              title: 'Updated title',
              url: 'https://example.com/search',
            })],
          }],
        })
        await flushMicrotasks()
        jest.advanceTimersByTime(BROWSER_OVERFLOW_INSPECTION_DELAY_MS)
        await flushMicrotasks()
      })
      expect(overflowChecks).toEqual(['session-a:tab-a'])
    } finally {
      await act(async () => root.unmount())
      jest.useRealTimers()
    }
  })

  it('activates a live Session on its first hidden mount without presenting it', async () => {
    const calls = browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{ sessionId: 'session-a', activeTabId: 'tab-a', tabs: [tab()] }],
    })

    await act(async () => {
      root.render(withZhTranslation(
        <Provider store={store}>
          <EmbeddedBrowserPanel presentationVisible={false} />
        </Provider>,
      ))
      await Promise.resolve()
      await Promise.resolve()
    })

    const activation = calls.indexOf('activateSession:session-a')
    const firstHide = calls.indexOf('setVisible:false')
    expect(activation).toBeGreaterThanOrEqual(0)
    expect(firstHide).toBeGreaterThan(activation)
    expect(calls).not.toContain('setVisible:true')
    expect(calls).not.toContain('activateSession:null')
    expect(calls.filter((call) => call.startsWith('setBounds:'))).toEqual([])

    await act(async () => root.unmount())
  })

  it('hides a zero-area surface without replacing its bounds and restores valid geometry', async () => {
    const calls = browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{ sessionId: 'session-a', activeTabId: 'tab-a', tabs: [tab()] }],
    })

    await act(async () => {
      root.render(withZhTranslation(<Provider store={store}><EmbeddedBrowserPanel /></Provider>))
    })

    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 0,
      height: 0,
      top: 96,
      right: 420,
      bottom: 96,
      left: 420,
      toJSON: () => ({}),
    })
    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(calls.filter((call) => call.startsWith('setBounds:'))).toEqual([])
    expect(calls).not.toContain('activateSession:session-a')
    expect(calls.at(-1)).toBe('setVisible:false')

    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(calls.slice(-3)).toEqual([
      'setBounds:420:96:640:600',
      'activateSession:session-a',
      'setVisible:true',
    ])

    await act(async () => root.unmount())
  })

  it('keeps the native surface hidden until the fixed-width dock stage is fully revealed', async () => {
    const calls = browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{ sessionId: 'session-a', activeTabId: 'tab-a', tabs: [tab()] }],
    })

    await act(async () => {
      root.render(withZhTranslation(
        <Provider store={store}>
          <div data-testid="session-right-dock" data-browser-dock>
            <EmbeddedBrowserPanel />
          </div>
        </Provider>,
      ))
    })
    const dock = host.querySelector<HTMLElement>('[data-testid="session-right-dock"]')!
    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })
    let dockLeft = 760
    dock.getBoundingClientRect = () => ({
      x: dockLeft,
      y: 44,
      width: 1100 - dockLeft,
      height: 720,
      top: 44,
      right: 1100,
      bottom: 764,
      left: dockLeft,
      toJSON: () => ({}),
    })

    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.filter((call) => call.startsWith('setBounds:'))).toEqual([])
    expect(calls.at(-1)).toBe('setVisible:false')

    dockLeft = 400
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.slice(-3)).toEqual([
      'setBounds:420:96:640:600',
      'activateSession:session-a',
      'setVisible:true',
    ])

    await act(async () => root.unmount())
  })

  it('keeps the native page inside the standard right-dock divider', async () => {
    const calls = browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{ sessionId: 'session-a', activeTabId: 'tab-a', tabs: [tab()] }],
    })

    await act(async () => {
      root.render(withZhTranslation(
        <Provider store={store}>
          <div data-browser-dock>
            <div data-browser-dock-clip>
              <EmbeddedBrowserPanel />
            </div>
          </div>
        </Provider>,
      ))
    })
    const dock = host.querySelector<HTMLElement>('[data-browser-dock]')!
    const clip = host.querySelector<HTMLElement>('[data-browser-dock-clip]')!
    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    dock.getBoundingClientRect = () => ({
      x: 420,
      y: 44,
      width: 680,
      height: 720,
      top: 44,
      right: 1100,
      bottom: 764,
      left: 420,
      toJSON: () => ({}),
    })
    clip.getBoundingClientRect = () => ({
      x: 421,
      y: 44,
      width: 679,
      height: 720,
      top: 44,
      right: 1100,
      bottom: 764,
      left: 421,
      toJSON: () => ({}),
    })
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })

    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(calls).toContain('setBounds:421:96:639:600')
    await act(async () => root.unmount())
  })

  it('switches presentation visibility with fresh geometry without deactivating the Session', async () => {
    const calls = browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{ sessionId: 'session-a', activeTabId: 'tab-a', tabs: [tab()] }],
    })
    const renderPanel = (presentationVisible: boolean) => withZhTranslation(
      <Provider store={store}>
        <EmbeddedBrowserPanel presentationVisible={presentationVisible} />
      </Provider>,
    )

    await act(async () => {
      root.render(renderPanel(true))
    })
    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })
    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.at(-1)).toBe('setVisible:true')

    const deactivationsBefore = calls.filter((call) => call === 'activateSession:null').length
    await act(async () => {
      root.render(renderPanel(false))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.at(-1)).toBe('setVisible:false')
    expect(calls.filter((call) => call === 'activateSession:null')).toHaveLength(deactivationsBefore)

    canvas.getBoundingClientRect = () => ({
      x: 280,
      y: 72,
      width: 820,
      height: 640,
      top: 72,
      right: 1100,
      bottom: 712,
      left: 280,
      toJSON: () => ({}),
    })
    await act(async () => {
      root.render(renderPanel(true))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.slice(-3)).toEqual([
      'setBounds:280:72:820:640',
      'activateSession:session-a',
      'setVisible:true',
    ])

    await act(async () => root.unmount())
  })

  it('immediately queues a focused hide over an in-flight show and acknowledges it once', async () => {
    const calls = browserApiCalls()
    const show = deferred()
    const focusedHide = deferred()
    let hiddenAcknowledgements = 0
    window.api.browser.setVisible = async (visible, focusHost) => {
      calls.push(`setVisible:${visible}:${focusHost === true ? 'focus' : 'plain'}`)
      if (visible) await show.promise
      if (!visible && focusHost === true) await focusedHide.promise
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{ sessionId: 'session-a', activeTabId: 'tab-a', tabs: [tab()] }],
    })
    const renderPanel = (presentationVisible: boolean) => withZhTranslation(
      <Provider store={store}>
        <EmbeddedBrowserPanel
          presentationVisible={presentationVisible}
          onPresentationHidden={() => { hiddenAcknowledgements += 1 }}
        />
      </Provider>,
    )

    await act(async () => {
      root.render(renderPanel(true))
    })
    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })
    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toContain('setVisible:true:plain')

    await act(async () => {
      root.render(renderPanel(false))
      await Promise.resolve()
    })
    expect(calls.at(-1)).toBe('setVisible:false:focus')
    expect(hiddenAcknowledgements).toBe(0)

    await act(async () => {
      focusedHide.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(hiddenAcknowledgements).toBe(1)

    await act(async () => {
      show.resolve()
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.at(-1)).toBe('setVisible:false:plain')
    expect(hiddenAcknowledgements).toBe(1)

    await act(async () => root.unmount())
  })

  it('hides the previous Session before presenting the next Session', async () => {
    const calls = browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const renderPanel = (sessionId: string) => withZhTranslation(
      <EmbeddedBrowserPanel
        sessionId={sessionId}
        browserSession={{
          sessionId,
          activeTabId: `tab-${sessionId}`,
          tabs: [tab({ tabId: `tab-${sessionId}`, targetId: `target-${sessionId}` })],
        }}
      />,
    )

    await act(async () => {
      root.render(renderPanel('session-a'))
    })
    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })
    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })
    calls.length = 0

    await act(async () => {
      root.render(renderPanel('session-b'))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    const hideIndex = calls.indexOf('setVisible:false')
    const deactivateIndex = calls.indexOf('activateSession:null')
    const activateNextIndex = calls.indexOf('activateSession:session-b')
    expect(hideIndex).toBeGreaterThanOrEqual(0)
    expect(deactivateIndex).toBeGreaterThan(hideIndex)
    expect(activateNextIndex).toBeGreaterThan(deactivateIndex)
    expect(calls.at(-1)).toBe('setVisible:true')

    await act(async () => root.unmount())
  })

  it('hides the native browser while issue feedback is open and restores it after closing', async () => {
    const calls = browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{ sessionId: 'session-a', activeTabId: 'tab-a', tabs: [tab()] }],
    })

    await act(async () => {
      root.render(withZhTranslation(<Provider store={store}><EmbeddedBrowserPanel /></Provider>))
    })
    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })
    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.at(-1)).toBe('setVisible:true')

    await act(async () => {
      store.set(openIssueReportAtom, { source: 'renderer' })
      await Promise.resolve()
    })
    expect(calls.at(-1)).toBe('setVisible:false')

    await act(async () => {
      store.set(closeIssueReportAtom)
      await Promise.resolve()
    })
    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls.at(-1)).toBe('setVisible:true')

    await act(async () => root.unmount())
  })

  it('shows a renderer-owned empty state when a Session has no active tab', async () => {
    browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-empty')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{ sessionId: 'session-empty', activeTabId: null, tabs: [] }],
    })

    await act(async () => {
      root.render(withZhTranslation(<Provider store={store}><EmbeddedBrowserPanel /></Provider>))
    })
    expect(host.textContent).toContain('没有打开的标签页')
    expect(host.querySelector<HTMLInputElement>('[data-testid="browser-address"]')?.disabled).toBe(true)

    await act(async () => root.unmount())
  })

  it('replaces the native surface with a branded new tab page while the active tab is blank', async () => {
    const calls = browserApiCalls()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-blank')
    store.set(embeddedBrowserSnapshotAtom, {
      sessions: [{
        sessionId: 'session-blank',
        activeTabId: 'tab-a',
        // Chromium reports the literal URL as the title of a blank page.
        tabs: [tab({ title: 'about:blank', url: 'about:blank' })],
      }],
    })

    await act(async () => {
      root.render(withZhTranslation(
        <Provider store={store}><EmbeddedBrowserPanel presentationVisible /></Provider>,
      ))
    })
    const canvas = host.querySelector<HTMLElement>('[data-testid="browser-canvas"]')!
    canvas.getBoundingClientRect = () => ({
      x: 420,
      y: 96,
      width: 640,
      height: 600,
      top: 96,
      right: 1060,
      bottom: 696,
      left: 420,
      toJSON: () => ({}),
    })
    await act(async () => {
      animationFrame?.(0)
      await flushMicrotasks()
    })
    expect(host.querySelector('[data-testid="browser-new-tab-page"]')).not.toBeNull()
    expect(calls).not.toContain('setVisible:true')
    const address = host.querySelector<HTMLInputElement>('[data-testid="browser-address"]')!
    expect(address.value).toBe('')
    expect(address.disabled).toBe(false)
    const tabStrip = host.querySelector<HTMLElement>('[data-testid="browser-tab-strip"]')!
    expect(tabStrip.textContent).toContain('新建标签页')
    expect(tabStrip.textContent).not.toContain('about:blank')

    await act(async () => {
      store.set(setEmbeddedBrowserSnapshotAtom, {
        sessions: [{
          sessionId: 'session-blank',
          activeTabId: 'tab-a',
          tabs: [tab({ url: 'https://example.com/docs' })],
        }],
      })
      await flushMicrotasks()
    })
    await act(async () => {
      animationFrame?.(0)
      await flushMicrotasks()
    })
    expect(host.querySelector('[data-testid="browser-new-tab-page"]')).toBeNull()
    expect(calls.at(-1)).toBe('setVisible:true')
    expect(address.value).toBe('https://example.com/docs')

    await act(async () => root.unmount())
  })
})

describe('browser workbench layout', () => {
  it('keeps the fixed surface rail outside the persisted browser canvas width', () => {
    expect(browserDockGeometry(1600, null)).toEqual({ width: BROWSER_DOCK_MIN + RIGHT_PANEL_RAIL_WIDTH, min: BROWSER_DOCK_MIN + RIGHT_PANEL_RAIL_WIDTH, max: 1180 })
    expect(browserDockGeometry(1000, null)).toEqual({ width: BROWSER_DOCK_MIN + RIGHT_PANEL_RAIL_WIDTH, min: BROWSER_DOCK_MIN + RIGHT_PANEL_RAIL_WIDTH, max: 600 })
    expect(browserDockGeometry(700, null)).toEqual({ width: 420, min: 420, max: 420 })
    expect(browserDockGeometry(400, null)).toEqual({ width: 240, min: 240, max: 240 })
    expect(browserDockGeometry(1600, 640)).toEqual({ width: 640 + RIGHT_PANEL_RAIL_WIDTH, min: BROWSER_DOCK_MIN + RIGHT_PANEL_RAIL_WIDTH, max: 1180 })
  })

  it('normalizes addresses without treating ordinary search text as a host', () => {
    expect(normalizeAddress('example.com/docs')).toBe('https://example.com/docs')
    expect(normalizeAddress('localhost:5173')).toBe('http://localhost:5173')
    expect(normalizeAddress('缺氧 攻略')).toBe(
      'https://www.google.com/search?q=%E7%BC%BA%E6%B0%A7%20%E6%94%BB%E7%95%A5',
    )
  })

  it('keeps the native surface hidden until every independent blocker releases it', () => {
    const store = createStore()
    store.set(setBrowserSurfaceBlockerAtom, { source: 'resize', blocked: true })
    store.set(setBrowserSurfaceBlockerAtom, { source: 'menu', blocked: true })
    store.set(setBrowserSurfaceBlockerAtom, { source: 'resize', blocked: false })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(true)
    store.set(setBrowserSurfaceBlockerAtom, { source: 'menu', blocked: false })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)
  })

  it('keeps the native browser visible while its dock width is dragged', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()

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

    const handle = host.querySelector<HTMLElement>('[data-testid="resize-handle-right"]')!
    const capturedPointer = installPointerCapture(handle)
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', 600))
    })

    expect(capturedPointer()).toBe(7)
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)
    await act(async () => root.unmount())
  })

  it('captures a resize pointer and commits the last clamped width', async () => {
    const resized: number[] = []
    const committed: number[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <ResizeHandle
          side="right"
          width={640}
          min={520}
          max={900}
          onResize={(width) => resized.push(width)}
          onCommit={(width) => committed.push(width)}
        />,
      )
    })

    const handle = host.querySelector<HTMLElement>('[data-testid="resize-handle-right"]')!
    const capturedPointer = installPointerCapture(handle)
    await act(async () => {
      handle.dispatchEvent(pointerEvent('pointerdown', 600))
      handle.dispatchEvent(pointerEvent('pointermove', 500))
      handle.dispatchEvent(pointerEvent('pointermove', 200))
      handle.dispatchEvent(pointerEvent('pointerup', 200))
    })

    expect(resized).toEqual([740, 900])
    expect(committed).toEqual([900])
    expect(capturedPointer()).toBeNull()
    await act(async () => root.unmount())
  })

  it('collapses only after dwelling beyond the right resize minimum', async () => {
    const committed: number[] = []
    const collapsed: number[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <ResizeHandle
          side="right"
          width={640}
          min={520}
          max={900}
          collapseOvershoot={24}
          onResize={() => undefined}
          onCommit={(width) => committed.push(width)}
          onCollapse={(minimumWidth) => collapsed.push(minimumWidth)}
        />,
      )
    })

    jest.useFakeTimers()
    try {
      const handle = host.querySelector<HTMLElement>('[data-testid="resize-handle-right"]')!
      installPointerCapture(handle)
      await act(async () => {
        handle.dispatchEvent(pointerEvent('pointerdown', 600))
        handle.dispatchEvent(pointerEvent('pointermove', 750))
        jest.advanceTimersByTime(RESIZE_COLLAPSE_DWELL_MS - 1)
        handle.dispatchEvent(pointerEvent('pointerup', 750))
      })
      expect(committed).toEqual([520])
      expect(collapsed).toEqual([])

      await act(async () => {
        handle.dispatchEvent(pointerEvent('pointerdown', 600))
        handle.dispatchEvent(pointerEvent('pointermove', 750))
        jest.advanceTimersByTime(RESIZE_COLLAPSE_DWELL_MS)
        handle.dispatchEvent(pointerEvent('pointerup', 750))
      })
      expect(committed).toEqual([520])
      expect(collapsed).toEqual([520])

      await act(async () => {
        handle.dispatchEvent(pointerEvent('pointerdown', 600))
        handle.dispatchEvent(pointerEvent('pointermove', 750))
        jest.advanceTimersByTime(RESIZE_COLLAPSE_DWELL_MS)
        handle.dispatchEvent(pointerEvent('pointercancel', 750))
      })
      expect(committed).toEqual([520, 520])
      expect(collapsed).toEqual([520])
    } finally {
      await act(async () => root.unmount())
      jest.useRealTimers()
    }
  })

  it('cancels an armed collapse immediately after dragging back', async () => {
    const committed: number[] = []
    const collapsed: number[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <ResizeHandle
          side="right"
          width={640}
          min={520}
          max={900}
          collapseOvershoot={24}
          onResize={() => undefined}
          onCommit={(width) => committed.push(width)}
          onCollapse={(minimumWidth) => collapsed.push(minimumWidth)}
        />,
      )
    })

    jest.useFakeTimers()
    try {
      const handle = host.querySelector<HTMLElement>('[data-testid="resize-handle-right"]')!
      installPointerCapture(handle)
      await act(async () => {
        handle.dispatchEvent(pointerEvent('pointerdown', 600))
        handle.dispatchEvent(pointerEvent('pointermove', 750))
        jest.advanceTimersByTime(RESIZE_COLLAPSE_DWELL_MS)
        handle.dispatchEvent(pointerEvent('pointermove', 720))
        handle.dispatchEvent(pointerEvent('pointermove', 750))
        jest.advanceTimersByTime(RESIZE_COLLAPSE_DWELL_MS - 1)
        handle.dispatchEvent(pointerEvent('pointerup', 750))
      })
      expect(committed).toEqual([520])
      expect(collapsed).toEqual([])
    } finally {
      await act(async () => root.unmount())
      jest.useRealTimers()
    }
  })
})
