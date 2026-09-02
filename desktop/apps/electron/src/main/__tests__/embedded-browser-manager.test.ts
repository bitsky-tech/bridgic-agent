import { describe, expect, it } from 'bun:test'
import { runInNewContext } from 'node:vm'
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  HandlerDetails,
  Rectangle,
  Session,
  WebContents,
  WebContentsView,
  WebContentsViewConstructorOptions,
  WindowOpenHandlerResponse,
} from 'electron'
import { EmbeddedBrowserManager } from '../embedded-browser-manager'
import { mt } from '../i18n'

class FakeDebugger {
  attached = false
  private nextError: Error | null = null

  constructor(private readonly targetId: string) {}

  attach(): void {
    this.attached = true
  }

  detach(): void {
    this.attached = false
  }

  isAttached(): boolean {
    return this.attached
  }

  failNext(error: Error): void {
    this.nextError = error
  }

  async sendCommand(method: string): Promise<unknown> {
    if (method !== 'Target.getTargetInfo') throw new Error(`unexpected command: ${method}`)
    const error = this.nextError
    this.nextError = null
    if (error) throw error
    return { targetInfo: { targetId: this.targetId } }
  }
}

class FakeWebContents {
  readonly debugger: FakeDebugger
  readonly session: Session
  readonly navigationHistory = {
    canGoBack: () => this.historyIndex > 0,
    canGoForward: () => this.historyIndex < this.history.length - 1,
    goBack: () => this.navigateHistory(-1),
    goForward: () => this.navigateHistory(1),
  }
  private destroyed = false
  private loading = false
  private url = ''
  private title = ''
  private history: string[] = []
  private historyIndex = -1
  private readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  windowOpenHandler: ((details: HandlerDetails) => WindowOpenHandlerResponse) | null = null
  backgroundThrottling = true
  horizontalOverflow = false
  readonly executedScripts: string[] = []
  readonly isolatedWorldIds: number[] = []

  constructor(readonly id: number, browserSession: Session) {
    this.session = browserSession
    this.debugger = new FakeDebugger(`target-${id}`)
  }

  isDestroyed(): boolean {
    return this.destroyed
  }

  isLoading(): boolean {
    return this.loading
  }

  getURL(): string {
    return this.url
  }

  getTitle(): string {
    return this.title
  }

  once(event: string, listener: (...args: unknown[]) => void): void {
    const once = (...args: unknown[]) => {
      this.off(event, once)
      listener(...args)
    }
    this.on(event, once)
  }

  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.listeners.get(event) ?? []
    listeners.push(listener)
    this.listeners.set(event, listeners)
  }

  off(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener))
  }

  setWindowOpenHandler(handler: (details: HandlerDetails) => WindowOpenHandlerResponse): void {
    this.windowOpenHandler = handler
  }

  setBackgroundThrottling(allowed: boolean): void {
    this.backgroundThrottling = allowed
  }

  async executeJavaScript(script: string): Promise<boolean> {
    this.executedScripts.push(script)
    return this.horizontalOverflow
  }

  async executeJavaScriptInIsolatedWorld(
    worldId: number,
    scripts: Array<{ code: string }>,
  ): Promise<boolean> {
    this.isolatedWorldIds.push(worldId)
    this.executedScripts.push(...scripts.map((script) => script.code))
    return this.horizontalOverflow
  }

  async loadURL(url: string): Promise<void> {
    this.loading = true
    this.emit('did-start-loading')
    this.url = url
    this.title = url === 'about:blank' ? '' : new URL(url).hostname
    this.history.splice(this.historyIndex + 1)
    this.history.push(url)
    this.historyIndex = this.history.length - 1
    this.emit('did-navigate', {}, url)
    this.emit('page-title-updated', {}, this.title)
    this.loading = false
    this.emit('did-stop-loading')
  }

  reload(): void {
    this.emit('did-start-loading')
    this.emit('did-stop-loading')
  }

  close(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.emit('destroyed')
  }

  private navigateHistory(offset: number): void {
    const next = this.historyIndex + offset
    if (next < 0 || next >= this.history.length) return
    this.historyIndex = next
    this.url = this.history[next] ?? this.url
    this.emit('did-navigate', {}, this.url)
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args)
  }
}

