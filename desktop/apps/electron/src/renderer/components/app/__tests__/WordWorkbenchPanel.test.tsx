import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ElectronAPI, WordHostOpenRequest, WordHostSessionInfo } from '@shared/types'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { createInstance } = await import('i18next')
const { I18nextProvider, initReactI18next } = await import('react-i18next')
const { default: zh } = await import('@app/shared/i18n/locales/zh.json')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { nativeSurfaceRectAtom, setBrowserSurfaceBlockerAtom } = await import('@/atoms/browser')
const { requestWordFileOpenAtom, wordFileOpenRequestAtom, wordHostSnapshotAtom } = await import('@/atoms/word')
const { WordWorkbenchPanel } = await import('../WordWorkbenchPanel')

const roots = new Set<Root>()
const originalResizeObserver = globalThis.ResizeObserver
const originalRequestAnimationFrame = globalThis.requestAnimationFrame
const originalCancelAnimationFrame = globalThis.cancelAnimationFrame
const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect
const frames = new Map<number, FrameRequestCallback>()
let nextFrame = 0

class FakeResizeObserver implements ResizeObserver {
  constructor(readonly callback: ResizeObserverCallback) {}
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  frames.clear()
  globalThis.ResizeObserver = FakeResizeObserver
  globalThis.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame }
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id) }
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.dataset.testid === 'word-native-viewport'
      ? { x: 300, y: 60, width: 720, height: 500, left: 300, top: 60, right: 1020, bottom: 560, toJSON: () => ({}) }
      : originalGetBoundingClientRect.call(this)
  }
})
afterEach(async () => {
  await act(async () => { for (const root of roots) root.unmount() })
  roots.clear()
  document.body.replaceChildren()
})
afterAll(async () => {
  globalThis.ResizeObserver = originalResizeObserver
  globalThis.requestAnimationFrame = originalRequestAnimationFrame
  globalThis.cancelAnimationFrame = originalCancelAnimationFrame
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect
  await GlobalRegistrator.unregister()
})

function session(sessionId: string, overrides: Partial<WordHostSessionInfo> = {}): WordHostSessionInfo {
  return {
    sessionId, targetId: `word-${sessionId}`, webContentsId: sessionId === 'a' ? 1 : 2,
    loading: false, crashed: false, documentCount: 1, persistenceStatus: 'saved', expanded: false,
    ...overrides,
  }
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((accept, fail) => { resolve = accept; reject = fail })
  return { promise, resolve, reject }
}

function fixture() {
  const calls: string[] = []
  const imports: WordHostOpenRequest[] = []
  const store = createStore()
  store.set(settingsAtom, { ...store.get(settingsAtom), ui: { ...store.get(settingsAtom).ui, lastNav: 'home' } })
  store.set(activeSessionIdAtom, 'a')
  const api: ElectronAPI['wordHost'] = {
    snapshot: async () => store.get(wordHostSnapshotAtom),
    ensureSession: async (id) => { calls.push(`ensure:${id}`); return session(id) },
    closeSession: async (id) => { calls.push(`close:${id}`) },
    openFile: async (id, request) => { calls.push(`open:${id}`); imports.push(request) },
    activateSession: async (id) => { calls.push(`activate:${id}`) },
    setBounds: async ({ x, y, width, height }) => { calls.push(`bounds:${x}:${y}:${width}:${height}`) },
    setVisible: async (visible) => { calls.push(`visible:${visible}`) },
  }
  ;(window as typeof window & { api: ElectronAPI }).api = { wordHost: api } as ElectronAPI
  return { api, calls, imports, store }
}

async function mount(state: ReturnType<typeof fixture>, active = true) {
  const i18n = createInstance()
  await i18n.use(initReactI18next).init({
    lng: 'zh', fallbackLng: 'zh', initImmediate: false,
    interpolation: { escapeValue: false }, resources: { zh: { translation: zh } },
  })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.add(root)
  const render = async (visible: boolean) => {
    await act(async () => root.render(
      <I18nextProvider i18n={i18n}><Provider store={state.store}><WordWorkbenchPanel active={visible} /></Provider></I18nextProvider>,
    ))
  }
  await render(active)
  return { host, root, render }
}

