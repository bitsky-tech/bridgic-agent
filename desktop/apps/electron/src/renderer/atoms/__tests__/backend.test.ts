/**
 * Tests for atoms/backend.ts — focused on the M1 connected-clients
 * additions. The pre-existing snapshot/state/endpoint atoms are
 * exercised indirectly by existing app code; no new tests for them.
 *
 * Strategy: stub `window.api.backend.getClients` with mock fns, drive
 * `refreshConnectedClientsAtom` via a jotai store, assert atom state
 * after each transition.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'

type GetClientsResult =
  | { ok: true; clients: unknown[] }
  | { ok: false; reason: string }

// Default stub — individual tests override `getClients` as needed.
function installApiStub(getClients: () => Promise<GetClientsResult>): void {
  ;(globalThis as { window?: unknown }).window = {
    api: {
      backend: {
        snapshot: mock(async () => ({ state: 'idle', endpoint: null, lastError: null })),
        start: mock(async () => {}),
        stop: mock(async () => {}),
        restart: mock(async () => {}),
        openLogs: mock(async () => ({ ok: false, reason: 'n/a' })),
        getClients: mock(getClients),
      },
      events: {
        onBackendState: mock(() => () => {}),
      },
    },
  } as never
}

beforeEach(() => {
  installApiStub(async () => ({ ok: true, clients: [] }))
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

// Import after stub install so any module-load side effects see `window`.
// (atoms/backend.ts doesn't have such side effects today, but defensive.)
import {
  connectedClientsAtom,
  connectedClientsCountAtom,
  connectedClientsErrorAtom,
  connectedClientsLoadingAtom,
  refreshConnectedClientsAtom,
} from '../backend'

describe('refreshConnectedClientsAtom — happy path', () => {
  it('populates clients + clears error + toggles loading', async () => {
    const fakeClients = [
      { client_id: 'gui-1', client_type: 'gui', connected_at: 1, last_seen: 2, user_agent: 'amphi/0.1.0' },
      { client_id: 'cli-1', client_type: 'cli', connected_at: 3, last_seen: 4, user_agent: null },
    ]
    installApiStub(async () => ({ ok: true, clients: fakeClients }))
    const store = createStore()

    expect(store.get(connectedClientsAtom)).toBeNull()
    expect(store.get(connectedClientsLoadingAtom)).toBe(false)

    await store.set(refreshConnectedClientsAtom)

    expect(store.get(connectedClientsAtom)).toEqual(fakeClients)
    expect(store.get(connectedClientsErrorAtom)).toBeNull()
    expect(store.get(connectedClientsLoadingAtom)).toBe(false)
    expect(store.get(connectedClientsCountAtom)).toBe(2)
  })

  it('count atom returns 0 when never fetched', () => {
    const store = createStore()
    expect(store.get(connectedClientsCountAtom)).toBe(0)
  })
})

describe('refreshConnectedClientsAtom — error path', () => {
  it('captures reason but keeps previous clients (transient errors)', async () => {
    installApiStub(async () => ({ ok: false, reason: 'daemon not ready' }))
    const store = createStore()

    // Seed previous successful fetch via direct atom set (test scaffolding only).
    store.set(connectedClientsAtom, [
      { client_id: 'old', client_type: 'gui', connected_at: 0, last_seen: 0, user_agent: null },
    ])

    await store.set(refreshConnectedClientsAtom)

    expect(store.get(connectedClientsErrorAtom)).toBe('daemon not ready')
    // Old list preserved — better UX than blanking on transient errors.
    expect(store.get(connectedClientsAtom)).toHaveLength(1)
    expect(store.get(connectedClientsLoadingAtom)).toBe(false)
  })

  it('clears error on next successful refresh', async () => {
    installApiStub(async () => ({ ok: false, reason: 'first failure' }))
    const store = createStore()
    await store.set(refreshConnectedClientsAtom)
    expect(store.get(connectedClientsErrorAtom)).toBe('first failure')

    installApiStub(async () => ({ ok: true, clients: [] }))
    await store.set(refreshConnectedClientsAtom)

    expect(store.get(connectedClientsErrorAtom)).toBeNull()
  })
})

describe('refreshConnectedClientsAtom — concurrency', () => {
  it('is idempotent: second trigger while in-flight no-ops gracefully', async () => {
    // Hand-rolled deferred to control resolution timing.
    let resolveFetch!: (r: GetClientsResult) => void
    const pending = new Promise<GetClientsResult>((res) => {
      resolveFetch = res
    })
    let callCount = 0
    installApiStub(() => {
      callCount += 1
      return pending
    })
    const store = createStore()

    const first = store.set(refreshConnectedClientsAtom)
    // Second call while first is in flight — must NOT issue a second IPC.
    const second = store.set(refreshConnectedClientsAtom)

    expect(store.get(connectedClientsLoadingAtom)).toBe(true)
    expect(callCount).toBe(1) // first call issued; second skipped

    resolveFetch({ ok: true, clients: [] })
    await Promise.all([first, second])

    expect(store.get(connectedClientsLoadingAtom)).toBe(false)
    expect(callCount).toBe(1) // confirmed: still only one IPC call
  })
})
