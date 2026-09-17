import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useStore } from 'jotai'
import { draftSessionIdsAtom } from '../atoms/sessions'
import type { OfficeFileKind } from '../../shared/office-files'

const materializing = new Map<string, Promise<string | null>>()
const pending = new Map<string, Promise<unknown>>()

/** Starting an empty editor restores its Session before offering document creation. */
export function useOfficeSessionRestore(kind: OfficeFileKind, sessionId: string | null, active: boolean, hasSession: boolean, restore: () => Promise<unknown>) {
  const store = useStore()
  const restoreRef = useRef(restore)
  useLayoutEffect(() => { restoreRef.current = restore }, [restore])
  const [failure, setFailure] = useState<{ key: string; attempt: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    if (!active || !sessionId || hasSession) return
    let current = true
    const key = `${kind}:${sessionId}`
    let operation = pending.get(key)
    if (!operation) {
      const start = restoreRef.current
      operation = Promise.resolve().then(async () => {
        if (store.get(draftSessionIdsAtom).has(sessionId)) {
          let materialized = materializing.get(sessionId)
          if (!materialized) {
            materialized = import('../atoms/agent').then(({ ensureDaemonSessionAtom }) => store.set(ensureDaemonSessionAtom, sessionId))
            materializing.set(sessionId, materialized)
            void materialized.finally(() => materializing.delete(sessionId)).catch(() => undefined)
          }
          const id = await materialized
          if (!id) throw new Error('The Session workspace could not be created')
          if (id !== sessionId) return
        }
        return start()
      })
      pending.set(key, operation)
      void operation.finally(() => { if (pending.get(key) === operation) pending.delete(key) }).catch(() => undefined)
    }
    void operation.catch(() => { if (current) setFailure({ key, attempt }) })
    return () => { current = false }
  }, [active, attempt, hasSession, kind, sessionId, store])
  return { failed: failure?.key === `${kind}:${sessionId}` && failure.attempt === attempt, retry: () => setAttempt((value) => value + 1) }
}
