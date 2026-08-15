import { app, Notification, nativeImage, type NativeImage } from 'electron'
import { mainLog } from './logger'

/**
 * Cross-platform native notifications + dock/taskbar badge.
 *
 *  - macOS: `app.dock.setBadge(count)` shows a red bubble on the dock icon.
 *  - Windows: `setOverlayIcon` paints a small overlay; we render the count
 *    onto a 16×16 PNG in-process so callers don't need to ship a sprite sheet.
 *    For non-numeric badges, fall back to clearing.
 *  - Linux: most DEs don't surface a badge; we set the title-bar dot via
 *    `setBadgeCount` (Unity launcher) when available.
 */

let badgeIcon: NativeImage | undefined

export function initNotificationService(): void {
  if (!Notification.isSupported()) {
    mainLog.warn('[notify] native notifications not supported on this platform')
  }
}

/** Keep JS wrappers alive while their native notification is on screen —
 *  a GC'd wrapper never fires its `click` listener. */
const liveNotifications = new Set<Notification>()

/** Show a native notification. Returns false when unsupported (caller may
 *  degrade to an in-app surface). `onClick` fires when the user activates it. */
export function showNotification(opts: {
  title: string
  body: string
  silent?: boolean
  onClick?: () => void
}): boolean {
  if (!Notification.isSupported()) return false
  const n = new Notification({ title: opts.title, body: opts.body, silent: opts.silent ?? false })
  liveNotifications.add(n)
  n.on('click', () => {
    liveNotifications.delete(n)
    opts.onClick?.()
  })
  // `close` is best-effort (macOS doesn't always emit it); a rare leaked
  // wrapper is bounded by how many notifications a session can produce.
  n.on('close', () => liveNotifications.delete(n))
  n.show()
  return true
}

export function initBadgeIcon(iconPath?: string): void {
  if (!iconPath) return
  badgeIcon = nativeImage.createFromPath(iconPath)
  if (badgeIcon.isEmpty()) {
    mainLog.warn(`[notify] badge icon empty at ${iconPath}`)
    badgeIcon = undefined
  }
}

export function updateBadgeCount(count: number, mainWindow?: Electron.BrowserWindow): void {
  if (process.platform === 'darwin') {
    app.dock?.setBadge(count > 0 ? String(count) : '')
    return
  }

  if (process.platform === 'win32' && mainWindow && !mainWindow.isDestroyed()) {
    if (count <= 0) {
      mainWindow.setOverlayIcon(null, '')
      return
    }
    if (badgeIcon) {
      mainWindow.setOverlayIcon(badgeIcon, `${count} unread`)
    }
    return
  }

  if (process.platform === 'linux') {
    app.setBadgeCount(count)
  }
}
