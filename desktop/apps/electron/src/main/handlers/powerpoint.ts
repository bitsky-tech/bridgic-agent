import { IPC } from '../../shared/ipc-channels'
import type { EmbeddedPowerPointBounds } from '../../shared/types'
import type { EmbeddedPowerPointManager } from '../embedded-powerpoint-manager'
import { loggedHandle } from './logged-handle'

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

  loggedHandle(IPC.powerpoint.requestClose, () => {
    emitToHost(IPC.events.powerPointCloseRequested)
  })

  loggedHandle(IPC.powerpoint.setExpanded, (_event, expanded: boolean) => {
    if (typeof expanded !== 'boolean') throw new TypeError('PowerPoint expanded must be a boolean')
    emitToHost(IPC.events.powerPointExpandedChanged, expanded)
  })
}
