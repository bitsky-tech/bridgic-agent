import type { App, BrowserWindow, Event as ElectronEvent } from 'electron'

export type WindowsSessionEndEvent = 'query-session-end' | 'session-end'

/**
 * Bind Windows logoff/shutdown notifications to synchronous local cleanup for
 * every BrowserWindow created during this app process's lifetime.
 *
 * Electron does not emit `before-quit` when Windows ends the user session, so
 * the ordinary quit path cannot disarm backend recovery. These BrowserWindow
 * events are deliberately observed without calling `preventDefault`: Amphi
 * must never delay or veto an OS shutdown.
 *
 * Both event kinds run the callback once per app process. `query-session-end`
 * stops recovery as early as possible; `session-end` repeats the idempotent
 * cleanup after Windows commits to ending the session, closing a race with
 * discovery already in flight. Electron reports these events per window, so
 * cross-window deduplication prevents duplicate cleanup while still allowing
 * one callback for each phase.
 *
 * The app-level `browser-window-created` hook is intentional: the main window
 * can be destroyed and recreated, and binding only the first returned window
 * leaves the replacement unprotected. It also binds synchronously at window
 * creation instead of waiting for its renderer to finish loading.
 */
export function installWindowsSessionEndGuard(
  app: App,
  onSessionEnd: (event: WindowsSessionEndEvent) => void,
  platform: NodeJS.Platform = process.platform,
): () => void {
  if (platform !== 'win32') return () => {}

  const handledEvents = new Set<WindowsSessionEndEvent>()
  const windowDisposers = new Map<BrowserWindow, () => void>()

  const dispatchOnce = (event: WindowsSessionEndEvent): void => {
    if (handledEvents.has(event)) return
    handledEvents.add(event)
    onSessionEnd(event)
  }

  const onBrowserWindowCreated = (_event: ElectronEvent, window: BrowserWindow): void => {
    if (windowDisposers.has(window)) return

    // Spell these out rather than looping over a union: Electron exposes them
    // as separate BrowserWindow overloads, so a union event name does not
    // satisfy either overload even though both listeners have the same shape.
    const onQuerySessionEnd = (): void => dispatchOnce('query-session-end')
    const onSessionEndCommitted = (): void => dispatchOnce('session-end')
    const onClosed = (): void => disposeWindow()
    const disposeWindow = (): void => {
      window.removeListener('query-session-end', onQuerySessionEnd)
      window.removeListener('session-end', onSessionEndCommitted)
      window.removeListener('closed', onClosed)
      windowDisposers.delete(window)
    }

    window.on('query-session-end', onQuerySessionEnd)
    window.on('session-end', onSessionEndCommitted)
    window.once('closed', onClosed)
    windowDisposers.set(window, disposeWindow)
  }

  app.on('browser-window-created', onBrowserWindowCreated)

  return () => {
    app.removeListener('browser-window-created', onBrowserWindowCreated)
    for (const disposeWindow of [...windowDisposers.values()]) disposeWindow()
  }
}