class FakeView {
  readonly webContents: FakeWebContents
  bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  visible = false

  constructor(id: number, browserSession: Session, webContents?: FakeWebContents) {
    this.webContents = webContents ?? new FakeWebContents(id, browserSession)
  }

  setBounds(bounds: Rectangle): void {
    this.bounds = { ...bounds }
  }

  setVisible(visible: boolean): void {
    this.visible = visible
  }
}

class FakeHost {
  destroyed = false
  readonly children = new Set<FakeView>()
  readonly contentView = {
    addChildView: (view: WebContentsView) => this.children.add(view as unknown as FakeView),
    removeChildView: (view: WebContentsView) => this.children.delete(view as unknown as FakeView),
  }

  isDestroyed(): boolean {
    return this.destroyed
  }
}

function setup() {
  const views: FakeView[] = []
  const options: WebContentsViewConstructorOptions[] = []
  const snapshots: ReturnType<EmbeddedBrowserManager['snapshot']>[] = []
  let sessionFactoryCalls = 0
  let storageFlushCalls = 0
  let cookieFlushCalls = 0
  let nextTargetResolutionError: Error | null = null
  const browserSession = {
    setPermissionCheckHandler: (_handler: () => boolean) => undefined,
    setPermissionRequestHandler: (
      _handler: (_contents: unknown, _permission: unknown, callback: (allowed: boolean) => void) => void,
    ) => undefined,
    flushStorageData: () => { storageFlushCalls += 1 },
    cookies: { flushStore: async () => { cookieFlushCalls += 1 } },
  } as unknown as Session
  const manager = new EmbeddedBrowserManager((next) => {
    options.push(next)
    const adoptedWebContents = next.webContents as unknown as FakeWebContents | undefined
    const view = new FakeView(
      views.length + 1,
      next.webPreferences?.session ?? browserSession,
      adoptedWebContents,
    )
    if (nextTargetResolutionError) {
      view.webContents.debugger.failNext(nextTargetResolutionError)
      nextTargetResolutionError = null
    }
    views.push(view)
    return view as unknown as WebContentsView
  }, () => {
    sessionFactoryCalls += 1
    return browserSession
  }, (snapshot) => snapshots.push(snapshot))
  const host = new FakeHost()
  manager.attachHost(host as unknown as BrowserWindow)
  return {
    browserSession,
    flushCalls: () => ({ cookies: cookieFlushCalls, storage: storageFlushCalls }),
    manager,
    host,
    options,
    failNextTargetResolution: (error: Error) => { nextTargetResolutionError = error },
    sessionFactoryCalls: () => sessionFactoryCalls,
    snapshots,
    views,
  }
}

function popupDetails(url: string, disposition: HandlerDetails['disposition'] = 'foreground-tab') {
  return {
    url,
    frameName: '',
    features: '',
    disposition,
    referrer: { url: '', policy: 'default' },
  } as HandlerDetails
}

interface OverflowFixtureElement {
  parentElement: OverflowFixtureElement | null
  scrollWidth: number
  style: {
    display: string
    visibility: string
    opacity: string
    position: string
    zIndex: string
  }
  getBoundingClientRect(): {
    left: number
    right: number
    top: number
    bottom: number
    width: number
    height: number
  }
  matches(selector: string): boolean
  querySelector(selector: string): OverflowFixtureElement | null
}

