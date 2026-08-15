/**
 * Per-session draft sync hook. 300ms debounce to limit atom writes.
 *
 * Caller: FreeFormInput calls this hook whenever the local input state changes.
 * On session switch the caller proactively pulls the draft back from sessionDraftsAtom to seed the local state.
 *
 * Session-switch flush:
 *   If sessionA still has a pending debounce timer (the user's typing in the last 300ms
 *   has not been written) and the user switches to sessionB at that moment — the effect
 *   re-runs, the old timer is cleared by the cleanup, and that last stretch of typing is
 *   lost. Fix: detect the sessionId change at the top of the effect, immediately flush the
 *   old session's pending text, and only then start the new session's debounce.
 *
 * Unmount flush:
 *   The same loss also happens when the whole composer unmounts (switching to the workflows/Skills nav views),
 *   where the session-switch flush is never reached. A separate unmount-only effect flushes using the latest
 *   values held in refs.
 */
import { useEffect, useRef } from 'react'
import { useSetAtom } from 'jotai'
import { setSessionDraftAtom } from '@/atoms/sessions'
import type { Segment } from '../segments'

export function useDraftSync(sessionId: string | null, segments: Segment[]): void {
  const setDraft = useSetAtom(setSessionDraftAtom)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // Track last (sessionId, segments) so we can flush them when session changes.
  const lastSessionIdRef = useRef<string | null>(null)
  const lastSegmentsRef = useRef<Segment[]>(segments)

  useEffect(() => {
    // Session changed and there was a previous session: flush its last segments
    // (which may include the last 300ms of typing that hadn't fired yet).
    const prevSessionId = lastSessionIdRef.current
    if (prevSessionId !== null && prevSessionId !== sessionId) {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = undefined
      }
      setDraft({ id: prevSessionId, segments: lastSegmentsRef.current })
    }
    lastSessionIdRef.current = sessionId
    lastSegmentsRef.current = segments

    if (!sessionId) return
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      setDraft({ id: sessionId, segments })
    }, 300)
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [sessionId, segments, setDraft])

  // Unmount flush: the main effect's cleanup only clears the timer, so typing
  // inside the 300ms window would be lost when the composer unmounts (e.g.
  // switching to a nav view). Flush the refs' latest values once on unmount —
  // idempotent with the timer write, so double-flush is harmless.
  useEffect(() => {
    return () => {
      if (lastSessionIdRef.current !== null) {
        setDraft({ id: lastSessionIdRef.current, segments: lastSegmentsRef.current })
      }
    }
  }, [setDraft])
}
