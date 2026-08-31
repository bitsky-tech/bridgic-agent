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

const DEFAULT_OPERATIONAL_BOUNDS: Rectangle = { x: 0, y: 0, width: 1280, height: 800 }
const MAX_OPEN_PRESENTATION_BYTES = 250 * 1024 * 1024

interface EmbeddedPowerPointSurface {
  sessionId: string
  view: WebContentsView
  targetId: string | null
  loading: boolean
  crashed: boolean
  ready: Promise<void>
  openingFilesByPath: Map<string, Promise<EmbeddedPowerPointOpenFileResult>>
}

type ViewFactory = (options: WebContentsViewConstructorOptions) => WebContentsView
type ViewLoader = (view: WebContentsView, sessionId: string) => Promise<void>

/** Owns one PowerPoint renderer/CDP target for every Agent Session. */
export class EmbeddedPowerPointManager {
  private host: BrowserWindow | null = null
  private readonly surfaces = new Map<string, EmbeddedPowerPointSurface>()
  private activeSessionId: string | null = null
  private bounds: Rectangle = { ...DEFAULT_OPERATIONAL_BOUNDS }
  private surfaceVisible = false

  constructor(
    private readonly createView: ViewFactory,
    private readonly loadView: ViewLoader,
    private readonly onStateChanged: (snapshot: EmbeddedPowerPointSnapshot) => void = () => undefined,
  ) {}

