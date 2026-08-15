/**
 * Auto-acknowledge the unread dot on the session you're actually looking at.
 *
 * The sidebar dot is per-session unread state (daemon `session.completed`
 * broadcast, or `status="completed"` on hydrate). Whenever the ACTIVE session
 * carries a dot — its own turn finished while it was open, or it loaded
 * `completed` — reading it IS looking at it: clear the dot + POST the read
 * receipt so the daemon flips it back to `finish` (no dot on the next reload).
 *
 * "Active" is NOT enough on its own — the session must also be ON SCREEN, which
 * `viewedSessionIdAtom` encodes (null outside Home nav; see its TSDoc). Without
 * that, a session finishing while the user sits on the Schedules page would count as
 * "read", clearing its ✓ in the same frame it appears — and the receipt POST
 * would make that permanent. Same atom backs the sidebar's unread filter, so
 * the two can't drift.
 *
 * One effect, no render output; runs for the app's lifetime. This is the single
 * place "viewing an unread session marks it read" lives — it covers select,
 * session restore, and a completion that lands while the session is open.
 */
import { useEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { viewedSessionIdAtom } from '@/atoms/amphi'
import { markSessionReadAtom, sessionsMetaAtom } from '@/atoms/sessions'

/** Mark the on-screen session read whenever it carries an unread dot. */
export function useActiveSessionReadReceipt(): void {
  const viewedId = useAtomValue(viewedSessionIdAtom)
  const sessions = useAtomValue(sessionsMetaAtom)
  const markRead = useSetAtom(markSessionReadAtom)
  const unreadViewed = !!viewedId && sessions.some((s) => s.id === viewedId && s.hasRedDot)
  useEffect(() => {
    if (unreadViewed && viewedId) markRead(viewedId)
  }, [unreadViewed, viewedId, markRead])
}
