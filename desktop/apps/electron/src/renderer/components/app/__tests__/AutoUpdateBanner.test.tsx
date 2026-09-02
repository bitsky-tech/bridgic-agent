/**
 * AutoUpdateBanner maps update events to UI state and allows installation only after user action.
 *
 * Test pure `nextView` separately. Component coverage focuses on review-prone behavior:
 *  - only Downloaded interrupts users; background progress and failures remain silent;
 *  - mounting does **not** call `update.installNow`, because automatic installation can force-kill the daemon on exit;
 *  - a click calls it exactly once;
 *  - clicking while an agent runs requests confirmation before installing;
 *  - a refusal, such as failure to stop the daemon, remains visible instead of implying success.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { atom, getDefaultStore } = await import('jotai')
// The activity probe is a Jotai write atom talking to the daemon; there is no
// daemon here, so swap the module before the component imports it. `mock.module`
// must run before that import for the substitution to take.
let isAgentRunning = false
mock.module('@/atoms/update', () => {
  const reopen = atom(0)
  const handingOver = atom(false)
  return {
    updateCardReopenAtom: atom((get: (a: unknown) => number) => get(reopen)),
    requestUpdateCardAtom: atom(null, () => {}),
    isHandingOverUpdateAtom: atom((get: (a: unknown) => boolean) => get(handingOver)),
    beginUpdateHandoverAtom: atom(null, () => {}),
    endUpdateHandoverAtom: atom(null, () => {}),
    fetchAgentActivityAtom: atom(null, async () => isAgentRunning),
  }
})

const { browserSurfaceBlockedAtom, setNativeSurfaceRectAtom } = await import('@/atoms/browser')
const { AutoUpdateBanner, nextView } = await import('../AutoUpdateBanner')

/** Drive the mocked probe: mirrors what `GET /api/agent/status` would answer. */
function setAgentRunning(running: boolean): void {
  isAgentRunning = running
}

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

type UpdateListener = (event: unknown) => void

/** Mirrors `UpdateInstallResult`; declared locally so the mock is not narrowed
 *  to its first implementation's `{ ok: true }`. */
type InstallResult = { ok: true } | { ok: false; reason: string; detail?: string }

let listener: UpdateListener | null = null
const installNow = mock<() => Promise<InstallResult>>(async () => ({ ok: true }))

beforeEach(() => {
  listener = null
  installNow.mockClear()
  installNow.mockImplementation(async () => ({ ok: true }))
  // Idle by default so a click takes the direct-install path; the busy cases
  // opt in explicitly. The module-level flag persists across tests otherwise.
  setAgentRunning(false)
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
  workbench: {
    ensure: async () => undefined,
    activate: async () => undefined,
    close: async () => undefined,
  },
    events: {
      onAutoUpdate: (cb: UpdateListener) => {
        listener = cb
        return () => {
          listener = null
        }
      },
    },
    update: { installNow },
  }
})