  snapshot(): EmbeddedPowerPointSnapshot {
    return { sessions: [...this.surfaces.values()].map((surface) => this.infoFor(surface)) }
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

  async ensureSession(sessionId: string): Promise<EmbeddedPowerPointSessionInfo> {
    const id = this.normalizeSessionId(sessionId)
    let surface = this.surfaces.get(id)
    if (surface && (surface.crashed || surface.view.webContents.isDestroyed())) {
      this.surfaces.delete(id)
      this.disposeSurface(surface)
      surface = undefined
    }
    if (!surface) surface = this.createSurface(id)
    await surface.ready
    return this.infoFor(surface)
  }

  sessionInfo(sessionId: string): EmbeddedPowerPointSessionInfo | null {
    const surface = this.surfaces.get(this.normalizeSessionId(sessionId))
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
    const surface = this.surfaces.get(id)
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
    if (sessionId === null) {
      if (this.activeSessionId === null) return
      this.activeSessionId = null
      this.syncVisibility()
      return
    }
    const id = this.normalizeSessionId(sessionId)
    if (!this.surfaces.has(id)) throw new Error(`PowerPoint Session is unavailable: ${id}`)
    if (this.activeSessionId === id) return
    this.activeSessionId = id
    this.syncVisibility()
  }

  closeSession(sessionId: string): void {
    const id = this.normalizeSessionId(sessionId)
    const surface = this.surfaces.get(id)
    if (!surface) return
    this.surfaces.delete(id)
    if (this.activeSessionId === id) this.activeSessionId = null
    this.disposeSurface(surface)
    this.publishState()
  }

  setBounds(bounds: EmbeddedPowerPointBounds): void {
    const next = this.normalizeBounds(bounds)
    if (next.width === 0 || next.height === 0) return
    if (sameRectangle(this.bounds, next)) return
    this.bounds = next
    this.syncVisibility()
  }

  setVisible(visible: boolean): void {
    if (typeof visible !== 'boolean') throw new TypeError('PowerPoint visible must be a boolean')
    if (this.surfaceVisible === visible) return
    this.surfaceVisible = visible
    this.syncVisibility()
  }

  closeAll(): void {
    const surfaces = [...this.surfaces.values()]
    this.surfaces.clear()
    this.activeSessionId = null
    this.surfaceVisible = false
    for (const surface of surfaces) this.disposeSurface(surface)
    this.publishState()
  }

  /** Keep dedicated PPT renderers aligned with the main App theme, locale, and zoom. */
  applySettings(settings: GuiSettings): void {
    const zoomLevel = clampZoomLevel(settings.zoomLevel)
    for (const surface of this.surfaces.values()) {
      const contents = surface.view.webContents
      if (contents.isDestroyed()) continue
      contents.setZoomLevel(zoomLevel)
      contents.send(IPC.events.settingsChanged, settings)
    }
  }

  private createSurface(sessionId: string): EmbeddedPowerPointSurface {
    const host = this.host
    if (!host || host.isDestroyed()) throw new Error('main window is unavailable')
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
    this.surfaces.set(sessionId, surface)
    view.setBounds(this.bounds)
    view.setVisible(false)
    host.contentView.addChildView(view)
    view.webContents.setBackgroundThrottling(false)
    view.webContents.on('did-start-loading', () => {
      surface.loading = true
      this.publishState()
    })
    view.webContents.on('did-stop-loading', () => {
      surface.loading = false
      this.publishState()
    })
    view.webContents.on('render-process-gone', () => {
      surface.crashed = true
      this.publishState()
    })
    view.webContents.once('destroyed', () => {
      if (this.surfaces.get(sessionId) !== surface) return
      this.surfaces.delete(sessionId)
      if (this.activeSessionId === sessionId) this.activeSessionId = null
      this.publishState()
    })
    surface.ready = this.initializeSurface(surface)
    void surface.ready.catch((error) => {
      windowLog.warn(`[embedded-powerpoint] creation failed session=${sessionId}`, error)
    })
    this.publishState()
    return surface
  }

  private async initializeSurface(surface: EmbeddedPowerPointSurface): Promise<void> {
    try {
      await this.loadView(surface.view, surface.sessionId)
      surface.targetId = await this.resolveTargetId(surface.view)
      surface.loading = surface.view.webContents.isLoading()
      if (
        this.surfaces.get(surface.sessionId) !== surface
        || surface.view.webContents.isDestroyed()
      ) throw new Error(`PowerPoint Session closed during creation: ${surface.sessionId}`)
      this.publishState()
    } catch (error) {
      if (this.surfaces.get(surface.sessionId) === surface) {
        this.surfaces.delete(surface.sessionId)
        this.disposeSurface(surface)
        this.publishState()
      }
      throw error
    }
  }

  private async resolveTargetId(view: WebContentsView): Promise<string> {
    const contents = view.webContents
    const attachedHere = !contents.debugger.isAttached()
    if (attachedHere) contents.debugger.attach('1.3')
    try {
      const result = await contents.debugger.sendCommand('Target.getTargetInfo') as {
        targetInfo?: { targetId?: unknown }
      }
      const targetId = result.targetInfo?.targetId
      if (typeof targetId !== 'string' || !targetId) {
        throw new Error('PowerPoint renderer returned no CDP target id')
      }
      return targetId
    } finally {
      if (attachedHere && contents.debugger.isAttached()) contents.debugger.detach()
    }
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

  private syncVisibility(): void {
    const host = this.host
    for (const surface of this.surfaces.values()) {
      const visible = Boolean(
        host
        && !host.isDestroyed()
        && this.surfaceVisible
        && this.activeSessionId === surface.sessionId,
      )
      if (visible) surface.view.setBounds(this.bounds)
      surface.view.setVisible(visible)
    }
  }

  private disposeSurface(surface: EmbeddedPowerPointSurface): void {
    const host = this.host
    if (host && !host.isDestroyed()) {
      try {
        host.contentView.removeChildView(surface.view)
      } catch {
        // The view may already have been removed with its native host.
      }
    }
    if (!surface.view.webContents.isDestroyed()) surface.view.webContents.close()
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
    this.syncVisibility()
    this.onStateChanged(this.snapshot())
  }
}

function sameRectangle(left: Rectangle, right: Rectangle): boolean {
  return left.x === right.x && left.y === right.y
    && left.width === right.width && left.height === right.height
}
