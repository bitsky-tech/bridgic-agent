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
const { setEmbeddedPowerPointSnapshotAtom } = await import('@/atoms/powerpoint')
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
  }
}

function sessionInfo(sessionId: string): EmbeddedPowerPointSessionInfo {
  return {
    sessionId,
    targetId: 'ppt-target',
    webContentsId: 42,
    loading: false,
    crashed: false,
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
  it('does not create a PPT until the user clicks the empty-state action', async () => {
    const calls: string[] = []
    const api = powerPointApi(calls)
    let resolveCreate: ((session: EmbeddedPowerPointSessionInfo) => void) | null = null
    api.ensureSession = (sessionId) => {
      calls.push(`ensureSession:${sessionId}`)
      return new Promise((resolve) => { resolveCreate = resolve })
    }
    ;(window as typeof window & { api: ElectronAPI }).api = { powerpoint: api } as ElectronAPI
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-ppt-empty')
    const { host, root } = await mountPanel(store)

    expect(host.textContent).toContain('新建 PPT')
    expect(host.querySelector('[data-testid="embedded-powerpoint-viewport"]')).toBeNull()
    expect(calls.filter((call) => call.startsWith('ensureSession:'))).toEqual([])

    const create = host.querySelector<HTMLButtonElement>(
      '[data-testid="powerpoint-create-session"]',
    )!
    await act(async () => {
      create.click()
      create.click()
      await Promise.resolve()
    })

    expect(calls.filter((call) => call.startsWith('ensureSession:')))
      .toEqual(['ensureSession:session-ppt-empty'])
    expect(create.disabled).toBe(true)
    expect(host.querySelector('[data-testid="powerpoint-create-status"]')?.textContent)
      .toContain('正在创建演示文稿')

    await act(async () => {
      resolveCreate?.(sessionInfo('session-ppt-empty'))
      await Promise.resolve()
    })
    expect(create.textContent).toContain('PPT 已创建')

    await act(async () => root.unmount())
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

    await act(async () => root.unmount())
  })
})
