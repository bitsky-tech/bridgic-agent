import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Rectangle,
  Session,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions,
  WebPreferences,
} from 'electron'
import type {
  EmbeddedBrowserBounds,
  EmbeddedBrowserSessionInfo,
  EmbeddedBrowserSnapshot,
  EmbeddedBrowserTabInfo,
  WorkbenchKind,
} from '../shared/types'
import { mt } from './i18n'
import { windowLog } from './logger'

const WEB_PREFERENCES: NonNullable<WebContentsViewConstructorOptions['webPreferences']> = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  // Agent actions must keep working while the native Browser surface is hidden
  // behind another dock tool. Electron otherwise throttles the page lifecycle.
  backgroundThrottling: false,
}

const DEFAULT_OPERATIONAL_BOUNDS: Rectangle = { x: 0, y: 0, width: 1280, height: 800 }
const HORIZONTAL_OVERFLOW_THRESHOLD_PX = 24
const OVERFLOW_INSPECTION_WORLD_ID = 1001
const OVERFLOW_INSPECTION_TIMEOUT_MS = 1_000
const HORIZONTAL_OVERFLOW_SCRIPT = `new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const root = document.documentElement
    const body = document.body
    const scrollingElement = document.scrollingElement
    const contentWidth = Math.max(
      scrollingElement?.scrollWidth ?? 0,
      root?.scrollWidth ?? 0,
      body?.scrollWidth ?? 0,
    )
    const viewportWidth = Math.max(root?.clientWidth ?? 0, window.innerWidth ?? 0)
    const viewportHeight = Math.max(root?.clientHeight ?? 0, window.innerHeight ?? 0)
    if (contentWidth - viewportWidth > ${HORIZONTAL_OVERFLOW_THRESHOLD_PX}) {
      resolve(true)
      return
    }

    const edgeCandidates = new Set()
    const collectEdgeCandidates = (x, y) => {
      for (const element of document.elementsFromPoint(x, y)) {
        let candidate = element
        for (let depth = 0; candidate && depth < 8; depth += 1) {
          edgeCandidates.add(candidate)
          candidate = candidate.parentElement
        }
      }
    }
    if (viewportWidth > 0 && viewportHeight > 0) {
      for (let y = 1; y < viewportHeight; y += 24) {
        collectEdgeCandidates(1, y)
        collectEdgeCandidates(Math.max(1, viewportWidth - 2), y)
      }
      collectEdgeCandidates(1, Math.max(1, viewportHeight - 2))
      collectEdgeCandidates(
        Math.max(1, viewportWidth - 2),
        Math.max(1, viewportHeight - 2),
      )
    }

    const clippedOverlay = [...edgeCandidates].some((element) => {
      if (element === root || element === body) return false
      const rect = element.getBoundingClientRect()
      const horizontalOverflow = Math.max(-rect.left, rect.right - viewportWidth)
      const visibleWidth = Math.min(rect.right, viewportWidth) - Math.max(rect.left, 0)
      const visibleHeight = Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)
      if (
        horizontalOverflow <= ${HORIZONTAL_OVERFLOW_THRESHOLD_PX}
        || rect.width < 80
        || rect.height < 40
        || visibleWidth < 40
        || visibleHeight < 32
      ) return false

      const style = window.getComputedStyle(element)
      if (
        style.display === 'none'
        || style.visibility === 'hidden'
        || Number.parseFloat(style.opacity || '1') <= 0.01
      ) return false

      let fixedAncestor = false
      let ancestor = element
      for (let depth = 0; ancestor && depth < 8; depth += 1) {
        if (window.getComputedStyle(ancestor).position === 'fixed') {
          fixedAncestor = true
          break
        }
        ancestor = ancestor.parentElement
      }
      const zIndex = Number.parseInt(style.zIndex, 10)
      const hasOverlaySemantics = element.matches('dialog, [role="dialog"], form')
        || element.querySelector('dialog, [role="dialog"], form') !== null
      return style.position === 'fixed'
        || fixedAncestor
        || (
          style.position === 'absolute'
          && (hasOverlaySemantics || (Number.isFinite(zIndex) && zIndex >= 10))
        )
    })
    resolve(clippedOverlay)
  }))
})`

interface EmbeddedBrowserTabRecord {
  tabId: string
  view: WebContentsView
  targetId: string | null
  title: string
  url: string
  loading: boolean
  faviconUrl: string | null
  crashed: boolean
  ready: Promise<void>
}

