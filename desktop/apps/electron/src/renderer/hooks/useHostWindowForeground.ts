/**
 * Track whether Electron's native host window is truly in the foreground.
 *
 * Subscribe before reading the initial snapshot so a stale IPC response cannot
 * overwrite a newer focus, visibility, or minimized-state push. The initial
 * value is conservatively false: unseen Browser activity must not be cleared
 * before main confirms that the host is actually viewable.
 */
import { useEffect, useState } from 'react'
import { rlog } from '@/lib/logger'

/** Whether the native host is visible, focused, and not minimized. */
export function useHostWindowForeground(): boolean {
  const [foreground, setForeground] = useState(false)

  useEffect(() => {
    let active = true
    let receivedPush = false
    const apply = (nextForeground: boolean) => {
      if (active) setForeground(nextForeground)
    }
    const unsubscribe = window.api.events.onWindowForegroundChanged((nextForeground) => {
      receivedPush = true
      apply(nextForeground)
    })

    void window.api.window.isForeground()
      .then((initialForeground) => {
        if (!receivedPush) apply(initialForeground)
      })
      .catch((error: unknown) => {
        rlog.debug('[window] foreground snapshot unavailable', error)
      })

    return () => {
      active = false
      unsubscribe()
    }
  }, [])

  return foreground
}
