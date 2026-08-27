import type {
  BrowserWindow,
  Rectangle,
  WebContentsView,
  WebContentsViewConstructorOptions,
} from 'electron'
import type {
  EmbeddedPowerPointBounds,
  EmbeddedPowerPointSessionInfo,
  EmbeddedPowerPointSnapshot,
} from '../shared/types'
import { clampZoomLevel, type GuiSettings } from '@app/shared/types'
import { IPC } from '../shared/ipc-channels'
import { windowLog } from './logger'

const DEFAULT_OPERATIONAL_BOUNDS: Rectangle = { x: 0, y: 0, width: 1280, height: 800 }

interface EmbeddedPowerPointSurface {
  sessionId: string
  view: WebContentsView
  targetId: string | null
  loading: boolean
  crashed: boolean
  ready: Promise<void>
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

  activateSession(sessionId: string | null): void {
    if (sessionId === null) {
      this.activeSessionId = null
      this.syncVisibility()
      return
    }
    const id = this.normalizeSessionId(sessionId)
    if (!this.surfaces.has(id)) throw new Error(`PowerPoint Session is unavailable: ${id}`)
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
    this.bounds = next
    this.syncVisibility()
  }

  setVisible(visible: boolean): void {
    if (typeof visible !== 'boolean') throw new TypeError('PowerPoint visible must be a boolean')
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
