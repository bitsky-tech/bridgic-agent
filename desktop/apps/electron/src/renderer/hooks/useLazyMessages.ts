/**
 * Refresh an idle visible Session's durable transcript on every switch.
 * In-flight Session subscriptions remain live while hidden; the hydration atom
 * therefore rejects stale snapshots whenever a live reply owns the tail.
 */
import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { activeSessionIdAtom, draftSessionIdsAtom } from '@/atoms/sessions'
import { loadSessionMessagesAtom } from '@/atoms/agent'

export function useLazyMessages(): void {
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const draftIds = useAtomValue(draftSessionIdsAtom)
  const loadMessages = useSetAtom(loadSessionMessagesAtom)

  useEffect(() => {
    if (!activeSessionId) return
    if (draftIds.has(activeSessionId)) return // a draft has no daemon session yet
    void loadMessages(activeSessionId)
    // draftIds intentionally excluded — fire on session switch only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeSessionId, loadMessages])
}