function overflowFixtureElement({
  parentElement = null,
  position = 'static',
  rect = { left: 0, right: 800, top: 0, bottom: 600, width: 800, height: 600 },
}: {
  parentElement?: OverflowFixtureElement | null
  position?: string
  rect?: ReturnType<OverflowFixtureElement['getBoundingClientRect']>
} = {}): OverflowFixtureElement {
  return {
    parentElement,
    scrollWidth: 800,
    style: {
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      position,
      zIndex: 'auto',
    },
    getBoundingClientRect: () => rect,
    matches: () => false,
    querySelector: () => null,
  }
}

async function evaluateOverflowScript(
  script: string,
  buildEdgeElements: (body: OverflowFixtureElement) => OverflowFixtureElement[] = () => [],
): Promise<boolean> {
  const body = overflowFixtureElement()
  const root = { clientWidth: 800, clientHeight: 600, scrollWidth: 800 }
  const edgeElements = buildEdgeElements(body)
  return runInNewContext(script, {
    document: {
      body,
      documentElement: root,
      scrollingElement: root,
      elementsFromPoint: () => edgeElements,
    },
    requestAnimationFrame: (callback: () => void) => {
      callback()
      return 1
    },
    window: {
      innerHeight: 600,
      innerWidth: 800,
      getComputedStyle: (element: OverflowFixtureElement) => element.style,
    },
  }) as Promise<boolean>
}