/**
 * One Session's workbench page (a spreadsheet or a document).
 *
 * A workbench is a native view like a browser tab, and for the same reason —
 * it must keep running for a Session the person is not currently looking at,
 * so the agent can work in it. It is deliberately *not* a tab: it has no
 * navigation, never appears in the tab strip, and owns its own dock position.
 */
interface WorkbenchRecord {
  kind: WorkbenchKind
  view: WebContentsView
  targetId: string | null
  ready: Promise<void>
}

interface EmbeddedBrowserSessionSurface {
  sessionId: string
  tabs: Map<string, EmbeddedBrowserTabRecord>
  activeTabId: string | null
  mruTabIds: string[]
  workbenches: Map<WorkbenchKind, WorkbenchRecord>
}

type ViewFactory = (options: WebContentsViewConstructorOptions) => WebContentsView
type SessionFactory = () => Session
type PopupWindowOptions = BrowserWindowConstructorOptions & { webContents?: WebContents }

/** Owns the Electron-native browser tabs embedded in the main App window. */
export class EmbeddedBrowserManager {
  private host: BrowserWindow | null = null
  private readonly surfaces = new Map<string, EmbeddedBrowserSessionSurface>()
  private activeSessionId: string | null = null
  /** Which of the active Session's surfaces the dock is presenting. */
  private activeKind: WorkbenchKind | 'browser' = 'browser'
  private bounds: Rectangle = { ...DEFAULT_OPERATIONAL_BOUNDS }
  private surfaceVisible = false
  private readonly configuredSessions = new WeakSet<Session>()
  private browserSession: Session | null = null

  constructor(
    private readonly createView: ViewFactory,
    private readonly createBrowserSession: SessionFactory,
    private readonly onStateChanged: (snapshot: EmbeddedBrowserSnapshot) => void = () => undefined,
  ) {}

  /** Return the recoverable renderer projection of every live Session surface. */
  snapshot(): EmbeddedBrowserSnapshot {
    return { sessions: [...this.surfaces.values()].map((surface) => this.infoFor(surface)) }
  }

  /** Attach the singleton App window that presents every embedded tab. */
  attachHost(host: BrowserWindow): void {
    if (this.host === host) return
    if (this.host) this.closeAll()
    this.host = host
  }

  /** Detach a closing App window and release all native browser surfaces. */
  detachHost(host: BrowserWindow): void {
    if (this.host !== host) return
    this.closeAll()
    this.host = null
  }

  /** Ensure one Session surface and at least one ready tab exist. */
  async ensureSession(sessionId: string): Promise<EmbeddedBrowserSessionInfo> {
    const surface = this.getOrCreateSurface(sessionId)
    let record = this.activeRecord(surface) ?? surface.tabs.values().next().value
    if (!record) record = this.createTabRecord(surface, 'about:blank', true, true)
    this.claimOperationalSessionIfIdle(surface)
    await record.ready
    return this.infoFor(surface)
  }

  /** Return a current Session inventory without resurrecting a released surface. */
  async sessionTabs(sessionId: string): Promise<EmbeddedBrowserSessionInfo> {
    const id = this.normalizeSessionId(sessionId)
    const surface = this.surfaces.get(id)
    if (!surface) return { sessionId: id, activeTabId: null, tabs: [], workbenches: [] }
    const active = this.activeRecord(surface)
    if (active) await active.ready
    return this.infoFor(surface)
  }

  /** Create a tab owned by one Agent Session and make it that Session's active tab. */
  async createTab(sessionId: string, url = 'about:blank'): Promise<EmbeddedBrowserTabInfo> {
    const normalizedUrl = this.normalizeNavigationUrl(url)
    const surface = this.getOrCreateSurface(sessionId)
    const record = this.createTabRecord(surface, normalizedUrl, true, true)
    this.claimOperationalSessionIfIdle(surface)
    await record.ready
    return this.tabInfo(record)
  }

  /** Select a renderer-facing tab without changing which Agent Session is visible. */
  activateTab(sessionId: string, tabId: string): EmbeddedBrowserSessionInfo {
    const surface = this.requireSurface(sessionId)
    const record = this.requireTab(surface, tabId)
    this.activateRecord(surface, record)
    this.publishState()
    return this.infoFor(surface)
  }

  /** Select a tab by its CDP target, the stable Python/Electron association key. */
  activateTarget(sessionId: string, targetId: string): EmbeddedBrowserSessionInfo {
    const surface = this.requireSurface(sessionId)
    const record = this.requireTarget(surface, targetId)
    this.activateRecord(surface, record)
    this.publishState()
    return this.infoFor(surface)
  }

