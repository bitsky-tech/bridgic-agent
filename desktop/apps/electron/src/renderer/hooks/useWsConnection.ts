/**
 * Install the single persistent chat WebSocket and feed its events into the
 * reducer. Mounted once from App.tsx.
 *
 * The connection is a module singleton (lib/amphi-ws-connection.ts); this hook
 * only (re)configures it when the daemon endpoint changes and injects a
 * `dispatch` bound to THIS Provider's store via `useSetAtom` (antipattern §E:
 * the singleton is module-scope and must NOT `getDefaultStore()`). Cleanup does
 * NOT close the socket — its lifecycle follows the module, not the component,
 * so StrictMode's double-mount and HMR don't churn the connection.
 * Session topic subscriptions likewise outlive navigation so hidden in-flight
 * replies keep streaming; only explicit Session deletion unsubscribes a topic.
 *
 * Dynamic import keeps WebSocket out of the static graph (bun:test friendly),
 * mirroring the old daemon-chat dynamic edge.
 */
import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { backendEndpointAtom, backendEndpointEpochAtom } from '@/atoms/backend'
import { applyAgentEventAtom } from '@/atoms/agent'
import { hydrateSessionsFromDaemonAtom } from '@/atoms/sessions'
import { activeSessionIdAtom, draftSessionIdsAtom } from '@/atoms/sessions'
import { rlog } from '@/lib/logger'

export function useWsConnection(): void {
  const endpoint = useAtomValue(backendEndpointAtom)
  const endpointEpoch = useAtomValue(backendEndpointEpochAtom)
  const applyAgentEvent = useSetAtom(applyAgentEventAtom)
  const hydrateSessions = useSetAtom(hydrateSessionsFromDaemonAtom)
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const draftSessionIds = useAtomValue(draftSessionIdsAtom)
  useEffect(() => {
    // Discard a stale resolution: if `endpoint` / `applyAgentEvent` change
    // before this dynamic import resolves, a late `.then` would otherwise
    // reconfigure the singleton with the OLD endpoint (last-writer-wins race).
    let cancelled = false
    void import('@/lib/amphiWsConnection').then((m) => {
      if (cancelled) return
      const connection = m.getAmphiWsConnection()
      if (!endpoint) {
        connection.clearEndpoint()
        return
      }
      connection.configure(
        endpoint,
        (sessionId, event) => applyAgentEvent({ sessionId, event }),
        () => {
          void hydrateSessions().catch(() => {})
        },
        () => {
          // Main owns discovery/token adoption. A 4401 only asks it to refresh
          // the current daemon snapshot; this path must never spawn/restart it.
          void window.api.backend.refresh(endpointEpoch).catch((err: unknown) => {
            rlog.warn('[ws-conn] backend refresh after 4401 failed', err)
          })
        },
      )
    })
    return () => {
      cancelled = true
    }
  }, [endpoint, endpointEpoch, applyAgentEvent, hydrateSessions])

  useEffect(() => {
    if (!endpoint || !activeSessionId || draftSessionIds.has(activeSessionId)) return
    let cancelled = false
    void importAmphiConnection().then((value) => {
      if (cancelled) return
      value.subscribe(activeSessionId)
    })
    return () => {
      cancelled = true
      // Navigation is not Session deletion. Retain the subscription so an
      // in-flight hidden Session keeps receiving the events needed to rebuild
      // its one logical reply when the user returns.
    }
  }, [activeSessionId, draftSessionIds, endpoint])
}

async function importAmphiConnection() {
  const module = await import('@/lib/amphiWsConnection')
  return module.getAmphiWsConnection()
}
