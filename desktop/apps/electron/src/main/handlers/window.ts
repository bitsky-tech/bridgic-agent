import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { WindowManager } from '../window-manager'
import { isNativeWindowForeground } from '../window-visibility'
import { loggedHandle } from './logged-handle'

function senderWindow(event: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender)
}

export function registerWindowHandlers(windowManager: WindowManager): void {
  loggedHandle(IPC.window.minimize, (event) => senderWindow(event)?.minimize())

  loggedHandle(IPC.window.maximizeToggle, (event) => {
    const win = senderWindow(event)
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })

  loggedHandle(IPC.window.isForeground, (event) => {
    const win = senderWindow(event)
    return win ? isNativeWindowForeground(win) : false
  })

  loggedHandle(IPC.window.isFullScreen, (event) => senderWindow(event)?.isFullScreen() ?? false)

  loggedHandle(IPC.window.close, (event) => senderWindow(event)?.close())

  loggedHandle(IPC.window.confirmClose, () => windowManager.confirmClose())
  loggedHandle(IPC.window.cancelClose, () => windowManager.cancelClose())

  // Traffic lights are native chrome painted ABOVE web content, so a fullscreen
  // renderer overlay (the image lightbox) can't cover them — only the window
  // can hide them. macOS-only: the API doesn't exist on other platforms, and
  // they have no such control, so this is a silent no-op there.
  loggedHandle(IPC.window.setTrafficLightsVisible, (event, visible: boolean) => {
    if (process.platform !== 'darwin') return
    senderWindow(event)?.setWindowButtonVisibility(visible)
  })
}