  /** Close one renderer-facing tab and leave sibling tabs and Sessions intact. */
  closeTab(sessionId: string, tabId: string): Promise<EmbeddedBrowserSessionInfo> {
    const surface = this.requireSurface(sessionId)
    const record = this.requireTab(surface, tabId)
    return this.closeRecord(surface, record)
  }

  /** Close one tab by its CDP target for the Python controller. */
  closeTarget(sessionId: string, targetId: string): Promise<EmbeddedBrowserSessionInfo> {
    const surface = this.requireSurface(sessionId)
    const record = this.requireTarget(surface, targetId)
    return this.closeRecord(surface, record)
  }

  /** Close every tab owned by one Agent Session. */
  closeSession(sessionId: string): void {
    const id = this.normalizeSessionId(sessionId)
    const surface = this.surfaces.get(id)
    if (!surface) return
    this.surfaces.delete(id)
    if (this.activeSessionId === id) this.activeSessionId = null
    const records = [...surface.tabs.values()]
    const workbenches = [...surface.workbenches.values()]
    surface.tabs.clear()
    surface.activeTabId = null
    surface.mruTabIds.length = 0
    surface.workbenches.clear()
    if (this.activeSessionId === null) this.activeKind = 'browser'
    for (const record of records) this.disposeRecord(record)
    for (const workbench of workbenches) this.disposeWorkbench(workbench)
    this.publishState()
  }

  /** Select which Agent Session owns the presented or parked operational view. */
  activateSession(sessionId: string | null): void {
    if (sessionId === null) {
      this.activeSessionId = null
      this.syncVisibility()
      return
    }
    const surface = this.requireSurface(sessionId)
    if (!this.activeRecord(surface)) {
      throw new Error(`embedded browser Session has no active tab: ${surface.sessionId}`)
    }
    this.activeSessionId = surface.sessionId
    this.activeKind = 'browser'
    this.syncVisibility()
  }

  /** Navigate one tab through its native WebContents. */
  async navigateTab(sessionId: string, tabId: string, url: string): Promise<void> {
    const record = this.requireTab(this.requireSurface(sessionId), tabId)
    await record.ready
    await record.view.webContents.loadURL(this.normalizeNavigationUrl(url))
  }

  /** Navigate one tab backward when history permits it. */
  goBack(sessionId: string, tabId: string): void {
    const record = this.requireTab(this.requireSurface(sessionId), tabId)
    if (record.view.webContents.navigationHistory.canGoBack()) {
      record.view.webContents.navigationHistory.goBack()
    }
  }

  /** Navigate one tab forward when history permits it. */
  goForward(sessionId: string, tabId: string): void {
    const record = this.requireTab(this.requireSurface(sessionId), tabId)
    if (record.view.webContents.navigationHistory.canGoForward()) {
      record.view.webContents.navigationHistory.goForward()
    }
  }

  /** Reload one tab. */
  reload(sessionId: string, tabId: string): void {
    this.requireTab(this.requireSurface(sessionId), tabId).view.webContents.reload()
  }

