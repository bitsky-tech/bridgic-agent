import { BrowserWindow, dialog, type OpenDialogOptions } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { EmbeddedPowerPointBounds } from '../../shared/types'
import type { EmbeddedPowerPointManager } from '../embedded-powerpoint-manager'
import { loggedHandle } from './logged-handle'
import { registerOfficeCloseHandler } from './office-close'
import { redactLocalPathLogArgs } from './path-log'

export function registerPowerPointHandlers(
  powerpoint: EmbeddedPowerPointManager,
  emitToHost: (channel: string, value?: unknown) => void,
): void {
  loggedHandle(IPC.powerpoint.snapshot, () => powerpoint.snapshot())

  loggedHandle(IPC.powerpoint.ensureSession, (_event, sessionId: string) => {
    return powerpoint.ensureSession(sessionId)
  })

  loggedHandle(IPC.powerpoint.closeSession, (_event, sessionId: string) => {
    powerpoint.closeSession(sessionId)
  })

  loggedHandle(IPC.powerpoint.activateSession, (_event, sessionId: string | null) => {
    powerpoint.activateSession(sessionId)
  })

  loggedHandle(IPC.powerpoint.setBounds, (event, bounds: EmbeddedPowerPointBounds) => {
    const zoom = event.sender.getZoomFactor()
    powerpoint.setBounds({
      x: bounds.x * zoom,
      y: bounds.y * zoom,
      width: bounds.width * zoom,
      height: bounds.height * zoom,
    })
  })

  loggedHandle(IPC.powerpoint.setVisible, (event, visible: boolean, focusHost?: boolean) => {
    powerpoint.setVisible(visible)
    if (!visible && focusHost === true && !event.sender.isDestroyed()) event.sender.focus()
  })

  registerOfficeCloseHandler({
    requestChannel: IPC.powerpoint.requestClose,
    closedEvent: IPC.events.powerPointCloseRequested,
    host: powerpoint,
    emitToHost,
    requireSessionId: true,
  })

  loggedHandle(IPC.powerpoint.setExpanded, (_event, expanded: boolean) => {
    if (typeof expanded !== 'boolean') throw new TypeError('PowerPoint expanded must be a boolean')
    emitToHost(IPC.events.powerPointExpandedChanged, expanded)
  })

  loggedHandle(IPC.powerpoint.reportState, (event, state: unknown) => {
    powerpoint.reportState(event.sender.id, state)
  })

  loggedHandle(IPC.powerpoint.openDocument, async (event) => {
    const sessionId = powerpoint.sessionForContents(event.sender.id)
    const options: OpenDialogOptions = {
      title: 'Open PowerPoint Presentation',
      properties: ['openFile'],
      filters: [{ name: 'PowerPoint presentations', extensions: ['pptx'] }],
    }
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    const path = result.filePaths[0]
    if (result.canceled || !path) return
    await powerpoint.openFile(sessionId, path)
  }, { transformLogArgs: redactLocalPathLogArgs })

  loggedHandle(
    IPC.powerpoint.openFile,
    (event, sessionId: string, absPath: string) => {
      const ownedSessionId = powerpoint.ownedSessionForContents(event.sender.id)
      if (ownedSessionId !== null && ownedSessionId !== String(sessionId ?? '').trim()) {
        throw new Error('PowerPoint Session does not own the requested editor')
      }
      return powerpoint.openFile(ownedSessionId ?? sessionId, absPath)
    },
    { transformLogArgs: redactLocalPathLogArgs },
  )
}
