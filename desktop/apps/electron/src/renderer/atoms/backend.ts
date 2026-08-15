/**
 * Backend state atoms — subscribed by every component that needs to know
 * whether the Bridgic Agent daemon is up.
 *
 * Wiring:
 *   - `backendSnapshotAtom` is seeded from the IPC `snapshot()` call at
 *     App mount (a one-shot pull) and then kept in sync by the
 *     `onBackendState` push subscription.
 *   - `backendEndpointAtom` is a derived read of `snapshot.endpoint` —
 *     business pages (Phase 4) read this to construct fetch URLs.
 *   - `backendStateAtom` is a derived read of `snapshot.state` — UI
 *     banners / loading indicators read this.
 *   - `useBackendBridge()` installs the subscription effect; mounted
 *     once from `App.tsx`.
 *   - `connectedClientsAtom` (M1+) holds the last `/api/gateway/clients`
 *     response. The Settings → Gateway panel and the sidebar mini-widget
 *     both read it; only the Settings panel triggers refreshes via
 *     `useGatewayClientsRefresh()`.
 *
 * Default snapshot is `idle` so any component reading the atom before
 * the bridge mounts still gets a valid shape (no `undefined` checks).
 */
import { atom, type Getter } from 'jotai'
import type { BackendSnapshot, ClientInfoResponse } from '@shared/types'
import { BackendState } from '../../main/python-client/types'
import { AmphiClient } from '../lib/amphiClient'
import { rlog } from '../lib/logger'

const DEFAULT_SNAPSHOT: BackendSnapshot = {
  state: BackendState.Idle,
  endpoint: null,
  endpointEpoch: 0,
  lastError: null,
  compatibility: null,
}

export const backendSnapshotAtom = atom<BackendSnapshot>(DEFAULT_SNAPSHOT)

export const backendStateAtom = atom((get) => get(backendSnapshotAtom).state)
export const backendEndpointAtom = atom((get) => get(backendSnapshotAtom).endpoint)
export const backendEndpointEpochAtom = atom((get) => get(backendSnapshotAtom).endpointEpoch ?? 0)
export const backendErrorAtom = atom((get) => get(backendSnapshotAtom).lastError)

/**
 * GUI/daemon version verdict for the currently adopted endpoint.
 *
 * `null` means "not evaluated" — a development build with no generated release
 * manifest. Consumers must treat that as "no opinion", never as a mismatch.
 */
export const backendCompatibilityAtom = atom((get) => get(backendSnapshotAtom).compatibility)

const AUTH_REFRESH_THROTTLE_MS = 5_000
let lastAuthRefreshEpoch: number | null = null
let lastAuthRefreshAt = 0

function requestAuthRefresh(endpointEpoch: number): void {
  const now = Date.now()
  if (
    lastAuthRefreshEpoch === endpointEpoch &&
    now - lastAuthRefreshAt < AUTH_REFRESH_THROTTLE_MS
  ) {
    return
  }
  lastAuthRefreshEpoch = endpointEpoch
  lastAuthRefreshAt = now
  void window.api.backend.refresh(endpointEpoch).catch((err: unknown) => {
    rlog.warn('[backend] auth refresh failed', err)
  })
}

/** Build an AmphiClient from the current backend snapshot, or null when the
 *  daemon isn't reachable. Shared by every atom that talks to the daemon REST
 *  (models, sessions). Callers surface null as an error, not a silent retry. */
export function buildAmphiClient(get: Getter): AmphiClient | null {
  const snap = get(backendSnapshotAtom)
  const endpoint = snap.endpoint
  if (!endpoint) return null
  const endpointEpoch = snap.endpointEpoch ?? 0
  return new AmphiClient({
    baseUrl: endpoint.baseUrl,
    token: endpoint.token,
    clientId: endpoint.clientId ?? null,
    clientType: 'gui',
    onAuthFailure: () => requestAuthRefresh(endpointEpoch),
  })
}

// ─── Connected clients (M1+) ────────────────────────────────────────────────
//
// The daemon's in-memory client registry, surfaced via
// /api/gateway/clients. Populated by an
// IPC call to main (which does the HTTP fetch — see
// main/handlers/backend.ts :: fetchGatewayClients), so the Tray (Phase E)
// and the renderer share one fetch path with one set of headers.

/** Last successful fetch, or null when never fetched yet / last fetch failed. */
export const connectedClientsAtom = atom<ClientInfoResponse[] | null>(null)

/** Last refresh error (null on success). Cleared on next success. */
export const connectedClientsErrorAtom = atom<string | null>(null)

/** True while a refresh is in flight. UI 'loading' spinners read this. */
export const connectedClientsLoadingAtom = atom<boolean>(false)

/**
 * Derived count for the sidebar mini-widget hover tooltip. Returns 0
 * when never fetched (avoids showing 'undefined clients online' UX).
 */
export const connectedClientsCountAtom = atom((get) => {
  const list = get(connectedClientsAtom)
  return list?.length ?? 0
})

/**
 * Write-only atom that triggers a fresh fetch via the
 * `window.api.backend.getClients` IPC.
 *
 * Exposed as a write atom (not a raw setter on `connectedClientsAtom`)
 * per project Rule 13: components shouldn't be able to put arbitrary
 * lists into the registry mirror — only the canonical fetch path.
 *
 * Idempotent: concurrent triggers all wait on the same in-flight
 * promise via the loading guard, so spamming a refresh button doesn't
 * pile up requests.
 */
export const refreshConnectedClientsAtom = atom(null, async (get, set) => {
  if (get(connectedClientsLoadingAtom)) {
    // Already in flight; second caller waits for the first to settle
    // by no-op'ing (the atom state will update for everyone).
    return
  }
  set(connectedClientsLoadingAtom, true)
  try {
    const result = await window.api.backend.getClients()
    if (result.ok) {
      set(connectedClientsAtom, result.clients)
      set(connectedClientsErrorAtom, null)
    } else {
      set(connectedClientsErrorAtom, result.reason)
      // Intentionally do NOT clear connectedClientsAtom on failure —
      // showing the last known list is better UX than blanking the
      // panel on transient errors.
    }
  } catch (err: unknown) {
    // Defensive: window.api.backend.getClients never throws by design
    // (returns ok:false on errors). Catch is for unexpected runtime
    // issues (e.g. preload not loaded, IPC channel missing).
    const msg = err instanceof Error ? err.message : String(err)
    rlog.error('[backend] getClients IPC threw', err)
    set(connectedClientsErrorAtom, msg)
  } finally {
    set(connectedClientsLoadingAtom, false)
  }
})
