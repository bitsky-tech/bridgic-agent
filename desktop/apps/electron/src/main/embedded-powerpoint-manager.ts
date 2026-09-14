import type {
  BrowserWindow,
  Rectangle,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from 'electron'
import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  EmbeddedPowerPointBounds,
  EmbeddedPowerPointOpenFileResult,
  EmbeddedPowerPointSessionInfo,
  EmbeddedPowerPointSnapshot,
} from '../shared/types'
import { clampZoomLevel, type GuiSettings } from '@app/shared/types'
import { IPC } from '../shared/ipc-channels'
import { windowLog } from './logger'
import { OfficeSessionContainer, type OfficeSessionRecord } from './office-session-container'

const MAX_OPEN_PRESENTATION_BYTES = 250 * 1024 * 1024

interface EmbeddedPowerPointSurface extends OfficeSessionRecord {
  loading: boolean
  openingFilesByPath: Map<string, Promise<EmbeddedPowerPointOpenFileResult>>
}

type ViewFactory = (options: WebContentsViewConstructorOptions) => WebContentsView
type ViewLoader = (view: WebContentsView, sessionId: string) => Promise<void>

/** Owns one PowerPoint renderer/CDP target for every Agent Session. */
export class EmbeddedPowerPointManager {
  private readonly container: OfficeSessionContainer<EmbeddedPowerPointSurface>

  constructor(
    private readonly createView: ViewFactory,
    private readonly loadView: ViewLoader,
    private readonly onStateChanged: (snapshot: EmbeddedPowerPointSnapshot) => void = () => undefined,
  ) {
    this.container = new OfficeSessionContainer({
      label: 'PowerPoint',
      onStateChanged: () => this.onStateChanged(this.snapshot()),
      onError: (error, surface) => {
        windowLog.warn(`[embedded-powerpoint] creation failed session=${surface.sessionId}`, error)
      },
    })
  }

  snapshot(): EmbeddedPowerPointSnapshot {
    return { sessions: [...this.container.values()].map((surface) => this.infoFor(surface)) }
  }

  attachHost(host: BrowserWindow): void {
    this.container.attachHost(host)
  }

  detachHost(host: BrowserWindow): void {
    this.container.detachHost(host)
  }

  async ensureSession(sessionId: string): Promise<EmbeddedPowerPointSessionInfo> {
    const id = this.normalizeSessionId(sessionId)
    const surface = this.container.ensure(
      id,
      () => this.createSurface(id),
      async (record) => {
        await this.loadView(record.view, record.sessionId)
        if (this.container.owns(record) && !record.view.webContents.isDestroyed()) {
          record.loading = record.view.webContents.isLoading()
        }
      },
      (record) => record.crashed,
    )
    await surface.ready
    return this.infoFor(surface)
  }

  sessionInfo(sessionId: string): EmbeddedPowerPointSessionInfo | null {
    const surface = this.container.get(this.normalizeSessionId(sessionId))
    return surface ? this.infoFor(surface) : null
  }

  /** Import one local PPTX into the exact Session-owned native editor. */
  async openFile(sessionId: string, candidatePath: string): Promise<EmbeddedPowerPointOpenFileResult> {
    const id = this.normalizeSessionId(sessionId)
    if (typeof candidatePath !== 'string' || !path.isAbsolute(candidatePath)) {
      throw new Error('PowerPoint file path must be absolute')
    }
    if (path.extname(candidatePath).toLowerCase() !== '.pptx') {
      throw new Error('PowerPoint file path must end with .pptx')
    }
    const canonicalPath = await realpath(candidatePath)
    const fileStat = await stat(canonicalPath)
    if (!fileStat.isFile()) throw new Error('PowerPoint file must be a regular file')
    if (fileStat.size > MAX_OPEN_PRESENTATION_BYTES) {
      throw new Error('PowerPoint file is too large to open')
    }
    await this.ensureSession(id)
    const surface = this.container.get(id)
    if (!surface) throw new Error(`PowerPoint Session is unavailable: ${id}`)
    const pending = surface.openingFilesByPath.get(canonicalPath)
    if (pending) return pending
    const opening = this.openFileInSurface(surface, canonicalPath)
    surface.openingFilesByPath.set(canonicalPath, opening)
    try {
      return await opening
    } finally {
      if (surface.openingFilesByPath.get(canonicalPath) === opening) {
        surface.openingFilesByPath.delete(canonicalPath)
      }
    }
  }

  activateSession(sessionId: string | null): void {
    this.container.activateSession(sessionId === null ? null : this.normalizeSessionId(sessionId))
  }

  closeSession(sessionId: string): void {
    this.container.closeSession(this.normalizeSessionId(sessionId))
  }

  setBounds(bounds: EmbeddedPowerPointBounds): void {
    this.container.setBounds(this.normalizeBounds(bounds))
  }

