import { IPC } from '../../shared/ipc-channels'
import type {
  EmbeddedBrowserBounds,
  ExcelHostConfig,
  ExcelWorkbookOpenRequest,
} from '../../shared/types'
import type { EmbeddedBrowserManager } from '../embedded-browser-manager'
import type { ExcelHost } from '../excel-host'
import { loggedHandle } from './logged-handle'

/** Register the renderer control plane for Session-scoped native Excel targets. */
export function registerExcelHostHandlers(excelHost: ExcelHost, browser: EmbeddedBrowserManager): void {
  loggedHandle(IPC.excelHost.snapshot, () => excelHost.snapshot())

  loggedHandle(
    IPC.excelHost.ensureSession,
    (_event, sessionId: string, config: ExcelHostConfig) => excelHost.ensureSession(sessionId, config),
  )

  loggedHandle(
    IPC.excelHost.openWorkbook,
    (_event, sessionId: string, config: ExcelHostConfig, request: ExcelWorkbookOpenRequest) => (
      excelHost.openWorkbook(sessionId, config, request)
    ),
  )

  loggedHandle(IPC.excelHost.closeSession, (_event, sessionId: string) => {
    excelHost.closeSession(sessionId)
  })

  loggedHandle(IPC.excelHost.closeCurrentSession, (event) => {
    const webContentsId = event.sender.id
    // Let the invoke response settle before destroying the renderer that made it.
    setImmediate(() => excelHost.closeCurrentSession(webContentsId))
  })

  loggedHandle(IPC.excelHost.setDirty, (event, dirty: boolean) => {
    excelHost.setDirty(event.sender.id, dirty)
  })

  loggedHandle(IPC.excelHost.getRecoveryState, (event) => {
    return excelHost.getRecoveryState(event.sender.id)
  })

  loggedHandle(IPC.excelHost.setRecoveryState, (event, state: unknown) => {
    excelHost.setRecoveryState(event.sender.id, state)
  })

  loggedHandle(IPC.excelHost.activateSession, (_event, sessionId: string | null) => {
    excelHost.activateSession(sessionId)
  })

  loggedHandle(IPC.excelHost.setBounds, (event, bounds: EmbeddedBrowserBounds) => {
    const zoom = event.sender.getZoomFactor()
    excelHost.setBounds({
      x: bounds.x * zoom,
      y: bounds.y * zoom,
      width: bounds.width * zoom,
      height: bounds.height * zoom,
    })
  })

  loggedHandle(IPC.excelHost.setVisible, (event, visible: boolean, focusHost?: boolean) => {
    if (visible) browser.setVisible(false)
    excelHost.setVisible(visible)
    if (!visible && focusHost === true && !event.sender.isDestroyed()) event.sender.focus()
  })
}