async function mountBanner() {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(<AutoUpdateBanner />)
  })
  return {
    host,
    emit: async (event: unknown) => {
      await act(async () => listener?.(event))
    },
    cleanup: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

describe('nextView', () => {
  it('stays silent for background states', () => {
    expect(nextView(null, { type: 'checking' })).toBeNull()
    expect(nextView(null, { type: 'not-available' })).toBeNull()
    // `available` fires before any byte moves — there is nothing to decide yet.
    expect(nextView(null, { type: 'available', info: { version: '1.0.0' } })).toBeNull()
  })

  it('stays silent while downloading', () => {
    // The user did not request the download, so progress is noise; show the card only when a decision is needed.
    expect(nextView(null, { type: 'progress', percent: 42.7, bytesPerSecond: 1 })).toBeNull()
  })

  it('stays silent on a background failure', () => {
    // Users cannot act on background check or download failures, so surfacing them only creates unactionable noise.
    expect(nextView(null, { type: 'error', message: 'boom' })).toBeNull()
  })

  it('keeps the ready card when a later background event arrives', () => {
    const ready = nextView(null, { type: 'downloaded', info: { version: '2.1.0' } })
    expect(nextView(ready, { type: 'error', message: 'boom' })).toEqual(ready)
    expect(nextView(ready, { type: 'checking' })).toEqual(ready)
  })

  it('surfaces the downloaded version', () => {
    expect(nextView(null, { type: 'downloaded', info: { version: '2.1.0' } })).toEqual({
      kind: 'ready',
      version: '2.1.0',
    })
  })
})

describe('AutoUpdateBanner', () => {
  it('renders nothing until an update is actually downloaded', async () => {
    const { host, emit, cleanup } = await mountBanner()

    expect(host.textContent).toBe('')
    await emit({ type: 'checking' })
    expect(host.textContent).toBe('')
    expect(installNow).not.toHaveBeenCalled()

    await cleanup()
  })

  it('never installs on its own', async () => {
    const { host, emit, cleanup } = await mountBanner()

    await emit({ type: 'downloaded', info: { version: '2.1.0' } })

    expect(host.querySelector('[data-testid="auto-update-install"]')).not.toBeNull()
    // Installation stops the daemon before exiting, so automatic triggering would make the decision for the user.
    expect(installNow).not.toHaveBeenCalled()

    await cleanup()
  })

  it('installs once on click', async () => {
    const { host, emit, cleanup } = await mountBanner()
    await emit({ type: 'downloaded', info: { version: '2.1.0' } })

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="auto-update-install"]')?.click()
    })

    expect(installNow).toHaveBeenCalledTimes(1)
    await cleanup()
  })

  it('asks before interrupting a running agent', async () => {
    setAgentRunning(true)
    const { host, emit, cleanup } = await mountBanner()
    await emit({ type: 'downloaded', info: { version: '2.1.0' } })

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="auto-update-install"]')?.click()
    })

    // Restart to Update must not install immediately. Daemon shutdown has only an eight-second grace
    // period before force kill, which would interrupt running work.
    expect(installNow).not.toHaveBeenCalled()
    expect(host.querySelector('[data-testid="auto-update-when-idle"]')).not.toBeNull()

    await cleanup()
  })

  it('installs anyway when the user insists past the warning', async () => {
    setAgentRunning(true)
    const { host, emit, cleanup } = await mountBanner()
    await emit({ type: 'downloaded', info: { version: '2.1.0' } })

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="auto-update-install"]')?.click()
    })
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="auto-update-restart-anyway"]')?.click()
    })

    expect(installNow).toHaveBeenCalledTimes(1)
    await cleanup()
  })

  it('parks the update instead of installing when the user picks idle', async () => {
    setAgentRunning(true)
    const { host, emit, cleanup } = await mountBanner()
    await emit({ type: 'downloaded', info: { version: '2.1.0' } })

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="auto-update-install"]')?.click()
    })
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="auto-update-when-idle"]')?.click()
    })

    // Pending state: the card still explains what will happen, but installation has not started.
    expect(installNow).not.toHaveBeenCalled()
    expect(host.textContent).not.toBe('')

    await cleanup()
  })

  it('keeps explaining when the install is refused', async () => {
    installNow.mockImplementation(async () => ({ ok: false, reason: 'daemon-busy' }))
    const { host, emit, cleanup } = await mountBanner()
    await emit({ type: 'downloaded', info: { version: '2.1.0' } })

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="auto-update-install"]')?.click()
    })

    // A refusal cannot disappear silently because users would read that as successful installation.
    expect(host.textContent).not.toBe('')
    expect(host.querySelector('[data-testid="auto-update-install"]')).toBeNull()

    await cleanup()
  })

  it('stays retryable after a refusal', async () => {
    // Refusal is recoverable by stopping the gateway in Settings. The old implementation reset
    // installing only in catch, making the button a permanent no-op after one refusal with no visual clue.
    installNow.mockImplementation(async () => ({ ok: false, reason: 'daemon-busy' }))
    const { host, emit, cleanup } = await mountBanner()
    await emit({ type: 'downloaded', info: { version: '2.1.0' } })
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="auto-update-install"]')?.click()
    })
    expect(installNow).toHaveBeenCalledTimes(1)

    await emit({ type: 'downloaded', info: { version: '2.1.0' } })
    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="auto-update-install"]')?.click()
    })

    expect(installNow).toHaveBeenCalledTimes(2)
    await cleanup()
  })

  it('ignores a double click', async () => {
    const { host, emit, cleanup } = await mountBanner()
    await emit({ type: 'downloaded', info: { version: '2.1.0' } })

    await act(async () => {
      const button = host.querySelector<HTMLElement>('[data-testid="auto-update-install"]')
      // Two same-batch clicks read the same stale state; only a ref guard can block the duplicate.
      button?.click()
      button?.click()
    })

    expect(installNow).toHaveBeenCalledTimes(1)
    await cleanup()
  })

  it('steps left of the embedded Browser instead of sitting under it', async () => {
    // The card is anchored bottom-right — exactly where the Browser's
    // WebContentsView sits. That view composites above this page, so `z-50` buys
    // nothing: staying put means the card is invisible except for the sliver
    // beside the dock rail. It moves rather than hiding the view, because it is
    // non-modal and can sit in the corner for as long as the user ignores it.
    const store = getDefaultStore()
    const { host, emit, cleanup } = await mountBanner()
    const cardRight = () => (
      host.querySelector<HTMLElement>('[data-testid="auto-update-banner"]')?.style.right
    )

    await emit({ type: 'downloaded', info: { version: '2.1.0' } })
    expect(cardRight()).toBe('16px')

    // The browser opens while the card is already up — the common case, and the
    // one a position measured once at mount would get wrong.
    await act(async () => {
      store.set(setNativeSurfaceRectAtom, {
        x: window.innerWidth - 500,
        y: 100,
        width: 420,
        height: 400,
      })
    })
    expect(cardRight()).toBe('516px')

    // Browser closes → the card reclaims the corner.
    await act(async () => { store.set(setNativeSurfaceRectAtom, null) })
    expect(cardRight()).toBe('16px')

    await cleanup()
  })

  it('does not hide the browser when there is room to step aside', async () => {
    // Blanking a whole web page to make room for a corner card reads as a bug.
    // Blocking the surface is the fallback, not the default.
    const store = getDefaultStore()
    const { emit, cleanup } = await mountBanner()

    await emit({ type: 'downloaded', info: { version: '2.1.0' } })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)

    await act(async () => {
      store.set(setNativeSurfaceRectAtom, {
        x: window.innerWidth - 500, y: 100, width: 420, height: 400,
      })
    })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)

    await act(async () => { store.set(setNativeSurfaceRectAtom, null) })
    await cleanup()
  })

  it('falls back to hiding the browser when nothing is left to step into', async () => {
    // Expanded Browser: the surface starts at the sidebar's edge, so the free
    // column is far narrower than the card. Stepping aside there would push the
    // card off-screen or straight back under the view.
    const store = getDefaultStore()
    const { host, emit, cleanup } = await mountBanner()
    await act(async () => {
      store.set(setNativeSurfaceRectAtom, { x: 200, y: 40, width: 900, height: 700 })
    })

    await emit({ type: 'downloaded', info: { version: '2.1.0' } })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(true)
    // Blocked, so it stays in its natural corner rather than dodging a view
    // that is no longer there.
    expect(
      host.querySelector<HTMLElement>('[data-testid="auto-update-banner"]')?.style.right,
    ).toBe('16px')

    // Closing the card must release the surface — the browser is unusable until it does.
    await cleanup()
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)
    await act(async () => { store.set(setNativeSurfaceRectAtom, null) })
  })
})
