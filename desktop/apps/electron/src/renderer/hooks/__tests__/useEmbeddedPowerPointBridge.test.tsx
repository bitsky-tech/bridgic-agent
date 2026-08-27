import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ElectronAPI, EmbeddedPowerPointSnapshot } from '@shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { embeddedPowerPointSnapshotAtom } = await import('@/atoms/powerpoint')
const { useEmbeddedPowerPointBridge } = await import('../useEmbeddedPowerPointBridge')

afterEach(() => {
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function Bridge() {
  useEmbeddedPowerPointBridge()
  return null
}

function snapshot(sessionId: string): EmbeddedPowerPointSnapshot {
  return {
    sessions: [{
      sessionId,
      targetId: `target-${sessionId}`,
      webContentsId: 9,
      loading: false,
      crashed: false,
    }],
  }
}

describe('useEmbeddedPowerPointBridge', () => {
  it('keeps a pushed lifecycle update that arrives before the initial snapshot', async () => {
    let push: ((snapshot: EmbeddedPowerPointSnapshot) => void) | null = null
    let resolveInitial: ((snapshot: EmbeddedPowerPointSnapshot) => void) | null = null
    let unsubscribed = false
    ;(window as typeof window & { api: ElectronAPI }).api = {
      powerpoint: {
        snapshot: () => new Promise((resolve) => { resolveInitial = resolve }),
      },
      events: {
        onEmbeddedPowerPointChanged: (callback) => {
          push = callback
          return () => { unsubscribed = true }
        },
      },
    } as ElectronAPI
    const store = createStore()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(<Provider store={store}><Bridge /></Provider>)
    })
    await act(async () => {
      push?.(snapshot('session-pushed'))
      resolveInitial?.({ sessions: [] })
      await Promise.resolve()
    })

    expect(store.get(embeddedPowerPointSnapshotAtom)).toEqual(snapshot('session-pushed'))

    await act(async () => root.unmount())
    expect(unsubscribed).toBe(true)
  })
})