  setVisible(visible: boolean): void {
    if (typeof visible !== 'boolean') throw new TypeError('PowerPoint visible must be a boolean')
    this.container.setVisible(visible)
  }

  closeAll(): void {
    this.container.closeAll()
  }

  /** Keep dedicated PPT renderers aligned with the main App theme, locale, and zoom. */
  applySettings(settings: GuiSettings): void {
    const zoomLevel = clampZoomLevel(settings.zoomLevel)
    for (const surface of this.container.values()) {
      const contents = surface.view.webContents
      if (contents.isDestroyed()) continue
      contents.setZoomLevel(zoomLevel)
      contents.send(IPC.events.settingsChanged, settings)
    }
  }

  private createSurface(sessionId: string): EmbeddedPowerPointSurface {
    const view = this.createView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        backgroundThrottling: false,
      },
    })
    const surface: EmbeddedPowerPointSurface = {
      sessionId,
      view,
      targetId: null,
      loading: true,
      crashed: false,
      ready: Promise.resolve(),
      openingFilesByPath: new Map(),
    }
    view.webContents.setBackgroundThrottling(false)
    view.webContents.on('did-start-loading', () => {
      if (!this.container.owns(surface)) return
      surface.loading = true
      this.publishState()
    })
    view.webContents.on('did-stop-loading', () => {
      if (!this.container.owns(surface)) return
      surface.loading = false
      this.publishState()
    })
    view.webContents.on('render-process-gone', () => {
      this.container.invalidate(surface)
    })
    return surface
  }

  private async openFileInSurface(
    surface: EmbeddedPowerPointSurface,
    canonicalPath: string,
  ): Promise<EmbeddedPowerPointOpenFileResult> {
    const content = await readFile(canonicalPath)
    const value = await this.dispatchToSurface(surface, {
      method: 'view_ppt',
      params: {
        target: canonicalPath,
        file_name: path.basename(canonicalPath),
        content_base64: content.toString('base64'),
      },
    })
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('PowerPoint renderer returned an invalid file-open result')
    }
    const result = value as Record<string, unknown>
    const identity = result.identity
    const meta = result.meta
    if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
      throw new Error('PowerPoint renderer returned an invalid file identity')
    }
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
      throw new Error('PowerPoint renderer returned invalid file metadata')
    }
    const identityValue = identity as Record<string, unknown>
    const metaValue = meta as Record<string, unknown>
    if (typeof identityValue.document_id !== 'string' || typeof metaValue.total_pages !== 'number') {
      throw new Error('PowerPoint renderer returned an incomplete file-open result')
    }
    return {
      documentId: identityValue.document_id,
      fileName: path.basename(canonicalPath),
      reused: result.reused === true,
      slideCount: metaValue.total_pages,
      title: typeof identityValue.name === 'string'
        ? identityValue.name
        : path.basename(canonicalPath, '.pptx'),
    }
  }

  private async dispatchToSurface(
    surface: EmbeddedPowerPointSurface,
    request: { method: string; params?: Record<string, unknown> },
  ): Promise<unknown> {
    const contents = surface.view.webContents
    if (contents.isDestroyed()) throw new Error('PowerPoint renderer is unavailable')
    const response = await contents.executeJavaScript(
      `globalThis.__bridgicPowerPoint?.dispatch(${JSON.stringify(request)})`,
      true,
    ) as { ok?: unknown; value?: unknown; error?: unknown } | undefined
    if (!response) throw new Error('PowerPoint renderer domain API is unavailable')
    if (response.ok !== true) {
      throw new Error(typeof response.error === 'string' ? response.error : 'PowerPoint renderer request failed')
    }
    return response.value
  }

  private infoFor(surface: EmbeddedPowerPointSurface): EmbeddedPowerPointSessionInfo {
    return {
      sessionId: surface.sessionId,
      targetId: surface.targetId,
      webContentsId: surface.view.webContents.id,
      loading: surface.loading,
      crashed: surface.crashed,
    }
  }

  private normalizeSessionId(sessionId: string): string {
    const id = String(sessionId ?? '').trim()
    if (!id) throw new Error('sessionId is required')
    return id
  }

  private normalizeBounds(bounds: EmbeddedPowerPointBounds): Rectangle {
    const values = [bounds.x, bounds.y, bounds.width, bounds.height]
    if (values.some((value) => !Number.isFinite(value))) {
      throw new TypeError('PowerPoint bounds must be finite numbers')
    }
    return {
      x: Math.round(bounds.x),
      y: Math.round(bounds.y),
      width: Math.max(0, Math.round(bounds.width)),
      height: Math.max(0, Math.round(bounds.height)),
    }
  }

  private publishState(): void {
    this.container.publish()
  }
}
