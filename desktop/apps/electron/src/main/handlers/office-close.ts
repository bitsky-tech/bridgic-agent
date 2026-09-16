import { loggedHandle } from './logged-handle'

interface OfficeCloseHost {
  /** Reject senders that are not a live target owned by this editor. */
  sessionForContents: (webContentsId: number) => string
  /** Resolve the original sender again; never destroy a replacement by Session ID. */
  closeCurrentSession: (webContentsId: number) => void
}

interface OfficeCloseHandlerOptions {
  requestChannel: string
  closedEvent: string
  host: OfficeCloseHost
  emitToHost: (channel: string, sessionId: string) => void
  /** Bounded editor-specific checkpoint; its adapter decides how failures are handled. */
  prepareClose?: (webContentsId: number) => Promise<unknown>
  /** Preserve older protocols that require the child to also supply its Session ID. */
  requireSessionId?: boolean
}

/** Shared child-to-host close handshake. UI state remains scoped to the sender's Session. */
export function registerOfficeCloseHandler({ requestChannel, closedEvent, host, emitToHost, prepareClose, requireSessionId }: OfficeCloseHandlerOptions): void {
  loggedHandle(requestChannel, async (event, requestedSessionId?: string) => {
    const webContentsId = event.sender.id
    const sessionId = host.sessionForContents(webContentsId)
    if (requireSessionId && requestedSessionId !== sessionId) {
      throw new Error('Office close request does not own the requested Session')
    }
    if (prepareClose) await prepareClose(webContentsId)
    // A checkpoint may outlive the target. Do not collapse a newly opened replacement.
    if (host.sessionForContents(webContentsId) !== sessionId) {
      throw new Error('Office Session changed during close preparation')
    }
    emitToHost(closedEvent, sessionId)
    // Acknowledge invoke() before destroying its sender, with ownership checked again.
    setImmediate(() => host.closeCurrentSession(webContentsId))
  })
}
