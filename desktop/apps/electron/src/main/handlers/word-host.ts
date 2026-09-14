import { IPC } from '../../shared/ipc-channels'
import type { EmbeddedBrowserBounds, WordHostOpenRequest } from '../../shared/types'
import type { WordHost } from '../word-host'
import { loggedHandle } from './logged-handle'
import { redactLocalPathLogArgs } from './path-log'

/** Main-window lifecycle commands and owner-checked child-runtime acknowledgements. */
export function registerWordHostHandlers(word: WordHost, emitToHost: (channel: string, value?: unknown) => void): void {
  loggedHandle(IPC.wordHost.snapshot, () => word.snapshot())
  loggedHandle(IPC.wordHost.ensureSession, (_event, sessionId: string) => word.ensureSession(sessionId))
  loggedHandle(IPC.wordHost.closeSession, (_event, sessionId: string) => word.closeSession(sessionId))
  loggedHandle(IPC.wordHost.activateSession, (_event, sessionId: string | null) => word.activateSession(sessionId))
  loggedHandle(IPC.wordHost.setBounds, (event, bounds: EmbeddedBrowserBounds) => {
    const zoom = event.sender.getZoomFactor()
    word.setBounds({ x: bounds.x * zoom, y: bounds.y * zoom, width: bounds.width * zoom, height: bounds.height * zoom })
  })
  loggedHandle(IPC.wordHost.setVisible, (event, visible: boolean, focusHost?: boolean) => {
    word.setVisible(visible)
    if (!visible && focusHost === true && !event.sender.isDestroyed()) event.sender.focus()
  })
  loggedHandle(IPC.wordHost.openFile, (_event, sessionId: string, request: WordHostOpenRequest) => word.openFile(sessionId, request), {
    transformLogArgs: redactLocalPathLogArgs,
  })
  loggedHandle(IPC.wordHost.getConfig, (event) => {
    word.sessionForContents(event.sender.id)
    return word.getConfig()
  })
  loggedHandle(IPC.wordHost.reportState, (event, state: unknown) => word.reportState(event.sender.id, state))
  loggedHandle(IPC.wordHost.requestHide, (event) => {
    const state = word.requestHide(event.sender.id)
    emitToHost(IPC.events.wordHostExpandedChanged, state)
    emitToHost(IPC.events.wordHostHideRequested, state.sessionId)
  })
  loggedHandle(IPC.wordHost.setExpanded, (event, expanded: boolean) => {
    emitToHost(IPC.events.wordHostExpandedChanged, word.setExpanded(event.sender.id, expanded))
  })
  loggedHandle(IPC.wordHost.completeOpenFile, (event, requestId: string, error?: string) => (
    word.completeOpenFile(event.sender.id, requestId, error)
  ))
  loggedHandle(IPC.wordHost.completeFlush, (event, requestId: string, success: boolean) => (
    word.completeFlush(event.sender.id, requestId, success)
  ))
}
