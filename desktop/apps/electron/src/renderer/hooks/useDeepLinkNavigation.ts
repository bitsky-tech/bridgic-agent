/**
 * Subscribe to main's deep-link event stream and navigate accordingly.
 *
 * Sources: OS-delivered `amphi://` URLs (cold start / second instance) and
 * notification clicks (main routes both through the same deliverDeepLink
 * path, so buffered-before-mount URLs replay once this hook attaches).
 *
 * Unknown URL shapes are ignored (parseDeepLink returns null) — this hook
 * only owns navigation links; other `amphi://` consumers register their own
 * listeners.
 */
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { parseDeepLink } from '@/lib/deepLink'
import { rlog } from '@/lib/logger'
import { openRunFromNotificationAtom } from '@/atoms/schedules'

export function useDeepLinkNavigation(): void {
  const openRunFromNotification = useSetAtom(openRunFromNotificationAtom)
  useEffect(() => {
    return window.api.events.onDeepLink((url) => {
      const target = parseDeepLink(url)
      if (!target) {
        rlog.debug('[deep-link] ignored url', { url })
        return
      }
      // Single kind today; switch when the next target lands.
      void openRunFromNotification({
        scheduleId: target.scheduleId,
        sessionId: target.sessionId,
      })
    })
  }, [openRunFromNotification])
}
