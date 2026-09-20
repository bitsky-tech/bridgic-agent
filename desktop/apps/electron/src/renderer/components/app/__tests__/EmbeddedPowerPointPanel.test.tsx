import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ElectronAPI, EmbeddedPowerPointSessionInfo } from '@shared/types'
import type { ReactNode } from 'react'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { createInstance } = await import('i18next')
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const { default: zh } = await import('@app/shared/i18n/locales/zh.json')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { setEmbeddedPowerPointSnapshotAtom, pendingPowerPointFileOpensAtom } = await import('@/atoms/powerpoint')
const { EmbeddedPowerPointPanel } = await import('../EmbeddedPowerPointPanel')

const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
let animationFrame: FrameRequestCallback | null = null

class FakeResizeObserver implements ResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
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
  globalThis.cancelAnimationFrame = () => { animationFrame = null }
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
  void i18n.use(initReactI18next).init({
    lng: 'zh',
    fallbackLng: 'zh',
    initImmediate: false,
    interpolation: { escapeValue: false },
    resources: { zh: { translation: zh } },
  })
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
}

function powerPointApi(calls: string[]): ElectronAPI['powerpoint'] {
  return {
    snapshot: async () => ({ sessions: [] }),
    ensureSession: async (sessionId) => {
      calls.push(`ensureSession:${sessionId}`)
      return sessionInfo(sessionId)
    },
    closeSession: async () => undefined,
    activateSession: async (sessionId) => { calls.push(`activateSession:${sessionId}`) },
    setBounds: async ({ x, y, width, height }) => {
      calls.push(`setBounds:${x}:${y}:${width}:${height}`)
    },
    setVisible: async (visible) => { calls.push(`setVisible:${visible}`) },
    requestClose: async () => undefined,
    setExpanded: async () => undefined,
    reportState: async () => undefined,
    openFile: async (_sessionId, absPath) => ({
      documentId: 'document-1',
      fileName: absPath.split('/').at(-1) ?? '',
      reused: false,
      slideCount: 1,
      title: 'Deck',
    }),
  }
}

function sessionInfo(sessionId: string): EmbeddedPowerPointSessionInfo {
  return {
    sessionId,
    targetId: 'ppt-target',
    webContentsId: 42,
    loading: false,
    crashed: false,
    documentCount: null,
  }
}

async function mountPanel(store: ReturnType<typeof createStore>) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(withZhTranslation(
      <Provider store={store}><EmbeddedPowerPointPanel active /></Provider>,
    ))
  })
  return { host, root }
}

describe('EmbeddedPowerPointPanel', () => {
  it('hides the native startup deck until the clicked file finishes importing', async () => {
    const calls: string[] = []
    window.api = { powerpoint: powerPointApi(calls) } as ElectronAPI
    const store = createStore()
    const sessionId = 'session-import'
    store.set(activeSessionIdAtom, sessionId)
    store.set(pendingPowerPointFileOpensAtom, [{ sessionId, path: '/tmp/deck.pptx' }])
    const { host, root } = await mountPanel(store)
    try {
      expect(host.textContent).toContain('正在打开 PowerPoint')
      expect(host.querySelector('[data-testid="powerpoint-create-session"]')).toBeNull()
      await act(async () => store.set(setEmbeddedPowerPointSnapshotAtom, { sessions: [sessionInfo(sessionId)] }))
      expect(calls).not.toContain('setVisible:true')
      expect(host.textContent).toContain('正在打开 PowerPoint')
      host.querySelector<HTMLElement>('[data-testid="embedded-powerpoint-viewport"]')!.getBoundingClientRect = () => (
        { x: 10, y: 20, width: 900, height: 600, top: 20, right: 910, bottom: 620, left: 10, toJSON: () => ({}) }
      )
      await act(async () => store.set(pendingPowerPointFileOpensAtom, []))
      await act(async () => { animationFrame?.(0) })
      expect(calls).toContain('setVisible:true')
      expect(host.textContent).not.toContain('正在打开 PowerPoint')
    } finally {
      await act(async () => root.unmount())
    }
  })

  it('restores the Session on rail activation before offering document creation', async () => {
    const calls: string[] = []
    const api = powerPointApi(calls)
    let finish!: () => void
    const store = createStore()
    const sessionId = 'session-ppt-restore'
    api.ensureSession = async (id) => {
      calls.push(`ensureSession:${id}`)
      await new Promise<void>((resolve) => { finish = resolve })
      const restored = sessionInfo(id)
      store.set(setEmbeddedPowerPointSnapshotAtom, { sessions: [restored] })
      return restored
    }
    window.api = { powerpoint: api } as ElectronAPI
    store.set(activeSessionIdAtom, sessionId)
    const { host, root } = await mountPanel(store)
    try {
      expect(calls.filter((call) => call.startsWith('ensureSession:'))).toEqual([`ensureSession:${sessionId}`])
      expect(host.querySelector('[data-testid="office-session-restoring"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="powerpoint-create-session"]')).toBeNull()
      await act(async () => finish())
      expect(host.querySelector('[data-testid="embedded-powerpoint-viewport"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="office-session-restoring"]')).toBeNull()
    } finally { await act(async () => root.unmount()) }
  })

  it('attaches the native viewport only after the Session surface exists', async () => {
    const calls: string[] = []
    ;(window as typeof window & { api: ElectronAPI }).api = {
      powerpoint: powerPointApi(calls),
    } as ElectronAPI
    const store = createStore()
    const sessionId = 'session-ppt-open'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setEmbeddedPowerPointSnapshotAtom, { sessions: [sessionInfo(sessionId)] })
    const { host, root } = await mountPanel(store)
    const viewport = host.querySelector<HTMLElement>(
      '[data-testid="embedded-powerpoint-viewport"]',
    )!
    viewport.getBoundingClientRect = () => ({
      x: 10,
      y: 20,
      width: 900,
      height: 600,
      top: 20,
      right: 910,
      bottom: 620,
      left: 10,
      toJSON: () => ({}),
    })

    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(calls).toEqual([
      `ensureSession:${sessionId}`,
      'setBounds:10:20:900:600',
      `activateSession:${sessionId}`,
      'setVisible:true',
    ])

    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(calls).toHaveLength(4)

    await act(async () => root.unmount())
  })

  it('keeps the native PPT surface inside the right-dock divider', async () => {
    const calls: string[] = []
    ;(window as typeof window & { api: ElectronAPI }).api = {
      powerpoint: powerPointApi(calls),
    } as ElectronAPI
    const store = createStore()
    const sessionId = 'session-ppt-divider'
    store.set(activeSessionIdAtom, sessionId)
    store.set(setEmbeddedPowerPointSnapshotAtom, { sessions: [sessionInfo(sessionId)] })
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(withZhTranslation(
        <Provider store={store}>
          <div data-browser-dock>
            <div data-browser-dock-clip>
              <EmbeddedPowerPointPanel active />
            </div>
          </div>
        </Provider>,
      ))
    })
    const clip = host.querySelector<HTMLElement>('[data-browser-dock-clip]')!
    const viewport = host.querySelector<HTMLElement>(
      '[data-testid="embedded-powerpoint-viewport"]',
    )!
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
    viewport.getBoundingClientRect = () => ({
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

    await act(async () => {
      animationFrame?.(0)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
    })

    expect(calls).toContain('setBounds:421:44:679:720')
    await act(async () => root.unmount())
  })
})
