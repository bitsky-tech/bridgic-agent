/**
 * Mirrors the native BrowserWindow full-screen state onto the root element.
 *
 * macOS removes its traffic-light buttons in an OS full-screen space, so the
 * fixed 86px title-bar inset must disappear with them. CSS owns the actual
 * layout; this hook only bridges Electron's native state into a stable
 * `data-window-full-screen` selector.
 *
 * Subscribe before reading the initial snapshot. Otherwise an enter/leave
 * event racing the async IPC query could be overwritten by an older value.
 */
import { useEffect } from 'react'
import { rlog } from '@/lib/logger'

/** Keep the root full-screen marker synchronized with the native window. */
export function useWindowFullScreenMarker(): void {
  useEffect(() => {
    const root = document.documentElement
    let active = true
    let receivedPush = false

    const apply = (fullScreen: boolean) => {
      if (!active) return
      root.dataset.windowFullScreen = String(fullScreen)
    }

    const unsubscribe = window.api.events.onWindowFullScreenChanged((fullScreen) => {
      receivedPush = true
      apply(fullScreen)
    })

    void window.api.window.isFullScreen()
      .then((fullScreen) => {
        if (!receivedPush) apply(fullScreen)
      })
      .catch((error: unknown) => {
        rlog.debug('[window] full-screen snapshot unavailable', error)
      })

    return () => {
      active = false
      unsubscribe()
      delete root.dataset.windowFullScreen
    }
  }, [])
}
