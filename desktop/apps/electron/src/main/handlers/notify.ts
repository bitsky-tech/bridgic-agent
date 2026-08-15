/**
 * Native desktop notification IPC (`notify:show`).
 *
 * The renderer relays the daemon's `schedule.notify` WS frame here; main owns
 * the Notification API so toasts carry the app's identity (bundle id / AUMID)
 * instead of a generic script host. Clicking the toast routes through the
 * deep-link path (`deliverDeepLink`) — same focus/buffer semantics as an
 * OS-handed `amphi://` URL, so a hidden tray-mode window is revealed first.
 *
 * Invariant: this channel never throws for unsupported platforms — it reports
 * `{ shown: false }` and lets the renderer decide how to degrade.
 */
import { IPC } from '../../shared/ipc-channels'
import type { ShowNotificationPayload, ShowNotificationResult } from '../../shared/types'
import { deliverDeepLink } from '../deep-link'
import { showNotification } from '../notifications'
import { loggedHandle } from './logged-handle'

export function registerNotifyHandlers(): void {
  loggedHandle(
    IPC.notify.show,
    async (_event, payload: ShowNotificationPayload): Promise<ShowNotificationResult> => {
      const shown = showNotification({
        title: payload.title,
        body: payload.body,
        onClick: () =>
          deliverDeepLink(`amphi://schedule-run/${payload.scheduleId}/${payload.sessionId}`),
      })
      return { shown }
    },
  )
}
