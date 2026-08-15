/** Snapshot each Session's right-dock visibility and widths when first viewed. */
import { useLayoutEffect } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { rememberRightPanelStateAtom } from '@/atoms/layout'
import { activeSessionIdAtom } from '@/atoms/sessions'

/**
 * A Session without overrides inherits the latest persisted dock geometry.
 * Capture those values on entry so later interactions in another Session cannot
 * retroactively change what this Session was showing or how wide it was.
 */
export function useRememberRightPanelState(): void {
  const sessionId = useAtomValue(activeSessionIdAtom)
  const remember = useSetAtom(rememberRightPanelStateAtom)

  useLayoutEffect(() => {
    if (sessionId) remember(sessionId)
  }, [remember, sessionId])
}
