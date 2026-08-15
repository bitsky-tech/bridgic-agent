/** Native host foreground query/push synchronization for Browser attention. */
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ElectronAPI } from '@shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useHostWindowForeground } = await import('../useHostWindowForeground')

afterEach(() => document.body.replaceChildren())
afterAll(async () => GlobalRegistrator.unregister())

function installApi(
  read: () => Promise<boolean>,
  subscribe: (callback: (foreground: boolean) => void) => () => void,
): void {
  ;(window as typeof window & { api: ElectronAPI }).api = {
    window: { isForeground: read },
    events: { onWindowForegroundChanged: subscribe },
  } as ElectronAPI
}

describe('useHostWindowForeground', () => {
  it('starts conservatively hidden, then follows the native snapshot and pushes', async () => {
    let onChanged: ((foreground: boolean) => void) | null = null
    installApi(
      async () => true,
      (callback) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    )
    const states: boolean[] = []
    function Harness() {
      states.push(useHostWindowForeground())
      return null
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<Harness />))
    expect(states[0]).toBe(false)
    expect(states.at(-1)).toBe(true)

    await act(async () => onChanged?.(false))
    expect(states.at(-1)).toBe(false)

    await act(async () => root.unmount())
    expect(onChanged).toBeNull()
  })

  it('does not let a stale initial query overwrite a newer native push', async () => {
    let resolveInitial!: (foreground: boolean) => void
    let onChanged: ((foreground: boolean) => void) | null = null
    const initial = new Promise<boolean>((resolve) => { resolveInitial = resolve })
    installApi(
      () => initial,
      (callback) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    )
    let current = false
    function Harness() {
      current = useHostWindowForeground()
      return null
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<Harness />))
    await act(async () => {
      onChanged?.(true)
      resolveInitial(false)
      await initial
    })

    expect(current).toBe(true)
    await act(async () => root.unmount())
  })
})
