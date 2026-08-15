/**
 * Connected-clients hooks — split out of atoms/backend.ts (which keeps the
 * atoms + the canonical `refreshConnectedClientsAtom` write-atom).
 *
 *  - useGatewayClientsRefresh(intervalMs): one fetch on mount + optional
 *    periodic refresh tied to component lifetime; returns a manual refresh.
 *  - useConnectedClients(): read-only view for components that only display.
 */
import { useCallback, useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import type { ClientInfoResponse } from '@shared/types'
import {
  connectedClientsAtom,
  connectedClientsCountAtom,
  connectedClientsErrorAtom,
  connectedClientsLoadingAtom,
  refreshConnectedClientsAtom,
} from '@/atoms/backend'

export function useGatewayClientsRefresh(intervalMs = 0): {
  refresh: () => void
} {
  const trigger = useSetAtom(refreshConnectedClientsAtom)
  const refresh = useCallback(() => {
    void trigger()
  }, [trigger])

  useEffect(() => {
    refresh()
    if (intervalMs <= 0) return
    const timer = setInterval(refresh, intervalMs)
    return () => clearInterval(timer)
  }, [refresh, intervalMs])

  return { refresh }
}

export function useConnectedClients(): {
  clients: ClientInfoResponse[] | null
  count: number
  error: string | null
  loading: boolean
} {
  return {
    clients: useAtomValue(connectedClientsAtom),
    count: useAtomValue(connectedClientsCountAtom),
    error: useAtomValue(connectedClientsErrorAtom),
    loading: useAtomValue(connectedClientsLoadingAtom),
  }
}
