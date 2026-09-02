import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type {
  ElectronAPI,
  EmbeddedBrowserSnapshot,
  EmbeddedBrowserTabInfo,
} from '@shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { embeddedBrowserSnapshotAtom } = await import('@/atoms/browser')
const { browserNeedsAttentionFamily } = await import('@/atoms/browser-attention')
const { useEmbeddedBrowserBridge } = await import('../useEmbeddedBrowserBridge')

afterEach(() => document.body.replaceChildren())
afterAll(async () => GlobalRegistrator.unregister())

function Harness() {
  useEmbeddedBrowserBridge()
  return null
}

function browserTab(tabId: string): EmbeddedBrowserTabInfo {
  return {
    tabId,
    targetId: `target-${tabId}`,
    webContentsId: tabId === 'tab-original' ? 1 : 2,
    title: tabId,
    url: 'https://example.com',
    loading: false,
    canGoBack: false,
    canGoForward: false,
    faviconUrl: null,
    crashed: false,
  }
}

describe('useEmbeddedBrowserBridge', () => {
  it('does not let a stale initial snapshot overwrite a newer pushed event', async () => {
    let resolveInitial!: (snapshot: EmbeddedBrowserSnapshot) => void
    let onChanged: ((snapshot: EmbeddedBrowserSnapshot) => void) | null = null
    const initial = new Promise<EmbeddedBrowserSnapshot>((resolve) => {
      resolveInitial = resolve
    })
    const browser = {
      snapshot: () => initial,
    } as ElectronAPI['browser']
    const events = {
      onEmbeddedBrowserChanged: (callback: (snapshot: EmbeddedBrowserSnapshot) => void) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    } as ElectronAPI['events']
    ;(window as typeof window & { api: ElectronAPI }).api = { browser, events } as ElectronAPI

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    await act(async () => {
      root.render(<Provider store={store}><Harness /></Provider>)
    })

    const current = {
      sessions: [{ sessionId: 'session-current', activeTabId: null, tabs: [], workbenches: [] }],
    }
    await act(async () => {
      onChanged?.(current)
      resolveInitial({ sessions: [] })
      await initial
    })

    expect(store.get(embeddedBrowserSnapshotAtom)).toEqual(current)
    await act(async () => root.unmount())
  })

  it('latches new tabs for background Sessions after initial hydration', async () => {
    let onChanged: ((snapshot: EmbeddedBrowserSnapshot) => void) | null = null
    const initial: EmbeddedBrowserSnapshot = {
      sessions: [{
        sessionId: 'session-background',
        activeTabId: 'tab-original',
        tabs: [browserTab('tab-original')],
        workbenches: [],
      }],
    }
    const browser = {
      snapshot: async () => initial,
    } as ElectronAPI['browser']
    const events = {
      onEmbeddedBrowserChanged: (callback: (snapshot: EmbeddedBrowserSnapshot) => void) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    } as ElectronAPI['events']
    ;(window as typeof window & { api: ElectronAPI }).api = { browser, events } as ElectronAPI

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    await act(async () => {
      root.render(<Provider store={store}><Harness /></Provider>)
      await Promise.resolve()
    })
    expect(store.get(browserNeedsAttentionFamily('session-background'))).toBe(false)

    const popup = {
      ...browserTab('tab-popup'),
      title: 'Popup',
    }
    await act(async () => {
      onChanged?.({
        sessions: [{
          ...initial.sessions[0]!,
          tabs: [...initial.sessions[0]!.tabs, popup],
          workbenches: [],
        }],
      })
    })

    expect(store.get(browserNeedsAttentionFamily('session-background'))).toBe(true)
    await act(async () => root.unmount())
  })

  it('diffs a first pushed popup against a delayed initial snapshot without rolling UI back', async () => {
    let resolveInitial!: (snapshot: EmbeddedBrowserSnapshot) => void
    let onChanged: ((snapshot: EmbeddedBrowserSnapshot) => void) | null = null
    const initialPromise = new Promise<EmbeddedBrowserSnapshot>((resolve) => {
      resolveInitial = resolve
    })
    const browser = { snapshot: () => initialPromise } as ElectronAPI['browser']
    const events = {
      onEmbeddedBrowserChanged: (callback: (snapshot: EmbeddedBrowserSnapshot) => void) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    } as ElectronAPI['events']
    ;(window as typeof window & { api: ElectronAPI }).api = { browser, events } as ElectronAPI

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    await act(async () => root.render(<Provider store={store}><Harness /></Provider>))

    const pushed: EmbeddedBrowserSnapshot = {
      sessions: [{
        sessionId: 'session-race',
        activeTabId: 'tab-popup',
        tabs: [browserTab('tab-original'), browserTab('tab-popup')],
        workbenches: [],
      }],
    }
    await act(async () => onChanged?.(pushed))
    expect(store.get(browserNeedsAttentionFamily('session-race'))).toBe(false)

    await act(async () => {
      resolveInitial({
        sessions: [{
          sessionId: 'session-race',
          activeTabId: 'tab-original',
          tabs: [browserTab('tab-original')],
          workbenches: [],
        }],
      })
      await initialPromise
    })

    expect(store.get(browserNeedsAttentionFamily('session-race'))).toBe(true)
    expect(store.get(embeddedBrowserSnapshotAtom)).toEqual(pushed)
    await act(async () => root.unmount())
  })

  it('latches a transient popup that opens and closes before initial hydration resolves', async () => {
    let resolveInitial!: (snapshot: EmbeddedBrowserSnapshot) => void
    let onChanged: ((snapshot: EmbeddedBrowserSnapshot) => void) | null = null
    const initialPromise = new Promise<EmbeddedBrowserSnapshot>((resolve) => {
      resolveInitial = resolve
    })
    const browser = { snapshot: () => initialPromise } as ElectronAPI['browser']
    const events = {
      onEmbeddedBrowserChanged: (callback: (snapshot: EmbeddedBrowserSnapshot) => void) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    } as ElectronAPI['events']
    ;(window as typeof window & { api: ElectronAPI }).api = { browser, events } as ElectronAPI

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    await act(async () => root.render(<Provider store={store}><Harness /></Provider>))

    const original: EmbeddedBrowserSnapshot = {
      sessions: [{
        sessionId: 'session-transient-popup',
        activeTabId: 'tab-original',
        tabs: [browserTab('tab-original')],
        workbenches: [],
      }],
    }
    const withPopup: EmbeddedBrowserSnapshot = {
      sessions: [{
        ...original.sessions[0]!,
        tabs: [browserTab('tab-original'), browserTab('tab-popup')],
        workbenches: [],
      }],
    }
    await act(async () => {
      onChanged?.(withPopup)
      onChanged?.(original)
    })
    expect(store.get(browserNeedsAttentionFamily('session-transient-popup'))).toBe(false)

    await act(async () => {
      resolveInitial(original)
      await initialPromise
    })

    expect(store.get(browserNeedsAttentionFamily('session-transient-popup'))).toBe(true)
    expect(store.get(embeddedBrowserSnapshotAtom)).toEqual(original)
    await act(async () => root.unmount())
  })

  it('latches a transient first popup even when initial hydration fails', async () => {
    let rejectInitial!: (error: Error) => void
    let onChanged: ((snapshot: EmbeddedBrowserSnapshot) => void) | null = null
    const initialPromise = new Promise<EmbeddedBrowserSnapshot>((_resolve, reject) => {
      rejectInitial = reject
    })
    const browser = { snapshot: () => initialPromise } as ElectronAPI['browser']
    const events = {
      onEmbeddedBrowserChanged: (callback: (snapshot: EmbeddedBrowserSnapshot) => void) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    } as ElectronAPI['events']
    ;(window as typeof window & { api: ElectronAPI }).api = { browser, events } as ElectronAPI

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    await act(async () => root.render(<Provider store={store}><Harness /></Provider>))

    const withPopup: EmbeddedBrowserSnapshot = {
      sessions: [{
        sessionId: 'session-transient-after-failure',
        activeTabId: 'tab-popup',
        tabs: [browserTab('tab-popup')],
        workbenches: [],
      }],
    }
    const afterClose: EmbeddedBrowserSnapshot = {
      sessions: [{
        sessionId: 'session-transient-after-failure',
        activeTabId: null,
        tabs: [],
        workbenches: [],
      }],
    }
    await act(async () => {
      onChanged?.(withPopup)
      onChanged?.(afterClose)
      rejectInitial(new Error('snapshot unavailable'))
      await initialPromise.catch(() => undefined)
    })

    expect(store.get(browserNeedsAttentionFamily('session-transient-after-failure'))).toBe(true)
    expect(store.get(embeddedBrowserSnapshotAtom)).toEqual(afterClose)
    await act(async () => root.unmount())
  })

  it('conservatively latches tabs in the first push after initial hydration fails', async () => {
    let rejectInitial!: (error: Error) => void
    let onChanged: ((snapshot: EmbeddedBrowserSnapshot) => void) | null = null
    const initialPromise = new Promise<EmbeddedBrowserSnapshot>((_resolve, reject) => {
      rejectInitial = reject
    })
    const browser = { snapshot: () => initialPromise } as ElectronAPI['browser']
    const events = {
      onEmbeddedBrowserChanged: (callback: (snapshot: EmbeddedBrowserSnapshot) => void) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    } as ElectronAPI['events']
    ;(window as typeof window & { api: ElectronAPI }).api = { browser, events } as ElectronAPI

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    await act(async () => root.render(<Provider store={store}><Harness /></Provider>))
    await act(async () => {
      rejectInitial(new Error('snapshot unavailable'))
      await initialPromise.catch(() => undefined)
    })
    await act(async () => onChanged?.({
      sessions: [{
        sessionId: 'session-after-failure',
        activeTabId: 'tab-first-push',
        tabs: [browserTab('tab-first-push')],
        workbenches: [],
      }],
    }))

    expect(store.get(browserNeedsAttentionFamily('session-after-failure'))).toBe(true)
    await act(async () => root.unmount())
  })
})
