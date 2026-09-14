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
import { OfficeSessionContainer, type OfficeSessionRecord } from './office-session-container'

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

interface ExcelHostRecord extends OfficeSessionRecord {
  config: ExcelHostConfig
  dirty: boolean
  recoveryState: unknown | null
  workbookOpenRequests: Map<string, string>
}

type ViewFactory = (options: WebContentsViewConstructorOptions) => WebContentsView

/** Owns exactly one trusted Excel WebContentsView (and CDP target) per Agent Session. */
export class ExcelHost {
  private readonly container: OfficeSessionContainer<ExcelHostRecord>

  constructor(
    private readonly createView: ViewFactory,
    private readonly preloadPath: string,
    private readonly devServerUrl: string | undefined,
    private readonly rendererHtml: string,
    private readonly onStateChanged: (snapshot: ExcelHostSnapshot) => void = () => undefined,
    private readonly confirmDiscardDirty: (count: number) => Promise<boolean> = async () => false,
    private readonly openExternal: (url: string) => void = () => undefined,
  ) {
    this.container = new OfficeSessionContainer({
      label: 'Excel',
      visibility: 'park-active',
      closeOptions: { waitForBeforeUnload: false },
      onStateChanged: () => this.onStateChanged(this.snapshot()),
      onError: (error, record) => {
        windowLog.warn(`[excel-host] initialization failed session=${record.sessionId}`, error)
      },
    })
  }

  snapshot(): ExcelHostSnapshot {
    return {
      sessions: [...this.container.values()]
        .filter((record) => !record.view.webContents.isDestroyed())
        .map((record) => this.infoFor(record)),
    }
  }

  attachHost(host: BrowserWindow): void {
    this.container.attachHost(host)
  }

  detachHost(host: BrowserWindow): void {
    this.container.detachHost(host)
  }

  /** Create the Session target once; subsequent calls only refresh presentation config. */
  async ensureSession(sessionId: string, config: ExcelHostConfig): Promise<ExcelHostSessionInfo> {
    const id = this.normalizeSessionId(sessionId)
    const nextConfig = this.normalizeConfig(id, config)
    const record = this.container.ensure(
      id,
      () => this.createRecord(id, nextConfig),
      (current) => current.view.webContents.loadURL(this.rendererUrl(current.config)),
    )
    this.updateConfig(record, nextConfig)
    if (this.container.activeSessionId === null) this.container.activateSession(id)
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
    const record = this.container.get(id)
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
    this.container.closeSession(this.normalizeSessionId(sessionId))
  }

  /** Close only the Session target owned by the requesting child renderer. */
  closeCurrentSession(webContentsId: number): void {
    const record = this.container.forWebContents(webContentsId)
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
    const count = [...this.container.values()].filter((record) => record.dirty).length
    return count === 0 || this.confirmDiscardDirty(count)
  }

  activateSession(sessionId: string | null): void {
    const id = sessionId === null ? null : this.normalizeSessionId(sessionId)
    if (id !== null && !this.container.get(id)) throw new Error(`Excel Session does not exist: ${id}`)
    this.container.activateSession(id)
  }

  setBounds(bounds: EmbeddedBrowserBounds): void {
    this.container.setBounds(this.normalizeBounds(bounds))
  }

  setVisible(visible: boolean): void {
    if (typeof visible !== 'boolean') throw new TypeError('Excel surface visible must be a boolean')
    this.container.setVisible(visible)
  }

  closeAll(): void {
    this.container.closeAll()
  }

  shutdown(): void {
    this.closeAll()
  }

  private createRecord(sessionId: string, config: ExcelHostConfig): ExcelHostRecord {
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
    this.configureView(record)
    return record
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
      if (!this.container.owns(record) || contents.isDestroyed()) return
      this.container.invalidate(record)
      void this.container.reload(record, (current) => (
        current.view.webContents.loadURL(this.rendererUrl(current.config))
      ))
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
    if (this.container.owns(record)) this.publishState()
  }

  private publishState(): void {
    this.container.publish()
  }

  private recordForWebContents(webContentsId: number): ExcelHostRecord | null {
    return this.container.forWebContents(webContentsId)
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
