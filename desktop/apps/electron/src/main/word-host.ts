import type { BrowserWindow, WebContentsView, WebContentsViewConstructorOptions } from 'electron'
import { randomUUID } from 'node:crypto'
import { extname, isAbsolute } from 'node:path'
import { clampZoomLevel, DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'
import { IPC } from '../shared/ipc-channels'
import type {
  EmbeddedBrowserBounds,
  WordHostExpandedEvent,
  WordHostOpenRequest,
  WordHostRendererState,
  WordHostSessionInfo,
  WordHostSnapshot,
} from '../shared/types'
import { OfficeSessionContainer, type OfficeSessionRecord } from './office-session-container'
import { windowLog } from './logger'
import { parseExternalUrl, redactExternalUrlForLog } from './handlers/external-url'

export const WORD_OPEN_TIMEOUT_MS = 30_000
export const WORD_FLUSH_TIMEOUT_MS = 10_000

interface PendingOpen {
  request: WordHostOpenRequest
  sent: boolean
  resolve: () => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface PendingFlush {
  sent: boolean
  resolve: (success: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

interface WordSessionRecord extends OfficeSessionRecord {
  loading: boolean
  documentCount: number | null
  persistenceStatus: WordHostRendererState['persistenceStatus'] | null
  expanded: boolean
  recovering: boolean
  recoveryAttempted: boolean
  pendingOpen: Map<string, PendingOpen>
  pendingFlush: Map<string, PendingFlush>
}

type ViewFactory = (options: WebContentsViewConstructorOptions) => WebContentsView
type ViewLoader = (view: WebContentsView, sessionId: string) => Promise<void>

/** Owns Session Word runtimes while leaving document state and persistence in their renderers. */
export class WordHost {
  private readonly sessions: OfficeSessionContainer<WordSessionRecord>
  private settings: GuiSettings = DEFAULT_SETTINGS

  constructor(
    private readonly createView: ViewFactory,
    private readonly loadView: ViewLoader,
    onStateChanged: (snapshot: WordHostSnapshot) => void = () => undefined,
    private readonly openExternal: (url: string) => void = () => undefined,
  ) {
    this.sessions = new OfficeSessionContainer({
      label: 'Word',
      closeOptions: { waitForBeforeUnload: false },
      onStateChanged: () => onStateChanged(this.snapshot()),
      onError: (error, record) => {
        if (!this.sessions.owns(record)) this.cancelPending(record, new Error('Word renderer could not be loaded'))
        windowLog.warn(`[word-host] creation failed session=${record.sessionId}`, error)
      },
    })
  }

  attachHost(host: BrowserWindow): void { this.sessions.attachHost(host) }
  detachHost(host: BrowserWindow): void { this.sessions.detachHost(host) }
  snapshot(): WordHostSnapshot { return { sessions: [...this.sessions.values()].map((record) => this.infoFor(record)) } }

  async ensureSession(sessionId: string): Promise<WordHostSessionInfo> {
    const id = this.normalizeSessionId(sessionId)
    const record = this.sessions.ensure(id, () => this.createRecord(id), (item) => this.loadRecord(item))
    await record.ready
    if (!this.sessions.owns(record) || record.view.webContents.isDestroyed()) {
      throw new Error(`Word Session closed during creation: ${id}`)
    }
    return this.infoFor(record)
  }

  closeSession(sessionId: string): void {
    const id = this.normalizeSessionId(sessionId)
    const record = this.sessions.get(id)
    if (record) this.cancelPending(record, new Error('Word Session was closed'))
    this.sessions.closeSession(id)
  }

  closeAll(): void {
    for (const record of this.sessions.values()) this.cancelPending(record, new Error('Word host was closed'))
    this.sessions.closeAll()
  }

  activateSession(sessionId: string | null): void {
    this.sessions.activateSession(sessionId === null ? null : this.normalizeSessionId(sessionId))
  }

  setBounds(bounds: EmbeddedBrowserBounds): void {
    if (!bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) {
      throw new TypeError('Word bounds must contain finite coordinates and dimensions')
    }
    this.sessions.setBounds({
      x: Math.round(bounds.x), y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)), height: Math.max(0, Math.round(bounds.height)),
    })
  }

  setVisible(visible: boolean): void {
    if (typeof visible !== 'boolean') throw new TypeError('Word visible must be a boolean')
    this.sessions.setVisible(visible)
  }

  getConfig(): GuiSettings { return this.settings }

  applySettings(settings: GuiSettings): void {
    this.settings = settings
    for (const record of this.sessions.values()) this.sendConfig(record)
  }

  sessionForContents(webContentsId: number): string {
    return this.recordForContents(webContentsId).sessionId
  }

  reportState(webContentsId: number, value: unknown): void {
    const record = this.recordForContents(webContentsId)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid Word runtime state')
    const state = value as Partial<WordHostRendererState>
    if (!Number.isSafeInteger(state.documentCount) || state.documentCount! < 0
      || !['saving', 'saved', 'error'].includes(state.persistenceStatus ?? '')) {
      throw new TypeError('Invalid Word runtime document count or persistence state')
    }
    record.documentCount = state.documentCount!
    record.persistenceStatus = state.persistenceStatus!
    this.sessions.publish()
    this.dispatchPending(record)
  }

  setExpanded(webContentsId: number, expanded: boolean): WordHostExpandedEvent {
    const record = this.recordForContents(webContentsId)
    if (typeof expanded !== 'boolean') throw new TypeError('Word expanded must be a boolean')
    record.expanded = expanded
    const event = { sessionId: record.sessionId, expanded }
    record.view.webContents.send(IPC.events.wordHostExpandedChanged, event)
    this.sessions.publish()
    return event
  }

  /** Closing the panel exits expansion but preserves this Session's editor and documents. */
  requestHide(webContentsId: number): WordHostExpandedEvent {
    const event = this.setExpanded(webContentsId, false)
    if (this.sessions.activeSessionId === event.sessionId) this.sessions.setVisible(false)
    return event
  }

  /** Route an opaque one-use request to the exact Session, waiting for domain restoration. */
  async openFile(sessionId: string, request: WordHostOpenRequest): Promise<void> {
    const id = this.normalizeSessionId(sessionId)
    if (!request || request.sessionId !== id || typeof request.id !== 'string' || !request.id
      || typeof request.name !== 'string' || typeof request.path !== 'string'
      || !isAbsolute(request.path) || extname(request.path).toLowerCase() !== '.docx') {
      throw new TypeError('Word open request must identify its Session and an absolute .docx path')
    }
    await this.withTimeout(this.ensureSession(id), WORD_OPEN_TIMEOUT_MS, 'Word renderer startup timed out')
    const record = this.sessions.get(id)
    if (!record || record.crashed) throw new Error('Word renderer is unavailable')
    return new Promise<void>((resolve, reject) => {
      const ticket = randomUUID()
      const timer = setTimeout(() => {
        record.pendingOpen.delete(ticket)
        reject(new Error('Word document opening timed out'))
      }, WORD_OPEN_TIMEOUT_MS)
      record.pendingOpen.set(ticket, { request: { ...request, id: ticket }, sent: false, resolve, reject, timer })
      this.dispatchPending(record)
    })
  }

  completeOpenFile(webContentsId: number, requestId: string, error?: string): void {
    const record = this.recordForContents(webContentsId)
    if (typeof requestId !== 'string' || (error !== undefined && typeof error !== 'string')) {
      throw new TypeError('Invalid Word open acknowledgement')
    }
    const pending = record.pendingOpen.get(requestId)
    if (!pending || !pending.sent) throw new Error('Word open request is invalid or expired')
    record.pendingOpen.delete(requestId)
    clearTimeout(pending.timer)
    if (error !== undefined) pending.reject(new Error(error || 'Word document could not be opened'))
    else pending.resolve()
  }

  /** A successful reply confirms durable workspace persistence, not a source DOCX write. */
  async flushAll(): Promise<boolean> {
    const records = [...this.sessions.values()]
    const results = await Promise.all(records.map(async (record) => {
      try {
        return await this.withTimeout(this.flushRecord(record), WORD_FLUSH_TIMEOUT_MS, 'Word workspace flush timed out')
      } catch {
        return false
      }
    }))
    return results.every(Boolean)
  }

  completeFlush(webContentsId: number, requestId: string, success: boolean): void {
    const record = this.recordForContents(webContentsId)
    if (typeof requestId !== 'string' || typeof success !== 'boolean') throw new TypeError('Invalid Word flush acknowledgement')
    const pending = record.pendingFlush.get(requestId)
    if (!pending || !pending.sent) throw new Error('Word flush request is invalid or expired')
    record.pendingFlush.delete(requestId)
    clearTimeout(pending.timer)
    pending.resolve(success)
  }

  private createRecord(sessionId: string): WordSessionRecord {
    const view = this.createView({ webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      allowRunningInsecureContent: false, webviewTag: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, backgroundThrottling: false,
      // Keep the main renderer's default partition so existing Word IndexedDB workspaces remain available.
    } })
    const record: WordSessionRecord = {
      sessionId, view, targetId: null, loading: true, crashed: false, ready: Promise.resolve(),
      documentCount: null, persistenceStatus: null, expanded: false,
      recovering: false, recoveryAttempted: false, pendingOpen: new Map(), pendingFlush: new Map(),
    }
    const contents = view.webContents
    const forwardExternal = (url: string) => {
      if (!this.sessions.owns(record) || contents.isDestroyed() || record.crashed) return
      let parsed: URL
      try { parsed = parseExternalUrl(url) } catch { return }
      try {
        this.openExternal(parsed.toString())
      } catch {
        windowLog.warn(`[word-host] external link failed url=${redactExternalUrlForLog(parsed.toString())}`)
      }
    }
    contents.setBackgroundThrottling(false)
    contents.setWindowOpenHandler(({ url }) => {
      forwardExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      event.preventDefault()
      forwardExternal(url)
    })
    contents.on('will-redirect', (event) => event.preventDefault())
    contents.on('did-start-loading', () => {
      if (!this.sessions.owns(record)) return
      record.loading = true
      this.sessions.publish()
    })
    contents.on('did-stop-loading', () => {
      if (!this.sessions.owns(record)) return
      record.loading = false
      this.sessions.publish()
    })
    contents.on('did-finish-load', () => {
      if (!this.sessions.owns(record)) return
      this.sendConfig(record)
      contents.send(IPC.events.wordHostExpandedChanged, { sessionId, expanded: record.expanded })
    })
    contents.on('render-process-gone', () => {
      if (!this.sessions.owns(record) || contents.isDestroyed()) return
      record.crashed = true
      record.targetId = null
      record.documentCount = null
      record.persistenceStatus = null
      this.cancelPending(record, new Error('Word renderer crashed'))
      this.sessions.invalidate(record)
      if (record.recoveryAttempted) return
      record.recoveryAttempted = true
      record.recovering = true
      void this.sessions.reload(record, (item) => this.loadRecord(item)).finally(() => {
        record.recovering = false
      }).catch(() => undefined)
    })
    contents.once('destroyed', () => this.cancelPending(record, new Error('Word renderer was destroyed')))
    return record
  }

  private async loadRecord(record: WordSessionRecord): Promise<void> {
    record.loading = true
    await this.loadView(record.view, record.sessionId)
    if (!this.sessions.owns(record) || record.view.webContents.isDestroyed()) throw new Error('Word Session closed during loading')
    record.loading = record.view.webContents.isLoading()
    this.sendConfig(record)
  }

  private sendConfig(record: WordSessionRecord): void {
    const contents = record.view.webContents
    if (contents.isDestroyed()) return
    contents.setZoomLevel(clampZoomLevel(this.settings.zoomLevel))
    contents.send(IPC.events.wordHostConfigChanged, this.settings)
  }

  private async flushRecord(record: WordSessionRecord): Promise<boolean> {
    if (record.crashed && !record.recovering) return false
    await record.ready
    if (!this.sessions.owns(record) || record.view.webContents.isDestroyed() || record.crashed) return false
    return new Promise<boolean>((resolve) => {
      const ticket = randomUUID()
      const timer = setTimeout(() => {
        record.pendingFlush.delete(ticket)
        resolve(false)
      }, WORD_FLUSH_TIMEOUT_MS)
      record.pendingFlush.set(ticket, { sent: false, resolve, timer })
      this.dispatchPending(record)
    })
  }

  private dispatchPending(record: WordSessionRecord): void {
    if (!this.sessions.owns(record) || record.view.webContents.isDestroyed()
      || record.documentCount === null || record.crashed) return
    for (const [ticket, pending] of record.pendingOpen) {
      if (pending.sent) continue
      pending.sent = true
      try { record.view.webContents.send(IPC.events.wordHostOpenFileRequested, pending.request) } catch (error) {
        record.pendingOpen.delete(ticket)
        clearTimeout(pending.timer)
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
    for (const [ticket, pending] of record.pendingFlush) {
      if (pending.sent) continue
      pending.sent = true
      try { record.view.webContents.send(IPC.events.wordHostFlushRequested, ticket) } catch {
        record.pendingFlush.delete(ticket)
        clearTimeout(pending.timer)
        pending.resolve(false)
      }
    }
  }

  private cancelPending(record: WordSessionRecord, error: Error): void {
    for (const pending of record.pendingOpen.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    record.pendingOpen.clear()
    for (const pending of record.pendingFlush.values()) {
      clearTimeout(pending.timer)
      pending.resolve(false)
    }
    record.pendingFlush.clear()
  }

  private recordForContents(webContentsId: number): WordSessionRecord {
    const record = this.sessions.forWebContents(webContentsId)
    if (!record) throw new Error('Word Session does not own this renderer')
    return record
  }

  private infoFor(record: WordSessionRecord): WordHostSessionInfo {
    return {
      sessionId: record.sessionId, targetId: record.targetId, webContentsId: record.view.webContents.id,
      loading: record.loading, crashed: record.crashed, documentCount: record.documentCount,
      persistenceStatus: record.persistenceStatus, expanded: record.expanded,
    }
  }

  private normalizeSessionId(sessionId: string): string {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new TypeError('Word Session id must be a non-empty string')
    return sessionId.trim()
  }

  private async withTimeout<T>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}
