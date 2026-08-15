/**
 * Pull `/providers` + `/me/providers` + `/me` once the daemon reports Ready.
 * Re-fires on `unavailable → ready` transitions so a daemon restart auto-
 * resyncs the model picker. Gated on `state === Ready` because the AmphiClient
 * depends on `backendSnapshot.endpoint`, only set in that state (see
 * atoms/backend.ts :: useBackendBridge).
 */
import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { backendStateAtom } from '@/atoms/backend'
import { BackendState } from '../../main/python-client/types'
import { hydrateModelsAtom } from '@/atoms/models'
import { rlog } from '@/lib/logger'

export function useModelsHydration(): void {
  const backendState = useAtomValue(backendStateAtom)
  const hydrateModels = useSetAtom(hydrateModelsAtom)
  useEffect(() => {
    if (backendState !== BackendState.Ready) return
    void hydrateModels().catch((err: unknown) => {
      rlog.warn('[app] models hydrate failed', err)
    })
  }, [backendState, hydrateModels])
}
