import { BrowserWindow, dialog, type OpenDialogOptions, type SaveDialogOptions } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { loggedHandle } from './logged-handle'

function focused(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export function registerDialogHandlers(): void {
  loggedHandle(IPC.dialog.open, async (_event, options: OpenDialogOptions) => {
    const win = focused()
    return win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
  })

  loggedHandle(IPC.dialog.save, async (_event, options: SaveDialogOptions) => {
    const win = focused()
    return win
      ? await dialog.showSaveDialog(win, options)
      : await dialog.showSaveDialog(options)
  })
}