describe('EmbeddedBrowserManager', () => {
  it('idempotently ensures one initial tab on the shared path-backed Session', async () => {
    const { browserSession, manager, host, options, sessionFactoryCalls, views } = setup()

    const first = await manager.ensureSession('session-a')
    const second = await manager.ensureSession('session-a')

    expect(second).toEqual(first)
    expect(first.sessionId).toBe('session-a')
    expect(first.activeTabId).toBe('tab-1')
    expect(first.tabs[0]).toMatchObject({
      tabId: 'tab-1',
      targetId: 'target-1',
      webContentsId: 1,
      // Assert through the catalog rather than a literal: the tab title is now
      // translated, so a hardcoded string would pin this test to one language.
      title: mt('main.browser.newTab'),
      url: 'about:blank',
      loading: false,
    })
    expect(views).toHaveLength(1)
    expect(host.children.size).toBe(1)
    expect(options[0]?.webPreferences?.session).toBe(browserSession)
    expect(options[0]?.webPreferences?.partition).toBeUndefined()
    expect(sessionFactoryCalls()).toBe(1)
    expect(options[0]?.webPreferences?.nodeIntegration).toBe(false)
    expect(options[0]?.webPreferences?.sandbox).toBe(true)
    expect(options[0]?.webPreferences?.backgroundThrottling).toBe(false)
    expect(views[0]?.webContents.backgroundThrottling).toBe(false)
  })

  it('gives hidden tabs a non-zero operational viewport before renderer measurement', async () => {
    const { manager, views } = setup()

    await manager.ensureSession('session-a')

    expect(views[0]?.bounds).toEqual({ x: -1279, y: -799, width: 1280, height: 800 })
    expect(views[0]?.visible).toBe(true)
  })

  it('keeps the hidden active target drawn in a parked operational viewport', async () => {
    const { manager, views } = setup()
    await manager.ensureSession('session-a')
    const second = await manager.createTab('session-a', 'https://example.com/second')
    const viewport = { x: 420, y: 96, width: 640, height: 600 }

    manager.setBounds(viewport)
    manager.activateSession('session-a')

    expect(views.map((view) => view.visible)).toEqual([false, true])
    expect(views[1]?.bounds).toEqual({ x: -639, y: -599, width: 640, height: 600 })

    manager.activateTarget('session-a', 'target-1')
    expect(views.map((view) => view.visible)).toEqual([true, false])
    expect(views[0]?.bounds).toEqual({ x: -639, y: -599, width: 640, height: 600 })

    manager.setVisible(true)
    expect(views[0]?.visible).toBe(true)
    expect(views[0]?.bounds).toEqual(viewport)

    manager.setVisible(false)
    expect(views[0]?.visible).toBe(true)
    expect(views[0]?.bounds).toEqual({ x: -639, y: -599, width: 640, height: 600 })

    manager.activateSession(null)
    expect(views.map((view) => view.visible)).toEqual([false, false])
    expect(second.targetId).toBe('target-2')
  })

  it('keeps the last non-zero viewport when the renderer reports zero area', async () => {
    const { manager, views } = setup()
    manager.setBounds({ x: 400, y: 80, width: 0, height: 0 })
    await manager.ensureSession('session-a')
    expect(views[0]?.bounds).toEqual({ x: -1279, y: -799, width: 1280, height: 800 })

    const valid = { x: 420, y: 96, width: 640, height: 600 }
    manager.setBounds(valid)
    manager.setBounds({ x: 500, y: 100, width: 0, height: 600 })
    manager.setBounds({ x: 500, y: 100, width: 640, height: 0 })
    await manager.createTab('session-a', 'https://example.com/second')

    expect(views.map((view) => view.bounds)).toEqual([
      valid,
      { x: -639, y: -599, width: 640, height: 600 },
    ])
  })

  it('keeps independent active tabs per Session and presents exactly one native view', async () => {
    const { manager, views } = setup()
    await manager.ensureSession('session-a')
    const secondA = await manager.createTab('session-a', 'https://example.com/a')
    await manager.ensureSession('session-b')

    // A controller request for another Session must not steal the current
    // operational owner or expose that Session's hidden native view.
    expect(views.map((view) => view.visible)).toEqual([false, true, false])

    manager.setBounds({ x: 11.4, y: 22.6, width: 700.2, height: 499.8 })
    manager.setVisible(true)
    manager.activateSession('session-a')

    expect(views.map((view) => view.bounds)).toEqual([
      { x: 11, y: 22, width: 701, height: 501 },
      { x: 11, y: 22, width: 701, height: 501 },
      { x: 11, y: 22, width: 701, height: 501 },
    ])
    expect(views.map((view) => view.visible)).toEqual([false, true, false])

    manager.activateTab('session-a', 'tab-1')
    expect(views.map((view) => view.visible)).toEqual([true, false, false])
    manager.activateTarget('session-a', secondA.targetId ?? '')
    expect(views.map((view) => view.visible)).toEqual([false, true, false])

    manager.activateSession('session-b')
    expect(views.map((view) => view.visible)).toEqual([false, false, true])
  })

  it('keeps the active native view visible while its viewport is resized', async () => {
    const { manager, views } = setup()
    await manager.ensureSession('session-a')
    manager.activateSession('session-a')
    manager.setVisible(true)

    manager.setBounds({ x: 800, y: 120, width: 720, height: 640 })
    manager.setBounds({ x: 760, y: 120, width: 760, height: 640 })
    manager.setBounds({ x: 700, y: 120, width: 820, height: 640 })

    expect(views[0]?.bounds).toEqual({ x: 700, y: 120, width: 820, height: 640 })
    expect(views[0]?.visible).toBe(true)
  })

  it('creates, activates, and closes tabs by both app id and CDP target id', async () => {
    const { manager, views } = setup()
    await manager.ensureSession('session-a')
    const second = await manager.createTab('session-a', 'https://example.com/second')
    const third = await manager.createTab('session-a', 'https://example.com/third')

    expect(manager.snapshot().sessions[0]?.tabs).toHaveLength(3)
    expect(manager.snapshot().sessions[0]?.activeTabId).toBe(third.tabId)

    await manager.closeTarget('session-a', third.targetId ?? '')
    expect(views[2]?.webContents.isDestroyed()).toBe(true)
    expect(manager.snapshot().sessions[0]?.activeTabId).toBe(second.tabId)

    await manager.closeTab('session-a', second.tabId)
    expect(manager.snapshot().sessions[0]?.activeTabId).toBe('tab-1')
    await manager.closeTab('session-a', 'tab-1')
    expect(manager.snapshot().sessions).toEqual([])
  })

  it('publishes the fallback state when asynchronous tab initialization fails', async () => {
    const { failNextTargetResolution, manager, snapshots, views } = setup()
    await manager.ensureSession('session-a')
    failNextTargetResolution(new Error('target resolution failed'))

    await expect(manager.createTab('session-a', 'https://example.com/broken')).rejects.toThrow(
      'target resolution failed',
    )

    expect(views[1]?.webContents.isDestroyed()).toBe(true)
    expect(snapshots.some((snapshot) => snapshot.sessions[0]?.tabs.length === 2)).toBe(true)
    expect(snapshots.at(-1)?.sessions[0]).toMatchObject({
      activeTabId: 'tab-1',
      tabs: [{ tabId: 'tab-1' }],
      workbenches: [],
    })
  })

  it('turns target=_blank into a same-Session WebContentsView and preserves popup semantics', async () => {
    const { browserSession, manager, options, views } = setup()
    await manager.ensureSession('session-a')
    const handler = views[0]?.webContents.windowOpenHandler
    expect(handler).not.toBeNull()

    const response = handler?.(popupDetails('https://example.com/popup'))
    expect(response?.action).toBe('allow')
    expect(response?.outlivesOpener).toBe(true)
    expect(response?.overrideBrowserWindowOptions?.webPreferences).toMatchObject({
      nodeIntegration: false,
      sandbox: true,
      session: browserSession,
    })
    const popupContents = new FakeWebContents(2, browserSession)
    const child = response?.createWindow?.({
      webContents: popupContents as unknown as WebContents,
      webPreferences: {
        additionalArguments: ['--untrusted-popup-argument'],
        nodeIntegration: true,
        partition: 'persist:untrusted-popup',
        preload: '/tmp/untrusted-popup-preload.js',
        sandbox: false,
        session: {} as Session,
        spellcheck: false,
      },
    } as BrowserWindowConstructorOptions & { webContents: WebContents })
    expect(child).toBe(popupContents as unknown as WebContents)
    expect(views[1]?.webContents).toBe(popupContents)
    expect(popupContents.backgroundThrottling).toBe(false)
    expect(options[1]?.webContents).toBe(popupContents as unknown as WebContents)
    expect(options[1]?.webPreferences).toBeUndefined()
    await popupContents.loadURL('https://example.com/popup')
    await manager.sessionTabs('session-a')

    const surface = manager.snapshot().sessions[0]
    expect(surface?.tabs).toHaveLength(2)
    expect(surface?.activeTabId).toBe('tab-2')
    expect(surface?.tabs[1]).toMatchObject({
      targetId: 'target-2',
      url: 'https://example.com/popup',
    })

    expect(handler?.(popupDetails('file:///etc/passwd'))).toEqual({ action: 'deny' })
  })

  it('keeps background popups hidden and blocks unsafe top-level navigation', async () => {
    const { manager, views } = setup()
    await manager.ensureSession('session-a')
    const handler = views[0]?.webContents.windowOpenHandler
    const response = handler?.(popupDetails('https://example.com/background', 'background-tab'))
    response?.createWindow?.({} as BrowserWindowConstructorOptions)
    await manager.sessionTabs('session-a')

    expect(manager.snapshot().sessions[0]?.activeTabId).toBe('tab-1')
    expect(manager.snapshot().sessions[0]?.tabs[1]?.url).toBe('https://example.com/background')
  })

  it('projects navigation history for the renderer browser controls', async () => {
    const { manager } = setup()
    await manager.ensureSession('session-a')

    await manager.navigateTab('session-a', 'tab-1', 'https://example.com/one')
    await manager.navigateTab('session-a', 'tab-1', 'https://example.com/two')
    expect(manager.snapshot().sessions[0]?.tabs[0]).toMatchObject({
      url: 'https://example.com/two',
      canGoBack: true,
      canGoForward: false,
    })

    manager.goBack('session-a', 'tab-1')
    expect(manager.snapshot().sessions[0]?.tabs[0]).toMatchObject({
      url: 'https://example.com/one',
      canGoForward: true,
    })
    manager.goForward('session-a', 'tab-1')
    manager.reload('session-a', 'tab-1')
  })

  it('reports meaningful horizontal overflow for the requested live page', async () => {
    const { manager, views } = setup()
    await manager.ensureSession('session-a')
    manager.setVisible(true)
    views[0]!.webContents.horizontalOverflow = true

    expect(await manager.hasHorizontalOverflow('session-a', 'tab-1')).toBe(true)
    expect(views[0]?.webContents.executedScripts).toHaveLength(1)
    expect(views[0]?.webContents.executedScripts[0]).toContain('scrollWidth')
    expect(views[0]?.webContents.isolatedWorldIds).toEqual([1001])
    const script = views[0]!.webContents.executedScripts[0]!
    expect(await evaluateOverflowScript(script)).toBe(false)
    expect(await evaluateOverflowScript(script, (body) => {
      const fixedOverlay = overflowFixtureElement({ parentElement: body, position: 'fixed' })
      const clippedPanel = overflowFixtureElement({
        parentElement: fixedOverlay,
        position: 'absolute',
        rect: {
          left: 620,
          right: 980,
          top: 180,
          bottom: 520,
          width: 360,
          height: 340,
        },
      })
      return [clippedPanel]
    })).toBe(true)

    views[0]!.webContents.horizontalOverflow = false
    expect(await manager.hasHorizontalOverflow('session-a', 'tab-1')).toBe(false)

    const executedCount = views[0]!.webContents.executedScripts.length
    await manager.ensureSession('session-b')
    manager.activateSession('session-b')
    expect(await manager.hasHorizontalOverflow('session-a', 'tab-1')).toBe(false)
    expect(views[0]!.webContents.executedScripts).toHaveLength(executedCount)

    manager.activateSession('session-a')
    manager.setVisible(false)
    expect(await manager.hasHorizontalOverflow('session-a', 'tab-1')).toBe(false)
    expect(views[0]!.webContents.executedScripts).toHaveLength(executedCount)
  })

  it('closes only the requested Session and flushes the shared profile at shutdown', async () => {
    const { flushCalls, host, manager, views } = setup()
    await manager.ensureSession('session-a')
    await manager.createTab('session-a')
    await manager.ensureSession('session-b')

    manager.closeSession('session-a')
    expect(views[0]?.webContents.isDestroyed()).toBe(true)
    expect(views[1]?.webContents.isDestroyed()).toBe(true)
    expect(views[2]?.webContents.isDestroyed()).toBe(false)
    expect(host.children.size).toBe(1)
    expect(await manager.sessionTabs('session-a')).toEqual({
      sessionId: 'session-a',
      activeTabId: null,
      tabs: [],
      workbenches: [],
    })
    expect(views).toHaveLength(3)

    await manager.shutdown()
    expect(views[2]?.webContents.isDestroyed()).toBe(true)
    expect(host.children.size).toBe(0)
    expect(flushCalls()).toEqual({ cookies: 1, storage: 1 })
  })

  it('rejects invalid Session, tab, target, navigation, and viewport input', async () => {
    const { manager } = setup()

    await expect(manager.ensureSession('   ')).rejects.toThrow('session id is invalid')
    await manager.ensureSession('session-a')
    expect(() => manager.activateTab('session-a', 'missing')).toThrow('tab does not exist')
    expect(() => manager.activateTarget('session-a', 'missing')).toThrow('does not belong')
    await expect(manager.createTab('session-a', 'file:///etc/passwd')).rejects.toThrow(
      'requires an http or https URL',
    )
    expect(() => manager.setBounds({ x: 0, y: 0, width: -1, height: 100 })).toThrow(
      'bounds must be non-negative',
    )
  })
})
