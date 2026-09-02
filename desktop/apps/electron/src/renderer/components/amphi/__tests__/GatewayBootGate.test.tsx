/**
 * Version-gate branches in GatewayBootGate.
 *
 * These constraints prevent silent failures that keep users running in a half-upgraded state:
 *  - `incompatible` must **block** children so a new GUI cannot drive an old daemon;
 *  - `resolveCompatibility` must **never** run before the user clicks, because a restart
 *    interrupts work from other clients;
 *  - `unknown`, where the daemon reports no version, needs distinct copy from a mismatch;
 *  - a null `compatibility`, used by development builds without a manifest, disables the gate.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createStore, Provider } from 'jotai'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { issueReportRequestAtom } = await import('@/atoms/issue-report')
const { BackendState, CompatibilityState } = await import('../../../../main/python-client/types')
const { GatewayBootGate } = await import('../GatewayBootGate')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const resolveCompatibility = mock(async () => ({
  state: BackendState.Ready,
  endpoint: null,
  lastError: null,
  compatibility: { state: CompatibilityState.Compatible },
}))
type ClientRow = { client_id: string; client_type: string }
const getClients = mock<() => Promise<{ ok: true; clients: ClientRow[] } | { ok: false; reason: string }>>(
  async () => ({ ok: true, clients: [] }),
)
const quit = mock(async () => {})

beforeEach(() => {
  resolveCompatibility.mockClear()
  getClients.mockClear()
  getClients.mockImplementation(async () => ({ ok: true, clients: [] }))
  quit.mockClear()
  // Only the three members this component touches; the gate never reaches for
  // anything else, and a fuller fake would just hide that.
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
  workbench: {
    ensure: async () => undefined,
    activate: async () => undefined,
    close: async () => undefined,
  },
    backend: { getClients, resolveCompatibility },
    app: { quit },
  }
})

function snapshot(
  state: (typeof BackendState)[keyof typeof BackendState],
  compatibility: unknown,
  lastError: string | null = null,
) {
  return { state, endpoint: null, lastError, compatibility }
}

async function renderGate(state: string, compatibility: unknown, lastError: string | null = null) {
  const store = createStore()
  store.set(backendSnapshotAtom, snapshot(state as never, compatibility, lastError) as never)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Provider store={store}>
        <GatewayBootGate>
          <div data-testid="app-body">agent ui</div>
        </GatewayBootGate>
      </Provider>,
    )
  })
  return {
    host,
    store,
    cleanup: async () => {
      await act(async () => root.unmount())
      host.remove()
    },
  }
}

describe('GatewayBootGate — version mismatch', () => {
  it('blocks the app body and never auto-restarts', async () => {
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    expect(host.querySelector('[data-testid="app-body"]')).toBeNull()
    expect(host.querySelector('[data-testid="boot-gate-resolve-compatibility"]')).not.toBeNull()
    // Core contract: rendering the blocking screen must **not** restart the daemon as a side effect.
    expect(resolveCompatibility).not.toHaveBeenCalled()

    await cleanup()
  })

  it('shows both versions so the user can see what is stale', async () => {
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    const text = host.textContent ?? ''
    expect(text).toContain('0.2.0')
    expect(text).toContain('0.1.0')

    await cleanup()
  })

  it('restarts only when the user clicks', async () => {
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    await act(async () => {
      host
        .querySelector<HTMLElement>('[data-testid="boot-gate-resolve-compatibility"]')
        ?.click()
    })

    expect(resolveCompatibility).toHaveBeenCalledTimes(1)
    await cleanup()
  })

  it('opens a gateway report with the visible version mismatch details', async () => {
    const { host, store, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="boot-gate-report-issue"]')?.click()
    })

    const request = store.get(issueReportRequestAtom)
    expect(request?.source).toBe('gateway')
    expect(request?.error).toContain('0.2.0')
    expect(request?.error).toContain('0.1.0')
    expect(resolveCompatibility).not.toHaveBeenCalled()

    await cleanup()
  })

  it('uses distinct copy when the daemon reported no version at all', async () => {
    const mismatch = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })
    const mismatchText = mismatch.host.textContent ?? ''
    await mismatch.cleanup()

    const { host, store, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Unknown,
      expected: '0.2.0',
    })
    const text = host.textContent ?? ''

    // Compare two real renderings instead of asserting absence of a version not present in the
    // fixture. The latter is always true and cannot detect an accidentally rendered comparison table.
    expect(text).not.toBe(mismatchText)
    // Do not render the version table without an actual version; "Running: —" is only noise.
    expect(text).not.toContain('0.2.0')
    expect(host.querySelector('[data-testid="boot-gate-resolve-compatibility"]')).not.toBeNull()

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="boot-gate-report-issue"]')?.click()
    })
    const request = store.get(issueReportRequestAtom)
    expect(request?.source).toBe('gateway')
    expect(request?.error).not.toContain('0.2.0')

    await cleanup()
  })

  it('names the number of clients a restart would disconnect', async () => {
    // This locks down the main-process guard. fetchGatewayClients once ran only in Ready state,
    // forcing every warning into the vaguest copy and leaving pluralized messages unreachable.
    getClients.mockImplementation(async () => ({
      ok: true,
      clients: [
        { client_id: 'a', client_type: 'cli' },
        { client_id: 'b', client_type: 'gui' },
      ],
    }))
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.Incompatible,
      expected: '0.2.0',
      actual: '0.1.0',
    })

    expect(getClients).toHaveBeenCalledTimes(1)
    expect(host.textContent ?? '').toContain('2')

    await cleanup()
  })

  it('offers no gateway restart when it is OUR install that is broken', async () => {
    // An unreadable manifest means the app itself is damaged. Restarting the gateway cannot fix it,
    // so offering that button would send users into a guaranteed failure.
    const { host, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.ManifestUnavailable,
      detail: 'file not found',
    })

    expect(host.querySelector('[data-testid="boot-gate-resolve-compatibility"]')).toBeNull()
    expect(host.querySelector('[data-testid="app-body"]')).toBeNull()
    expect(host.textContent ?? '').not.toBe('')

    await cleanup()
  })

  it('reports a broken install without exposing its manifest detail', async () => {
    const privateDetail = 'file not found at /Users/private-account/release-manifest.json'
    const { host, store, cleanup } = await renderGate(BackendState.Incompatible, {
      state: CompatibilityState.ManifestUnavailable,
      detail: privateDetail,
    })

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="boot-gate-report-issue"]')?.click()
    })

    const request = store.get(issueReportRequestAtom)
    expect(request?.source).toBe('gateway')
    expect(request?.error).not.toContain(privateDetail)
    expect(request?.error).not.toContain('/Users/private-account')

    await cleanup()
  })

  it('uses the already-visible backend error for an unavailable gateway report', async () => {
    const visibleError = 'Gateway start failed with HTTP 401'
    const { host, store, cleanup } = await renderGate(
      BackendState.Unavailable,
      null,
      visibleError,
    )

    await act(async () => {
      host.querySelector<HTMLElement>('[data-testid="boot-gate-report-issue"]')?.click()
    })

    expect(store.get(issueReportRequestAtom)).toMatchObject({
      source: 'gateway',
      error: visibleError,
    })

    await cleanup()
  })

  it('lets a ready daemon through untouched', async () => {
    const { host, cleanup } = await renderGate(BackendState.Ready, {
      state: CompatibilityState.Compatible,
    })

    expect(host.querySelector('[data-testid="app-body"]')).not.toBeNull()
    expect(getClients).not.toHaveBeenCalled()

    await cleanup()
  })

  it('blocks business UI while an endpoint is being re-authenticated', async () => {
    const { host, cleanup } = await renderGate(BackendState.Unhealthy, null)

    expect(host.querySelector('[data-testid="app-body"]')).toBeNull()
    expect(host.querySelector('[data-testid="gateway-boot-gate"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="boot-gate-report-issue"]')).toBeNull()

    await cleanup()
  })

  it('does not gate a development build with no manifest verdict', async () => {
    // compatibility === null means not evaluated, not incompatible. Development builds have no
    // generated manifest, so the gate must be disabled or `bun run dev` becomes unusable.
    const { host, cleanup } = await renderGate(BackendState.Ready, null)

    expect(host.querySelector('[data-testid="app-body"]')).not.toBeNull()

    await cleanup()
  })
})