  /** Inspect one page for meaningful horizontal overflow in its current viewport. */
  async hasHorizontalOverflow(sessionId: string, tabId: string): Promise<boolean> {
    const surface = this.requireSurface(sessionId)
    const record = this.requireTab(surface, tabId)
    if (
      this.activeSessionId !== surface.sessionId
      || !this.surfaceVisible
      || surface.activeTabId !== record.tabId
    ) return false
    await record.ready
    const webContents = record.view.webContents
    if (
      this.activeSessionId !== surface.sessionId
      || !this.surfaceVisible
      || surface.activeTabId !== record.tabId
      || webContents.isDestroyed()
      || webContents.isLoading()
    ) return false

    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      const result = await Promise.race([
        webContents.executeJavaScriptInIsolatedWorld(
          OVERFLOW_INSPECTION_WORLD_ID,
          [{ code: HORIZONTAL_OVERFLOW_SCRIPT }],
        ),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), OVERFLOW_INSPECTION_TIMEOUT_MS)
        }),
      ])
      return this.activeSessionId === surface.sessionId
        && this.surfaceVisible
        && surface.activeTabId === record.tabId
        && !webContents.isDestroyed()
        && result === true
    } finally {
      if (timeout !== undefined) clearTimeout(timeout)
    }
  }

  /** Apply the renderer's measured viewport bounds to every tab. */
  setBounds(bounds: EmbeddedBrowserBounds): void {
    const next = this.normalizeBounds(bounds)
    if (next.width === 0 || next.height === 0) return
    this.bounds = next
    this.syncVisibility()
  }

  /** Show or hide the active native tab without changing logical ownership. */
  setVisible(visible: boolean): void {
    if (typeof visible !== 'boolean') throw new TypeError('embedded browser visible must be a boolean')
    this.surfaceVisible = visible
    this.syncVisibility()
  }

  /**
   * Ensure one Session's workbench page exists and return its CDP target.
   *
   * Creating it does not present it: the agent may prepare a workbook for a
   * Session nobody is looking at, and doing so must not steal the dock from
   * whatever the person is reading.
   */
  async ensureWorkbench(sessionId: string, kind: WorkbenchKind, url: string): Promise<string> {
    const surface = this.getOrCreateSurface(sessionId)
    let record = surface.workbenches.get(kind)
    if (!record) record = this.createWorkbenchRecord(surface, kind, url)
    await record.ready
    if (!record.targetId) throw new Error(`workbench ${kind} has no target`)
    return record.targetId
  }

  /** The CDP target of one Session's workbench, or null when it has none open. */
  workbenchTarget(sessionId: string, kind: WorkbenchKind): string | null {
    const surface = this.surfaces.get(this.normalizeSessionId(sessionId))
    const record = surface?.workbenches.get(kind)
    if (!record || record.view.webContents.isDestroyed()) return null
    return record.targetId
  }

  /** Present one Session's workbench, or hand the dock back to its browser. */
  activateWorkbench(sessionId: string, kind: WorkbenchKind | null): void {
    const id = this.normalizeSessionId(sessionId)
    this.activeSessionId = id
    this.activeKind = kind ?? 'browser'
    this.syncVisibility()
  }

  /** Release one Session's workbench page and its native view. */
  closeWorkbench(sessionId: string, kind: WorkbenchKind): void {
    const surface = this.surfaces.get(this.normalizeSessionId(sessionId))
    const record = surface?.workbenches.get(kind)
    if (!surface || !record) return
    surface.workbenches.delete(kind)
    if (this.activeKind === kind) this.activeKind = 'browser'
    this.disposeWorkbench(record)
    this.syncVisibility()
    this.publishState()
  }

  /** Release every Session surface owned by the current App window. */
  closeAll(): void {
    const records = [...this.surfaces.values()].flatMap((surface) => [...surface.tabs.values()])
    const workbenches = [...this.surfaces.values()]
      .flatMap((surface) => [...surface.workbenches.values()])
    for (const surface of this.surfaces.values()) {
      surface.tabs.clear()
      surface.activeTabId = null
      surface.mruTabIds.length = 0
      surface.workbenches.clear()
    }
    this.surfaces.clear()
    this.activeSessionId = null
    this.activeKind = 'browser'
    this.surfaceVisible = false
    for (const record of records) this.disposeRecord(record)
    for (const workbench of workbenches) this.disposeWorkbench(workbench)
    this.publishState()
  }

  /** Release every tab and flush the shared profile before App shutdown. */
  async shutdown(): Promise<void> {
    this.closeAll()
    const browserSession = this.browserSession
    if (!browserSession) return
    let storageError: unknown = null
    try {
      browserSession.flushStorageData()
    } catch (error) {
      storageError = error
    }
    try {
      await browserSession.cookies.flushStore()
    } catch (cookieError) {
      if (storageError) {
        throw new AggregateError(
          [storageError, cookieError],
          'embedded browser storage and cookie flush failed',
        )
      }
      throw cookieError
    }
    if (storageError) throw storageError
  }

  private getOrCreateSurface(sessionId: string): EmbeddedBrowserSessionSurface {
    const id = this.normalizeSessionId(sessionId)
    const existing = this.surfaces.get(id)
    if (existing) return existing
    const surface: EmbeddedBrowserSessionSurface = {
      sessionId: id,
      tabs: new Map(),
      activeTabId: null,
      mruTabIds: [],
      workbenches: new Map(),
    }
    this.surfaces.set(id, surface)
    return surface
  }

  private createTabRecord(
    surface: EmbeddedBrowserSessionSurface,
    initialUrl: string,
    loadInitialUrl: boolean,
    activate: boolean,
    inheritedWebPreferences?: WebPreferences,
    adoptedWebContents?: WebContents,
  ): EmbeddedBrowserTabRecord {
    const host = this.host
    if (!host || host.isDestroyed()) throw new Error('main window is unavailable')

    const browserSession = this.getBrowserSession()
    const inherited = { ...inheritedWebPreferences }
    delete inherited.additionalArguments
    delete inherited.partition
    delete inherited.preload
    delete inherited.session
    const view = adoptedWebContents
      ? this.createView({ webContents: adoptedWebContents })
      : this.createView({
        webPreferences: {
          ...inherited,
          ...WEB_PREFERENCES,
          session: browserSession,
        },
      })
    const tabId = `tab-${view.webContents.id}`
    const record: EmbeddedBrowserTabRecord = {
      tabId,
      view,
      targetId: null,
      title: this.defaultTitle(initialUrl),
      url: initialUrl,
      loading: loadInitialUrl,
      faviconUrl: null,
      crashed: false,
      ready: Promise.resolve(),
    }
    surface.tabs.set(tabId, record)
    if (activate || surface.activeTabId === null) this.activateRecord(surface, record)

    this.configureView(surface, record)
    view.setBounds(this.bounds)
    view.setVisible(false)
    host.contentView.addChildView(view)
    view.webContents.once('destroyed', () => this.onDestroyed(surface, record))
    record.ready = this.initializeRecord(surface, record, loadInitialUrl ? initialUrl : null)
    void record.ready.catch((error) => {
      windowLog.warn(
        `[embedded-browser] tab creation failed session=${surface.sessionId} tab=${record.tabId}`,
        error,
      )
    })
    this.syncVisibility()
    this.publishState()
    return record
  }

  private createWorkbenchRecord(
    surface: EmbeddedBrowserSessionSurface,
    kind: WorkbenchKind,
    url: string,
  ): WorkbenchRecord {
    const host = this.host
    if (!host || host.isDestroyed()) throw new Error('main window is unavailable')

    const view = this.createView({
      webPreferences: { ...WEB_PREFERENCES, session: this.getBrowserSession() },
    })
    const record: WorkbenchRecord = { kind, view, targetId: null, ready: Promise.resolve() }
    surface.workbenches.set(kind, record)
    view.webContents.setBackgroundThrottling(false)
    view.setBounds(this.bounds)
    view.setVisible(false)
    host.contentView.addChildView(view)
    view.webContents.once('destroyed', () => {
      if (surface.workbenches.get(kind) === record) surface.workbenches.delete(kind)
      this.publishState()
    })
    record.ready = this.initializeWorkbench(surface, record, url)
    void record.ready.catch((error) => {
      windowLog.warn(
        `[embedded-browser] workbench creation failed session=${surface.sessionId} kind=${kind}`,
        error,
      )
    })
    this.syncVisibility()
    this.publishState()
    return record
  }

  private async initializeWorkbench(
    surface: EmbeddedBrowserSessionSurface,
    record: WorkbenchRecord,
    url: string,
  ): Promise<void> {
    try {
      await record.view.webContents.loadURL(url)
      record.targetId = await this.resolveTargetId(record.view)
      if (surface.workbenches.get(record.kind) !== record) {
        throw new Error(`workbench closed during creation: ${record.kind}`)
      }
      this.publishState()
    } catch (error) {
      if (surface.workbenches.get(record.kind) === record) {
        surface.workbenches.delete(record.kind)
        this.disposeWorkbench(record)
        this.publishState()
      }
      throw error
    }
  }

  private disposeWorkbench(record: WorkbenchRecord): void {
    const host = this.host
    if (host && !host.isDestroyed()) {
      try {
        host.contentView.removeChildView(record.view)
      } catch {
        // The view may already have been detached by a closing window.
      }
    }
    if (!record.view.webContents.isDestroyed()) record.view.webContents.close()
  }

  private async initializeRecord(
    surface: EmbeddedBrowserSessionSurface,
    record: EmbeddedBrowserTabRecord,
    initialUrl: string | null,
  ): Promise<void> {
    try {
      if (initialUrl !== null) await record.view.webContents.loadURL(initialUrl)
      else await Promise.resolve()
      record.targetId = await this.resolveTargetId(record.view)
      this.refreshRecord(record)
      if (surface.tabs.get(record.tabId) !== record || record.view.webContents.isDestroyed()) {
        throw new Error(`embedded browser tab closed during creation: ${record.tabId}`)
      }
      this.publishState()
    } catch (error) {
      if (surface.tabs.get(record.tabId) === record) {
        this.removeRecord(surface, record, true)
        this.publishState()
      }
      throw error
    }
  }

  private configureView(surface: EmbeddedBrowserSessionSurface, record: EmbeddedBrowserTabRecord): void {
    const contents = record.view.webContents
    // Also cover adopted popup WebContents, whose preferences were fixed before
    // the WebContentsView wrapper was created.
    contents.setBackgroundThrottling(false)
    const browserSession = contents.session
    if (!this.configuredSessions.has(browserSession)) {
      browserSession.setPermissionCheckHandler(() => false)
      browserSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
      this.configuredSessions.add(browserSession)
    }

    contents.setWindowOpenHandler((details) => {
      if (!this.navigationAllowed(details.url)) return { action: 'deny' }
      const browserSession = this.getBrowserSession()
      return {
        action: 'allow',
        outlivesOpener: true,
        overrideBrowserWindowOptions: {
          webPreferences: { ...WEB_PREFERENCES, session: browserSession },
        },
        createWindow: (options) => {
          const activeSurface = this.surfaces.get(surface.sessionId)
          if (activeSurface !== surface) {
            throw new Error(`embedded browser Session was closed: ${surface.sessionId}`)
          }
          const activate = details.disposition !== 'background-tab'
          const popupOptions = options as PopupWindowOptions
          const adoptedWebContents = popupOptions.webContents
          return this.createTabRecord(
            surface,
            details.url,
            adoptedWebContents === undefined,
            activate,
            options.webPreferences,
            adoptedWebContents,
          ).view.webContents
        },
      }
    })
    contents.on('will-navigate', (event, url) => {
      if (!this.navigationAllowed(url)) event.preventDefault()
    })
    contents.on('did-start-loading', () => {
      record.loading = true
      record.crashed = false
      this.publishIfLive(surface, record)
    })
    contents.on('did-stop-loading', () => {
      record.loading = false
      this.refreshRecord(record)
      this.publishIfLive(surface, record)
    })
    contents.on('did-navigate', (_event, url) => {
      record.url = url
      this.refreshRecord(record)
      this.publishIfLive(surface, record)
    })
    contents.on('did-navigate-in-page', (_event, url) => {
      record.url = url
      this.refreshRecord(record)
      this.publishIfLive(surface, record)
    })
    contents.on('page-title-updated', (_event, title) => {
      record.title = title || this.defaultTitle(record.url)
      this.publishIfLive(surface, record)
    })
    contents.on('page-favicon-updated', (_event, favicons) => {
      record.faviconUrl = favicons[0] ?? null
      this.publishIfLive(surface, record)
    })
    contents.on('render-process-gone', (_event, details) => {
      record.loading = false
      record.crashed = details.reason !== 'clean-exit'
      this.publishIfLive(surface, record)
    })
  }

  private async closeRecord(
    surface: EmbeddedBrowserSessionSurface,
    record: EmbeddedBrowserTabRecord,
  ): Promise<EmbeddedBrowserSessionInfo> {
    const destroyed = this.waitForDestroyed(record)
    this.removeRecord(surface, record, true)
    await destroyed
    const active = this.activeRecord(surface)
    if (active) await active.ready
    const info = this.infoFor(surface)
    if (surface.tabs.size === 0) this.surfaces.delete(surface.sessionId)
    this.publishState()
    return info
  }

  private removeRecord(
    surface: EmbeddedBrowserSessionSurface,
    record: EmbeddedBrowserTabRecord,
    dispose: boolean,
  ): void {
    if (surface.tabs.get(record.tabId) !== record) return
    surface.tabs.delete(record.tabId)
    surface.mruTabIds = surface.mruTabIds.filter((tabId) => tabId !== record.tabId)
    if (surface.activeTabId === record.tabId) {
      surface.activeTabId = this.selectFallbackTabId(surface)
    }
    if (dispose) this.disposeRecord(record)
    if (surface.tabs.size === 0) {
      this.surfaces.delete(surface.sessionId)
      if (this.activeSessionId === surface.sessionId) this.activeSessionId = null
    }
    this.syncVisibility()
  }

  private selectFallbackTabId(surface: EmbeddedBrowserSessionSurface): string | null {
    for (let index = surface.mruTabIds.length - 1; index >= 0; index -= 1) {
      const tabId = surface.mruTabIds[index]
      if (tabId && surface.tabs.has(tabId)) return tabId
    }
    return surface.tabs.keys().next().value ?? null
  }

  private activateRecord(
    surface: EmbeddedBrowserSessionSurface,
    record: EmbeddedBrowserTabRecord,
  ): void {
    surface.activeTabId = record.tabId
    surface.mruTabIds = surface.mruTabIds.filter((tabId) => tabId !== record.tabId)
    surface.mruTabIds.push(record.tabId)
    this.syncVisibility()
  }

  private activeRecord(surface: EmbeddedBrowserSessionSurface): EmbeddedBrowserTabRecord | null {
    if (!surface.activeTabId) return null
    return surface.tabs.get(surface.activeTabId) ?? null
  }

  private claimOperationalSessionIfIdle(surface: EmbeddedBrowserSessionSurface): void {
    if (this.activeSessionId !== null) return
    this.activeSessionId = surface.sessionId
    this.syncVisibility()
  }

  private onDestroyed(
    surface: EmbeddedBrowserSessionSurface,
    record: EmbeddedBrowserTabRecord,
  ): void {
    if (surface.tabs.get(record.tabId) !== record) return
    this.removeRecord(surface, record, false)
    this.publishState()
    const host = this.host
    if (host && !host.isDestroyed()) host.contentView.removeChildView(record.view)
  }

  private disposeRecord(record: EmbeddedBrowserTabRecord): void {
    record.view.setVisible(false)
    const host = this.host
    if (host && !host.isDestroyed()) host.contentView.removeChildView(record.view)
    if (!record.view.webContents.isDestroyed()) {
      record.view.webContents.close({ waitForBeforeUnload: false })
    }
  }

  private waitForDestroyed(record: EmbeddedBrowserTabRecord): Promise<void> {
    const contents = record.view.webContents
    if (contents.isDestroyed()) return Promise.resolve()
    return new Promise((resolve) => contents.once('destroyed', resolve))
  }

  private refreshRecord(record: EmbeddedBrowserTabRecord): void {
    const contents = record.view.webContents
    if (contents.isDestroyed()) return
    record.url = contents.getURL() || record.url
    record.title = contents.getTitle() || this.defaultTitle(record.url)
    record.loading = contents.isLoading()
  }

  private tabInfo(record: EmbeddedBrowserTabRecord): EmbeddedBrowserTabInfo {
    const contents = record.view.webContents
    const history = contents.navigationHistory
    return {
      tabId: record.tabId,
      targetId: record.targetId,
      webContentsId: contents.id,
      title: record.title,
      url: record.url,
      loading: record.loading,
      canGoBack: !contents.isDestroyed() && history.canGoBack(),
      canGoForward: !contents.isDestroyed() && history.canGoForward(),
      faviconUrl: record.faviconUrl,
      crashed: record.crashed,
    }
  }

  private infoFor(surface: EmbeddedBrowserSessionSurface): EmbeddedBrowserSessionInfo {
    return {
      sessionId: surface.sessionId,
      activeTabId: surface.activeTabId,
      tabs: [...surface.tabs.values()]
        .filter((record) => !record.view.webContents.isDestroyed())
        .map((record) => this.tabInfo(record)),
      workbenches: [...surface.workbenches.values()]
        .filter((record) => !record.view.webContents.isDestroyed())
        .map((record) => record.kind),
    }
  }

  private publishIfLive(
    surface: EmbeddedBrowserSessionSurface,
    record: EmbeddedBrowserTabRecord,
  ): void {
    if (surface.tabs.get(record.tabId) === record) this.publishState()
  }

  private publishState(): void {
    this.onStateChanged(this.snapshot())
  }

  private syncVisibility(): void {
    let operationalView: WebContentsView | null = null
    if (this.activeSessionId !== null) {
      const activeSurface = this.surfaces.get(this.activeSessionId)
      if (activeSurface) {
        operationalView = this.activeKind === 'browser'
          ? this.activeRecord(activeSurface)?.view ?? null
          : activeSurface.workbenches.get(this.activeKind)?.view ?? null
      }
    }

    // Hide every inactive native view before moving or revealing the active one.
    // This keeps tab/Session/workbench switches from briefly stacking two
    // WebContentsViews.
    for (const surface of this.surfaces.values()) {
      const views = [
        ...[...surface.tabs.values()].map((record) => record.view),
        ...[...surface.workbenches.values()].map((record) => record.view),
      ]
      for (const view of views) {
        if (view.webContents.isDestroyed()) continue
        if (view !== operationalView) {
          view.setVisible(false)
          view.setBounds(this.bounds)
        }
      }
    }

    if (!operationalView || operationalView.webContents.isDestroyed()) return

    // A never-presented WebContentsView does not establish the compositor state
    // Playwright needs for actionability checks. Keep the current page drawn while
    // the dock is hidden, but park all except one pixel outside the host so it is
    // visually absent without becoming an out-of-view NativeViewHost.
    operationalView.setBounds(
      this.surfaceVisible ? this.bounds : this.parkedOperationalBounds(),
    )
    operationalView.setVisible(true)
  }

  private parkedOperationalBounds(): Rectangle {
    return {
      x: 1 - this.bounds.width,
      y: 1 - this.bounds.height,
      width: this.bounds.width,
      height: this.bounds.height,
    }
  }

  private getBrowserSession(): Session {
    this.browserSession ??= this.createBrowserSession()
    return this.browserSession
  }

  private requireSurface(sessionId: string): EmbeddedBrowserSessionSurface {
    const id = this.normalizeSessionId(sessionId)
    const surface = this.surfaces.get(id)
    if (!surface) throw new Error(`embedded browser Session does not exist: ${id}`)
    return surface
  }

  private requireTab(
    surface: EmbeddedBrowserSessionSurface,
    tabId: string,
  ): EmbeddedBrowserTabRecord {
    const id = this.normalizeTabId(tabId)
    const record = surface.tabs.get(id)
    if (!record || record.view.webContents.isDestroyed()) {
      throw new Error(`embedded browser tab does not exist: ${id}`)
    }
    return record
  }

  private requireTarget(
    surface: EmbeddedBrowserSessionSurface,
    targetId: string,
  ): EmbeddedBrowserTabRecord {
    const id = this.normalizeTargetId(targetId)
    for (const record of surface.tabs.values()) {
      if (record.targetId === id && !record.view.webContents.isDestroyed()) return record
    }
    throw new Error(`embedded browser target does not belong to Session ${surface.sessionId}: ${id}`)
  }

  private async resolveTargetId(view: WebContentsView): Promise<string> {
    const contents = view.webContents
    const debug = contents.debugger
    const attachedHere = !debug.isAttached()
    if (attachedHere) debug.attach('1.3')
    try {
      const response = await debug.sendCommand('Target.getTargetInfo') as {
        targetInfo?: { targetId?: unknown }
      }
      const targetId = response.targetInfo?.targetId
      if (typeof targetId !== 'string' || targetId.length === 0) {
        throw new Error('Electron did not return a DevTools target id')
      }
      return targetId
    } finally {
      if (attachedHere && debug.isAttached()) debug.detach()
    }
  }

  private navigationAllowed(url: string): boolean {
    try {
      const protocol = new URL(url).protocol
      return protocol === 'http:' || protocol === 'https:' || url === 'about:blank'
    } catch {
      return false
    }
  }

  private normalizeNavigationUrl(url: string): string {
    const normalized = String(url ?? '').trim() || 'about:blank'
    if (!this.navigationAllowed(normalized)) {
      throw new Error('embedded browser navigation requires an http or https URL')
    }
    return normalized
  }

  private defaultTitle(url: string): string {
    if (url === 'about:blank') return mt('main.browser.newTab')
    try {
      return new URL(url).hostname || url
    } catch {
      return url
    }
  }

  private normalizeSessionId(sessionId: string): string {
    if (typeof sessionId !== 'string') throw new TypeError('embedded browser session id must be a string')
    const id = sessionId.trim()
    if (id.length === 0 || id.length > 256) throw new Error('embedded browser session id is invalid')
    return id
  }

  private normalizeTabId(tabId: string): string {
    if (typeof tabId !== 'string') throw new TypeError('embedded browser tab id must be a string')
    const id = tabId.trim()
    if (id.length === 0 || id.length > 256) throw new Error('embedded browser tab id is invalid')
    return id
  }

  private normalizeTargetId(targetId: string): string {
    if (typeof targetId !== 'string') throw new TypeError('embedded browser target id must be a string')
    const id = targetId.trim()
    if (id.length === 0 || id.length > 256) throw new Error('embedded browser target id is invalid')
    return id
  }

  private normalizeBounds(bounds: EmbeddedBrowserBounds): Rectangle {
    if (!bounds || typeof bounds !== 'object') throw new TypeError('embedded browser bounds are required')
    const values = [bounds.x, bounds.y, bounds.width, bounds.height]
    if (!values.every(Number.isFinite)) throw new Error('embedded browser bounds must be finite')
    if (bounds.x < 0 || bounds.y < 0 || bounds.width < 0 || bounds.height < 0) {
      throw new Error('embedded browser bounds must be non-negative')
    }
    const x = Math.floor(bounds.x)
    const y = Math.floor(bounds.y)
    const right = bounds.width === 0 ? x : Math.ceil(bounds.x + bounds.width)
    const bottom = bounds.height === 0 ? y : Math.ceil(bounds.y + bounds.height)
    return { x, y, width: right - x, height: bottom - y }
  }
}
