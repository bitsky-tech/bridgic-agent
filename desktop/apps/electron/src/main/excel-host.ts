import type {
  BrowserWindow,
  Rectangle,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import type {
  EmbeddedBrowserBounds,
  ExcelHostConfig,
  ExcelHostSessionInfo,
  ExcelHostSnapshot,
  ExcelWorkbookOpenRequest,
} from '../shared/types'
import { IPC } from '../shared/ipc-channels'
import { windowLog } from './logger'

const DEFAULT_BOUNDS: Rectangle = { x: 0, y: 0, width: 1280, height: 800 }
const EXCEL_RENDERER_PATHNAME = '/excel.html'

const WEB_PREFERENCES: NonNullable<WebContentsViewConstructorOptions['webPreferences']> = {
  // Isolate the trusted workbook renderer from both the main app renderer and
  // the persistent embedded-browser profile.
  partition: 'excel-host',
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  backgroundThrottling: false,
}

interface ExcelHostRecord {
  sessionId: string
  config: ExcelHostConfig
  view: WebContentsView
  targetId: string | null
  crashed: boolean
  dirty: boolean
  recoveryState: unknown | null
  workbookOpenRequests: Map<string, string>
  ready: Promise<void>
}

type ViewFactory = (options: WebContentsViewConstructorOptions) => WebContentsView

/** Owns exactly one trusted Excel WebContentsView (and CDP target) per Agent Session. */
export class ExcelHost {
  private host: BrowserWindow | null = null
  private readonly records = new Map<string, ExcelHostRecord>()
  private activeSessionId: string | null = null
  private bounds: Rectangle = { ...DEFAULT_BOUNDS }
  private surfaceVisible = false

  constructor(
    private readonly createView: ViewFactory,
    private readonly preloadPath: string,
    private readonly devServerUrl: string | undefined,
    private readonly rendererHtml: string,
    private readonly onStateChanged: (snapshot: ExcelHostSnapshot) => void = () => undefined,
    private readonly confirmDiscardDirty: (count: number) => Promise<boolean> = async () => false,
    private readonly openExternal: (url: string) => void = () => undefined,
  ) {}

  snapshot(): ExcelHostSnapshot {
    return {
      sessions: [...this.records.values()]
        .filter((record) => !record.view.webContents.isDestroyed())
        .map((record) => this.infoFor(record)),
    }
  }

  attachHost(host: BrowserWindow): void {
    if (this.host === host) return
    if (this.host) this.closeAll()
    this.host = host
  }

  detachHost(host: BrowserWindow): void {
    if (this.host !== host) return
    this.closeAll()
    this.host = null
  }

  /** Create the Session target once; subsequent calls only refresh presentation config. */
  async ensureSession(sessionId: string, config: ExcelHostConfig): Promise<ExcelHostSessionInfo> {
    const id = this.normalizeSessionId(sessionId)
    const nextConfig = this.normalizeConfig(id, config)
    let record = this.records.get(id)
    if (!record) record = this.createRecord(id, nextConfig)
    else this.updateConfig(record, nextConfig)
    if (this.activeSessionId === null) this.activeSessionId = id
    this.syncVisibility()
    await record.ready
    return this.infoFor(record)
  }

  /** Ensure the Session target and ask that exact renderer to import a local workbook. */
  async openWorkbook(
    sessionId: string,
    config: ExcelHostConfig,
    request: ExcelWorkbookOpenRequest,
  ): Promise<void> {
    const id = this.normalizeSessionId(sessionId)
    const normalizedRequest = this.normalizeWorkbookOpenRequest(request)
    await this.ensureSession(id, config)
    const record = this.records.get(id)
    if (!record || record.view.webContents.isDestroyed()) {
      throw new Error(`Excel Session does not exist: ${id}`)
    }
    const requestId = randomUUID()
    record.workbookOpenRequests.set(requestId, normalizedRequest.path)
    record.view.webContents.send(IPC.events.excelWorkbookOpenRequested, {
      requestId,
      replaceInitialBlank: normalizedRequest.replaceInitialBlank,
    })
  }

  /** Redeem a one-shot workbook request only from the target it was issued to. */
  consumeWorkbookOpenRequest(webContentsId: number, requestId: string): string {
    if (typeof requestId !== 'string' || requestId.length === 0) {
      throw new Error('Excel workbook open request id is invalid')
    }
    const record = this.recordForWebContents(webContentsId)
    if (!record) throw new Error('Excel Session does not own this renderer')
    const path = record.workbookOpenRequests.get(requestId)
    if (!path) throw new Error('Excel workbook open request is invalid or expired')
    record.workbookOpenRequests.delete(requestId)
    return path
  }

  closeSession(sessionId: string): void {
    const id = this.normalizeSessionId(sessionId)
    const record = this.records.get(id)
    if (!record) return
    this.records.delete(id)
    if (this.activeSessionId === id) this.activeSessionId = null
    this.disposeRecord(record)
    this.syncVisibility()
    this.publishState()
  }

  /** Close only the Session target owned by the requesting child renderer. */
  closeCurrentSession(webContentsId: number): void {
    const record = [...this.records.values()].find(
      (candidate) => candidate.view.webContents.id === webContentsId,
    )
    if (!record) return
    this.closeSession(record.sessionId)
  }

  setDirty(webContentsId: number, dirty: boolean): void {
    if (typeof dirty !== 'boolean') throw new TypeError('Excel dirty state must be a boolean')
    const record = this.recordForWebContents(webContentsId)
    if (!record) throw new Error('Excel Session does not own this renderer')
    if (record.dirty === dirty) return
    record.dirty = dirty
    this.publishState()
  }

  getRecoveryState(webContentsId: number): unknown | null {
    const record = this.recordForWebContents(webContentsId)
    if (!record) throw new Error('Excel Session does not own this renderer')
    return record.recoveryState
  }

  setRecoveryState(webContentsId: number, state: unknown): void {
    const record = this.recordForWebContents(webContentsId)
    if (!record) throw new Error('Excel Session does not own this renderer')
    if (state === null || typeof state !== 'object' || Array.isArray(state)) {
      throw new TypeError('Excel recovery state must be an object')
    }
    record.recoveryState = state
  }

  async confirmClose(): Promise<boolean> {
    const count = [...this.records.values()].filter((record) => record.dirty).length
    return count === 0 || this.confirmDiscardDirty(count)
  }

  activateSession(sessionId: string | null): void {
    if (sessionId === null) {
      this.activeSessionId = null
      this.syncVisibility()
      return
    }
    const id = this.normalizeSessionId(sessionId)
    if (!this.records.has(id)) throw new Error(`Excel Session does not exist: ${id}`)
    this.activeSessionId = id
    this.syncVisibility()
  }

  setBounds(bounds: EmbeddedBrowserBounds): void {
    const next = this.normalizeBounds(bounds)
    if (next.width === 0 || next.height === 0) return
    this.bounds = next
    this.syncVisibility()
  }

  setVisible(visible: boolean): void {
    if (typeof visible !== 'boolean') throw new TypeError('Excel surface visible must be a boolean')
    this.surfaceVisible = visible
    this.syncVisibility()
  }

  closeAll(): void {
    const records = [...this.records.values()]
    this.records.clear()
    this.activeSessionId = null
    this.surfaceVisible = false
    for (const record of records) this.disposeRecord(record)
    this.publishState()
  }

  shutdown(): void {
    this.closeAll()
  }

  private createRecord(sessionId: string, config: ExcelHostConfig): ExcelHostRecord {
    const host = this.host
    if (!host || host.isDestroyed()) throw new Error('main window is unavailable')
    const view = this.createView({
      webPreferences: { ...WEB_PREFERENCES, preload: this.preloadPath },
    })
    const record: ExcelHostRecord = {
      sessionId,
      config,
      view,
      targetId: null,
      crashed: false,
      dirty: false,
      recoveryState: null,
      workbookOpenRequests: new Map(),
      ready: Promise.resolve(),
    }
    this.records.set(sessionId, record)
    this.configureView(record)
    view.setBounds(this.bounds)
    view.setVisible(false)
    host.contentView.addChildView(view)
    view.webContents.once('destroyed', () => this.onDestroyed(record))
    record.ready = this.initializeRecord(record)
    void record.ready.catch((error) => {
      windowLog.warn(`[excel-host] creation failed session=${sessionId}`, error)
    })
    this.syncVisibility()
    this.publishState()
    return record
  }

  private async initializeRecord(record: ExcelHostRecord): Promise<void> {
    try {
      await record.view.webContents.loadURL(this.rendererUrl(record.config))
      record.targetId = await this.resolveTargetId(record.view)
      if (this.records.get(record.sessionId) !== record || record.view.webContents.isDestroyed()) {
        throw new Error(`Excel Session closed during creation: ${record.sessionId}`)
      }
      record.crashed = false
      this.publishState()
    } catch (error) {
      if (this.records.get(record.sessionId) === record) {
        this.records.delete(record.sessionId)
        if (this.activeSessionId === record.sessionId) this.activeSessionId = null
        this.disposeRecord(record)
        this.publishState()
      }
      throw error
    }
  }

  private configureView(record: ExcelHostRecord): void {
    const contents = record.view.webContents
    contents.setBackgroundThrottling(false)
    contents.session.setPermissionCheckHandler(() => false)
    contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    contents.setWindowOpenHandler(({ url }) => {
      this.openExternal(url)
      return { action: 'deny' }
    })
    contents.on('will-navigate', (event, url) => {
      if (this.navigationAllowed(url)) return
      event.preventDefault()
      if (/^(?:https?:|mailto:)/i.test(url)) this.openExternal(url)
    })
    contents.on('did-finish-load', () => {
      contents.send(IPC.events.excelHostConfigChanged, record.config)
      this.publishIfLive(record)
    })
    contents.on('render-process-gone', () => {
      if (this.records.get(record.sessionId) !== record || contents.isDestroyed()) return
      record.crashed = true
      record.targetId = null
      this.publishIfLive(record)
      record.ready = this.initializeRecord(record)
      void record.ready.catch((error) => {
        windowLog.warn(`[excel-host] recovery failed session=${record.sessionId}`, error)
      })
    })
  }

  private updateConfig(record: ExcelHostRecord, config: ExcelHostConfig): void {
    if (record.config.locale === config.locale && record.config.theme === config.theme) return
    record.config = config
    const contents = record.view.webContents
    if (!contents.isDestroyed() && !contents.isLoading()) {
      contents.send(IPC.events.excelHostConfigChanged, config)
    }
  }

  private rendererUrl(config: ExcelHostConfig): string {
    const url = this.devServerUrl
      ? new URL('excel.html', this.devServerUrl.endsWith('/') ? this.devServerUrl : `${this.devServerUrl}/`)
      : new URL(pathToFileURL(this.rendererHtml).toString())
    url.searchParams.set('sessionId', config.sessionId)
    url.searchParams.set('locale', config.locale)
    url.searchParams.set('theme', config.theme)
    return url.toString()
  }

  private navigationAllowed(url: string): boolean {
    try {
      const parsed = new URL(url)
      if (this.devServerUrl) {
        const dev = new URL(this.devServerUrl)
        return parsed.origin === dev.origin && parsed.pathname.endsWith(EXCEL_RENDERER_PATHNAME)
      }
      return parsed.protocol === 'file:' && parsed.pathname === pathToFileURL(this.rendererHtml).pathname
    } catch {
      return false
    }
  }

  private onDestroyed(record: ExcelHostRecord): void {
    if (this.records.get(record.sessionId) !== record) return
    this.records.delete(record.sessionId)
    if (this.activeSessionId === record.sessionId) this.activeSessionId = null
    const host = this.host
    if (host && !host.isDestroyed()) host.contentView.removeChildView(record.view)
    this.syncVisibility()
    this.publishState()
  }

  private disposeRecord(record: ExcelHostRecord): void {
    record.view.setVisible(false)
    const host = this.host
    if (host && !host.isDestroyed()) host.contentView.removeChildView(record.view)
    if (!record.view.webContents.isDestroyed()) {
      record.view.webContents.close({ waitForBeforeUnload: false })
    }
  }

  private syncVisibility(): void {
    const operational = this.activeSessionId
      ? this.records.get(this.activeSessionId) ?? null
      : null
    for (const record of this.records.values()) {
      if (record.view.webContents.isDestroyed()) continue
      if (record !== operational) {
        record.view.setVisible(false)
        record.view.setBounds(this.bounds)
      }
    }
    if (!operational || operational.view.webContents.isDestroyed()) return
    operational.view.setBounds(this.surfaceVisible ? this.bounds : this.parkedBounds())
    operational.view.setVisible(true)
  }

  private parkedBounds(): Rectangle {
    return {
      x: 1 - this.bounds.width,
      y: 1 - this.bounds.height,
      width: this.bounds.width,
      height: this.bounds.height,
    }
  }

  private infoFor(record: ExcelHostRecord): ExcelHostSessionInfo {
    const contents = record.view.webContents
    return {
      sessionId: record.sessionId,
      targetId: record.targetId,
      webContentsId: contents.id,
      ready: record.targetId !== null && !record.crashed,
      crashed: record.crashed,
      dirty: record.dirty,
    }
  }

  private publishIfLive(record: ExcelHostRecord): void {
    if (this.records.get(record.sessionId) === record) this.publishState()
  }

  private publishState(): void {
    this.onStateChanged(this.snapshot())
  }

  private recordForWebContents(webContentsId: number): ExcelHostRecord | null {
    return [...this.records.values()].find(
      (record) => record.view.webContents.id === webContentsId,
    ) ?? null
  }

  private async resolveTargetId(view: WebContentsView): Promise<string> {
    const debug = view.webContents.debugger
    const attachedHere = !debug.isAttached()
    if (attachedHere) debug.attach('1.3')
    try {
      const response = await debug.sendCommand('Target.getTargetInfo') as {
        targetInfo?: { targetId?: unknown }
      }
      const targetId = response.targetInfo?.targetId
      if (typeof targetId !== 'string' || targetId.length === 0) {
        throw new Error('Electron did not return an Excel DevTools target id')
      }
      return targetId
    } finally {
      if (attachedHere && debug.isAttached()) debug.detach()
    }
  }

  private normalizeConfig(sessionId: string, config: ExcelHostConfig): ExcelHostConfig {
    if (!config || typeof config !== 'object') throw new TypeError('Excel host config is required')
    if (config.sessionId !== sessionId) throw new Error('Excel host config Session does not match')
    if (config.locale !== 'en-US' && config.locale !== 'zh-CN') {
      throw new Error('Excel host locale is invalid')
    }
    if (config.theme !== 'light' && config.theme !== 'dark') {
      throw new Error('Excel host theme is invalid')
    }
    return { sessionId, locale: config.locale, theme: config.theme }
  }

  private normalizeWorkbookOpenRequest(request: ExcelWorkbookOpenRequest): ExcelWorkbookOpenRequest {
    if (!request || typeof request !== 'object') {
      throw new TypeError('Excel workbook open request is required')
    }
    if (typeof request.path !== 'string' || request.path.trim().length === 0) {
      throw new Error('Excel workbook path is invalid')
    }
    if (typeof request.replaceInitialBlank !== 'boolean') {
      throw new TypeError('Excel initial workbook replacement flag must be a boolean')
    }
    return { path: request.path, replaceInitialBlank: request.replaceInitialBlank }
  }

  private normalizeSessionId(sessionId: string): string {
    if (typeof sessionId !== 'string') throw new TypeError('Excel Session id must be a string')
    const id = sessionId.trim()
    if (id.length === 0 || id.length > 256) throw new Error('Excel Session id is invalid')
    return id
  }

  private normalizeBounds(bounds: EmbeddedBrowserBounds): Rectangle {
    if (!bounds || typeof bounds !== 'object') throw new TypeError('Excel surface bounds are required')
    const values = [bounds.x, bounds.y, bounds.width, bounds.height]
    if (!values.every(Number.isFinite)) throw new Error('Excel surface bounds must be finite')
    if (bounds.x < 0 || bounds.y < 0 || bounds.width < 0 || bounds.height < 0) {
      throw new Error('Excel surface bounds must be non-negative')
    }
    const x = Math.floor(bounds.x)
    const y = Math.floor(bounds.y)
    const right = bounds.width === 0 ? x : Math.ceil(bounds.x + bounds.width)
    const bottom = bounds.height === 0 ? y : Math.ceil(bounds.y + bounds.height)
    return { x, y, width: right - x, height: bottom - y }
  }
}
