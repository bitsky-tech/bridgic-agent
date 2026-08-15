/**
 * Regression coverage for native full-screen state reaching the CSS selector
 * that releases macOS's traffic-light inset.
 */
import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ElectronAPI } from '@shared/types'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { useWindowFullScreenMarker } = await import('../useWindowFullScreenMarker')

afterEach(() => {
  delete document.documentElement.dataset.windowFullScreen
  document.body.replaceChildren()
})

afterAll(async () => GlobalRegistrator.unregister())

function Harness() {
  useWindowFullScreenMarker()
  return null
}

function installApi(
  read: () => Promise<boolean>,
  subscribe: (callback: (fullScreen: boolean) => void) => () => void,
): void {
  ;(window as typeof window & { api: ElectronAPI }).api = {
    window: { isFullScreen: read },
    events: { onWindowFullScreenChanged: subscribe },
  } as ElectronAPI
}

describe('useWindowFullScreenMarker', () => {
  it('mirrors the initial state and subsequent native changes to the root element', async () => {
    let onChanged: ((fullScreen: boolean) => void) | null = null
    installApi(
      async () => true,
      (callback) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    )

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<Harness />))

    expect(document.documentElement.dataset.windowFullScreen).toBe('true')
    await act(async () => onChanged?.(false))
    expect(document.documentElement.dataset.windowFullScreen).toBe('false')

    await act(async () => root.unmount())
    expect(document.documentElement.dataset.windowFullScreen).toBeUndefined()
  })

  it('does not let a stale initial query overwrite a newer pushed event', async () => {
    let resolveInitial!: (fullScreen: boolean) => void
    let onChanged: ((fullScreen: boolean) => void) | null = null
    const initial = new Promise<boolean>((resolve) => { resolveInitial = resolve })
    installApi(
      () => initial,
      (callback) => {
        onChanged = callback
        return () => { onChanged = null }
      },
    )

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<Harness />))

    await act(async () => {
      onChanged?.(true)
      resolveInitial(false)
      await initial
    })

    expect(document.documentElement.dataset.windowFullScreen).toBe('true')
    await act(async () => root.unmount())
  })

  it('does not restore the marker when an initial query resolves after unmount', async () => {
    let resolveInitial!: (fullScreen: boolean) => void
    const initial = new Promise<boolean>((resolve) => { resolveInitial = resolve })
    installApi(() => initial, () => () => {})

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => root.render(<Harness />))
    await act(async () => root.unmount())

    resolveInitial(true)
    await initial
    await Promise.resolve()

    expect(document.documentElement.dataset.windowFullScreen).toBeUndefined()
  })

  it('releases the Darwin traffic-light inset when the native window is full screen', () => {
    const css = readFileSync(join(import.meta.dir, '../../index.css'), 'utf-8')
    expect(css).toMatch(
      /html\[data-platform="darwin"\]\[data-window-full-screen="true"\]\s*\{[^}]*--titlebar-mac-inset:\s*0px;/,
    )
  })

})
