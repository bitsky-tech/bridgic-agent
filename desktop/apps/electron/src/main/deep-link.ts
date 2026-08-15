import { app } from 'electron'
import { mainLog } from './logger'
import { classifySecondInstance, parseLaunchIntent } from './launch-intent'

/**
 * Register a custom URL protocol (e.g. `myapp://...`) and surface it to the
 * renderer via a callback whenever the OS hands us one.
 *
 * Handles three platform quirks:
 *  - macOS: open-url event fires (single-instance only)
 *  - Windows / Linux: URL arrives as argv[] on subsequent launches, so we grab
 *    the single-instance lock to redirect that to the running instance
 *  - Cold-start: the URL is in process.argv before any window exists
 */
export interface DeepLinkOptions {
  scheme: string // e.g. 'myapp'
  onUrl: (url: string) => void
  focusWindow?: () => void
}

let bufferedUrl: string | undefined
let liveHandler: ((url: string) => void) | undefined

function emit(url: string): void {
  if (liveHandler) {
    liveHandler(url)
  } else {
    mainLog.info('[deep-link] buffering url until handler attached')
    bufferedUrl = url
  }
}

/** Deliver a deep link from INSIDE the app (e.g. a notification click) through
 *  the same path an OS-handed URL takes: focus the window, forward to the
 *  renderer, or buffer until the handler attaches. */
export function deliverDeepLink(url: string): void {
  emit(url)
}

/** Returns true only for the process that owns the single-instance lock. */
export function setupDeepLink(opts: DeepLinkOptions): boolean {
  const { scheme, onUrl, focusWindow } = opts

  // Acquire ownership before registering protocol/event handlers. The losing
  // process exists only to forward argv to the owner and must not bootstrap a
  // second tray, BrowserWindow, IPC handler set, or backend client.
  const gotLock = app.requestSingleInstanceLock()
  if (!gotLock) {
    app.quit()
    return false
  }

  // 1) Register the scheme so the OS knows to forward it to us.
  if (process.defaultApp) {
    // Dev: pass the script path Electron was launched with so subsequent
    // OS-triggered URLs spawn the same dev instance, not a fresh shell.
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [process.argv[1]!])
    }
  } else {
    app.setAsDefaultProtocolClient(scheme)
  }

  liveHandler = (url: string) => {
    onUrl(url)
    focusWindow?.()
  }

  // Replay any URL that arrived before the handler was wired up.
  if (bufferedUrl) {
    const replay = bufferedUrl
    bufferedUrl = undefined
    liveHandler(replay)
  }

  // 2) macOS: handed to us via event.
  app.on('open-url', (event, url) => {
    event.preventDefault()
    mainLog.info(`[deep-link] open-url ${url}`)
    emit(url)
  })

  // 3) Windows / Linux: single-instance lock funnels second launches into the
  // running process. A normal launch focuses; a pure background duplicate is
  // ignored; a URL is delivered and focused through liveHandler.
  app.on('second-instance', (_event, argv) => {
    const action = classifySecondInstance(parseLaunchIntent(argv, scheme))
    mainLog.info(`[deep-link] second-instance ${action.kind}`)
    if (action.kind === 'deep-link') emit(action.url)
    if (action.kind === 'focus') focusWindow?.()
  })

  // 4) Cold start (process.argv contains the URL).
  const coldStartUrl = parseLaunchIntent(process.argv, scheme).deepLinkUrl
  if (coldStartUrl) {
    mainLog.info(`[deep-link] cold-start ${coldStartUrl}`)
    emit(coldStartUrl)
  }
  return true
}