describe('Word native workbench integration', () => {
  it('ensures a Session only when its Word panel becomes active', async () => {
    const state = fixture()
    const { render } = await mount(state, false)
    expect(state.calls.filter((call) => call.startsWith('ensure:'))).toEqual([])
    await render(true)
    expect(state.calls.filter((call) => call.startsWith('ensure:'))).toEqual(['ensure:a'])
    expect(state.calls).not.toContain('visible:true')
    await act(async () => state.store.set(wordHostSnapshotAtom, { sessions: [session('a')] }))
    expect(state.calls).toContain('bounds:300:60:720:500')
    expect(state.calls).toContain('activate:a')
    expect(state.calls.at(-1)).toBe('visible:true')
  })

  it('hides and detaches the native view while preserving its documents and Session target', async () => {
    const state = fixture()
    state.store.set(wordHostSnapshotAtom, { sessions: [session('a')] })
    const { render } = await mount(state)
    expect(state.store.get(nativeSurfaceRectAtom)).toEqual({ x: 300, y: 60, width: 720, height: 500 })
    await render(false)
    expect(state.calls).toContain('activate:null')
    expect(state.calls.at(-1)).toBe('visible:false')
    expect(state.calls.filter((call) => call.startsWith('close:'))).toEqual([])
    expect(state.store.get(nativeSurfaceRectAtom)).toBeNull()
    expect(state.store.get(wordHostSnapshotAtom).sessions).toEqual([session('a')])
    await render(true)
    expect(state.calls.at(-1)).toBe('visible:true')
  })

  it('keeps the native view hidden behind a renderer overlay and restores it afterward', async () => {
    const state = fixture()
    state.store.set(wordHostSnapshotAtom, { sessions: [session('a')] })
    await mount(state)
    await act(async () => state.store.set(setBrowserSurfaceBlockerAtom, { source: 'test-modal', blocked: true }))
    expect(state.calls.at(-1)).toBe('visible:false')
    expect(state.store.get(nativeSurfaceRectAtom)).toBeNull()
    await act(async () => state.store.set(setBrowserSurfaceBlockerAtom, { source: 'test-modal', blocked: false }))
    expect(state.calls.at(-1)).toBe('visible:true')
    expect(state.calls.filter((call) => call.startsWith('close:'))).toEqual([])
    expect(state.calls.filter((call) => call.startsWith('ensure:'))).toEqual(['ensure:a'])
  })

  it('completes an imported file in its original Session without clearing the newly viewed Session request', async () => {
    const state = fixture()
    const openingA = deferred()
    const openingB = deferred()
    state.api.openFile = (id, request) => {
      state.imports.push(request)
      return id === 'a' ? openingA.promise : openingB.promise
    }
    state.store.set(requestWordFileOpenAtom, { name: 'a.docx', path: '/tmp/a.docx' })
    await mount(state)
    const requestA = state.imports[0]!
    await act(async () => {
      state.store.set(activeSessionIdAtom, 'b')
      state.store.set(requestWordFileOpenAtom, { name: 'b.docx', path: '/tmp/b.docx' })
    })
    const requestB = state.store.get(wordFileOpenRequestAtom)
    expect(requestB?.sessionId).toBe('b')
    await act(async () => openingA.resolve())
    expect(state.store.get(wordFileOpenRequestAtom)).toEqual(requestB)
    await act(async () => state.store.set(activeSessionIdAtom, 'a'))
    expect(state.store.get(wordFileOpenRequestAtom)).toBeNull()
    expect(state.imports.filter((request) => request.id === requestA.id)).toHaveLength(1)
    await act(async () => state.store.set(activeSessionIdAtom, 'b'))
    expect(state.store.get(wordFileOpenRequestAtom)).toEqual(requestB)
    await act(async () => openingB.resolve())
    expect(state.store.get(wordFileOpenRequestAtom)).toBeNull()
  })

  it('keeps a replacement request when an older import finishes in the same Session', async () => {
    const state = fixture()
    const first = deferred()
    const second = deferred()
    state.api.openFile = (_id, request) => {
      state.imports.push(request)
      return request.path === '/tmp/first.docx' ? first.promise : second.promise
    }
    state.store.set(requestWordFileOpenAtom, { name: 'first.docx', path: '/tmp/first.docx' })
    await mount(state)
    await act(async () => state.store.set(requestWordFileOpenAtom, { name: 'second.docx', path: '/tmp/second.docx' }))
    const replacement = state.store.get(wordFileOpenRequestAtom)
    await act(async () => first.resolve())
    expect(state.store.get(wordFileOpenRequestAtom)).toEqual(replacement)
    await act(async () => second.resolve())
    expect(state.store.get(wordFileOpenRequestAtom)).toBeNull()
  })

  it('releases a crashed target before retrying and displays the replacement target', async () => {
    const state = fixture()
    state.store.set(wordHostSnapshotAtom, { sessions: [session('a', { crashed: true, targetId: null })] })
    const closing = deferred()
    state.api.closeSession = async (id) => {
      state.calls.push(`close:${id}`)
      await closing.promise
      state.store.set(wordHostSnapshotAtom, { sessions: [] })
    }
    const { host } = await mount(state)
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="word-host-retry"]')!
    expect(retry).not.toBeNull()
    expect(state.calls).not.toContain('visible:true')
    state.calls.length = 0
    state.api.ensureSession = async (id) => {
      state.calls.push(`ensure:${id}`)
      const restored = session(id, { targetId: 'word-replacement' })
      state.store.set(wordHostSnapshotAtom, { sessions: [restored] })
      return restored
    }
    await act(async () => retry.click())
    expect(retry.disabled).toBe(true)
    expect(state.calls).toEqual(['close:a'])
    await act(async () => closing.resolve())
    expect(state.calls.indexOf('close:a')).toBeLessThan(state.calls.indexOf('ensure:a'))
    expect(state.calls.at(-1)).toBe('visible:true')
    expect(host.querySelector('[data-testid="word-host-retry"]')).toBeNull()
  })

  it('does not carry a failed Session startup message into another Session while it loads', async () => {
    const state = fixture()
    const loadingB = deferred<WordHostSessionInfo>()
    state.api.ensureSession = async (id) => {
      if (id === 'a') throw new Error('Session A could not start')
      return loadingB.promise
    }
    const { host } = await mount(state)
    expect(host.querySelector('[data-testid="word-host-retry"]')).not.toBeNull()
    await act(async () => state.store.set(activeSessionIdAtom, 'b'))
    expect(host.querySelector('[data-testid="word-host-retry"]')).toBeNull()
    expect(host.querySelector('[role="alert"]')).toBeNull()
    await act(async () => loadingB.resolve(session('b')))
  })
})
