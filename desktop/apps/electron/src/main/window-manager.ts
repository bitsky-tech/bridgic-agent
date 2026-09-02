import {
  BrowserWindow,
  WebContentsView,
  app,
  dialog,
  nativeTheme,
  screen,
  session,
  shell,
  type Session,
} from 'electron'
import { mkdirSync } from 'node:fs'
import { release } from 'node:os'
import { join } from 'node:path'
import { clampZoomLevel, type WindowBounds } from '@app/shared/types'
import { IPC } from '../shared/ipc-channels'
import { WindowCloseSource, type WindowCloseRequest } from '../shared/types'
import { getGuiSettings, stepZoomLevel, updateWindowState } from './gui-settings'
import { parseExternalUrl, redactExternalUrlForLog } from './handlers/external-url'
import { windowLog } from './logger'
import { mt } from './i18n'
import { titleBarOverlayFor } from './titlebar-overlay'
import { pickStartupBounds } from './window-bounds'
import { pickZoomDelta } from './zoom-keys'
import { EmbeddedBrowserManager } from './embedded-browser-manager'
import { ExcelHost } from './excel-host'
import { embeddedBrowserProfileDir } from './paths'
import { isNativeWindowForeground, MainWindowVisibilityLatch } from './window-visibility'

const DEFAULT_BOUNDS: WindowBounds = { x: 100, y: 100, width: 1280, height: 800 }

export interface CreateMainWindowOptions {
  /** Whether this creation should present the window once Chromium is ready. */
  showWhenReady?: boolean
}

/**
 * Background-material fallback chain on Windows:
 *   build 22000+ (Windows 11) → Mica
 *   build 17763+ (Windows 10 1809+) → Acrylic
 *   older versions → undefined (no background material)
 *
 * Returns non-undefined only when process.platform === 'win32'.
 */
function getWindowsBackgroundMaterial(): 'mica' | 'acrylic' | undefined {
  if (process.platform !== 'win32') return undefined
  const buildNumber = parseInt(release().split('.')[2] || '0', 10)
  if (buildNumber >= 22000) {
    windowLog.info(`[window] Windows 11 (build ${buildNumber}) → Mica`)
    return 'mica'
  }
  if (buildNumber >= 17763) {
    windowLog.info(`[window] Windows 10 1809+ (build ${buildNumber}) → Acrylic`)
    return 'acrylic'
  }
  windowLog.info(`[window] older Windows (build ${buildNumber}) → no transparency`)
  return undefined
}

export class WindowManager {
  private mainWindow: BrowserWindow | null = null
  private readonly embeddedBrowser: EmbeddedBrowserManager
  private readonly excelHost: ExcelHost
  private readonly preloadPath: string
  private readonly devServerUrl: string | undefined
  private readonly rendererIndexHtml: string
  /** Strings passed to BrowserWindow.webPreferences.additionalArguments;
   *  Phase 3 uses it to inject `--initial-settings=<base64>` so the
   *  renderer's first frame already has the right theme. */
  private readonly additionalArguments: string[]
  /** Override for the BrowserWindow background color. Phase 3 derives
   *  this from GuiSettings.theme.mode so the OS-painted first frame is
   *  already in the user's chosen color scheme. */
  private readonly backgroundColorOverride: string | undefined
  /** Lifecycle observer attached before the window can first be shown. */
  private readonly onMainWindowCreated: ((window: BrowserWindow) => void) | undefined

  // Phase 3 — close intercept state
  private pendingCloseTimeout: NodeJS.Timeout | null = null
  private keyboardCloseIntent = false
  private keyboardCloseIntentTimeout: NodeJS.Timeout | null = null
  private isAppQuitting = false

  private openExternal(url: string, source: string): void {
    let parsed: URL
    try {
      parsed = parseExternalUrl(url)
    } catch {
      windowLog.warn(`[window] refused external URL source=${source} url=${redactExternalUrlForLog(url)}`)
      return
    }
    void shell.openExternal(parsed.toString()).catch(() => {
      windowLog.warn(`[window] openExternal failed source=${source} url=${redactExternalUrlForLog(parsed.toString())}`)
    })
  }
  // M1 — hide-to-tray toggle. False preserves the original
  // close-intercept-via-renderer flow (modals dismissed first, then
  // window destroyed). True hides the window instead of destroying
  // when the user closes — tray must be active so the user can get
  // back in. Set from main/index.ts after tray init.
  private hideOnClose = false
  /** In-flight main-window creation — see the guard note in createMainWindow. */
  private creatingMain: Promise<BrowserWindow> | null = null
  private readonly visibility = new MainWindowVisibilityLatch()

  constructor(opts: {
    preloadPath: string
    excelPreloadPath: string
    devServerUrl?: string
    rendererIndexHtml: string
    excelRendererHtml: string
    additionalArguments?: string[]
    backgroundColorOverride?: string
    onMainWindowCreated?: (window: BrowserWindow) => void
  }) {
    this.preloadPath = opts.preloadPath
    this.devServerUrl = opts.devServerUrl
    this.rendererIndexHtml = opts.rendererIndexHtml
    this.additionalArguments = opts.additionalArguments ?? []
    this.backgroundColorOverride = opts.backgroundColorOverride
    this.onMainWindowCreated = opts.onMainWindowCreated
    this.embeddedBrowser = new EmbeddedBrowserManager(
      (options) => new WebContentsView(options),
      () => this.createEmbeddedBrowserSession(),
      (snapshot) => {
        const win = this.mainWindow
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.events.embeddedBrowserChanged, snapshot)
        }
      },
    )
    this.excelHost = new ExcelHost(
      (options) => new WebContentsView(options),
      opts.excelPreloadPath,
      opts.devServerUrl,
      opts.excelRendererHtml,
      (snapshot) => {
        const win = this.mainWindow
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC.events.excelHostChanged, snapshot)
        }
      },
      async (count) => {
        const window = this.mainWindow
        const options = {
          type: 'warning' as const,
          buttons: [mt('main.excelQuit.cancel'), mt('main.excelQuit.discard')],
          defaultId: 0,
          cancelId: 0,
          title: mt('main.excelQuit.title'),
          message: mt('main.excelQuit.message', { count }),
          detail: mt('main.excelQuit.detail'),
        }
        const result = window && !window.isDestroyed()
          ? await dialog.showMessageBox(window, options)
          : await dialog.showMessageBox(options)
        return result.response === 1
      },
      (url) => this.openExternal(url, 'excel'),
    )
  }

  getMainWindow(): BrowserWindow | null {
    return this.mainWindow
  }

  getEmbeddedBrowser(): EmbeddedBrowserManager {
    return this.embeddedBrowser
  }

  getExcelHost(): ExcelHost {
    return this.excelHost
  }

  private createEmbeddedBrowserSession(): Session {
    if (!app.isReady()) throw new Error('embedded browser session requires Electron app readiness')
    const profileDir = embeddedBrowserProfileDir()
    mkdirSync(profileDir, { recursive: true })
    const browserSession = session.fromPath(profileDir, { cache: true })
    windowLog.info(`[embedded-browser] profile=${profileDir}`)
    return browserSession
  }

  /**
   * Construct and publish the native BrowserWindow before returning. The
   * returned promise tracks renderer navigation only, so the session-end event
   * target and tray can exist without waiting on React.
   */
  createMainWindow(options: CreateMainWindowOptions = {}): Promise<BrowserWindow> {
    const showWhenReady = options.showWhenReady ?? true
    const revealNow = showWhenReady ? this.visibility.requestForeground() : false

    // A foreground request that arrives while the first page is loading must
    // upgrade that in-flight hidden creation rather than create another window.
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      if (revealNow) this.revealMainWindow(this.mainWindow)
      if (!this.creatingMain) return Promise.resolve(this.mainWindow)
    }
    if (this.creatingMain) return this.creatingMain
    // Preserve an early deep-link/second-instance request when the login
    // launch originally asked for a hidden window.
    this.visibility.beginCreation(showWhenReady)
    this.creatingMain = this.doCreateMainWindow(showWhenReady).finally(() => {
      this.creatingMain = null
    })
    return this.creatingMain
  }

  /** Actual creation body — only reached through createMainWindow's in-flight
   *  guard; never call directly. */
  private async doCreateMainWindow(autoOpenDevTools: boolean): Promise<BrowserWindow> {
    // Window bounds + maximized live inside GuiSettings now
    // (previously a sidecar window-state.json file). See gui-settings.ts.
    const savedWindow = getGuiSettings().window
    // Correct the persisted bounds against the current displays: after
    // swapping/unplugging a monitor those bounds land off-screen or overflow
    // the current screen, and handing them straight to BrowserWindow makes the
    // OS clamp them to fill it → isMaximized() misreads → we persist
    // maximized:true → next launch maximize() fills the screen, an endless
    // loop. Pre-correcting eliminates it at the root (see window-bounds.ts).
    // adjusted=true means the bounds were stale, so drop maximized — the user
    // never actually maximized.
    const { bounds, adjusted } = pickStartupBounds(
      savedWindow.bounds,
      screen.getAllDisplays().map((d) => d.workArea),
      DEFAULT_BOUNDS,
    )
    const startMaximized = savedWindow.maximized && !adjusted

    const isMac = process.platform === 'darwin'
    const isWindows = process.platform === 'win32'
    const windowsBgMaterial = getWindowsBackgroundMaterial()

    // Dev-only Win/Linux task-bar icon. macOS taskbar is the dock; we
    // handle it via `app.dock.setIcon()` in main/index.ts and ignore
    // BrowserWindow.icon here. In packaged builds, electron-builder
    // already wires the platform-native icon into the launcher binary,
    // so the running window inherits it.
    const devTaskbarIcon = !isMac && !app.isPackaged
      ? join(app.getAppPath(), 'resources', 'icon.png')
      : undefined

    // Initial colors for the Windows Control Overlay (undefined off win32).
    // Later theme changes are pushed to live windows by applyTitleBarOverlay
    // in titlebar-overlay.ts.
    const winTitleBarOverlay = titleBarOverlayFor(getGuiSettings())

    const win = new BrowserWindow({
      ...bounds,
      minWidth: 640,
      minHeight: 480,
      ...(devTaskbarIcon && { icon: devTaskbarIcon }),
      backgroundColor:
        this.backgroundColorOverride ??
        // Must match --bg-app in tokens.css character for character: this is
        // the window's native base color, and it shows through before the
        // renderer paints and while dragging to resize. Any mismatch shows up
        // as a strip of a different color flashing along the edge.
        (nativeTheme.shouldUseDarkColors ? '#242422' : '#ffffff'),
      ...(isMac && {
        titleBarStyle: 'hiddenInset' as const,
        // y=15 vertically centers the traffic lights in the 44px-tall TopBar
        // (bar center=22, button diameter 14 → top y = 22 - 7 = 15). The
        // TopBar replaced the earlier 28px pure spacer (where y=7) and now
        // carries the collapse button + session title.
        trafficLightPosition: { x: 18, y: 15 },
        // No vibrancy: the UI uses a solid opaque background (--bg-app), so
        // vibrancy is completely covered and invisible in normal use — pure
        // overhead; and on blur it turns inactive along with the window,
        // washing the whole window out to a lighter shade (very jarring).
        // Without it the window stays a solid dark base, and the native
        // traffic lights still turn into gray dots on blur (native behavior,
        // unrelated to vibrancy).
      }),
      ...(isWindows && {
        autoHideMenuBar: true,
        // Keep only one layer at the top: hide the native title bar so the
        // system paints minimize/maximize/close directly into the right end of
        // our 44px TopBar (Windows Control Overlay). Without these two lines
        // the native title bar (~32px) stacked on top of the TopBar, wasting a
        // strip of blank space at the top.
        // We use the overlay rather than fully self-drawn buttons: Win11's
        // Snap Layouts split-screen menu on maximize-hover and high-contrast
        // mode support both come from the system, and self-drawing loses them.
        titleBarStyle: 'hidden' as const,
        ...(winTitleBarOverlay && { titleBarOverlay: winTitleBarOverlay }),
        ...(windowsBgMaterial && { backgroundMaterial: windowsBgMaterial }),
      }),
      ...(!isMac && !isWindows && {
        autoHideMenuBar: true,
      }),
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // All of the following are Electron 39's secure defaults, spelled out
        // explicitly to guard against an accidental regression if someone
        // copies this config later; preserve the Electron security baseline here.
        // Under sandbox the preload can still read --initial-settings= from
        // additionalArguments via the polyfilled process.argv (see
        // preload/bootstrap.ts).
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        nodeIntegrationInWorker: false,
        nodeIntegrationInSubFrames: false,
        additionalArguments: this.additionalArguments,
      },
      show: false,
    })
    // Publish the native host immediately. BrowserWindow creation is the
    // synchronous point at which the Windows session-end guard attaches, and
    // foreground requests arriving during load must target this same window.
    this.mainWindow = win
    this.embeddedBrowser.attachHost(win)
    this.excelHost.attachHost(win)
    try {
      this.onMainWindowCreated?.(win)
    } catch (error) {
      windowLog.warn('[window] main-window lifecycle observer failed', error)
    }

    let lastForeground: boolean | null = null
    const publishForeground = () => {
      if (win.webContents.isDestroyed()) return
      const foreground = isNativeWindowForeground(win)
      if (foreground === lastForeground) return
      lastForeground = foreground
      win.webContents.send(IPC.events.windowForegroundChanged, foreground)
    }
    win.on('focus', publishForeground)
    win.on('blur', publishForeground)
    win.on('show', publishForeground)
    win.on('hide', publishForeground)
    win.on('minimize', publishForeground)
    win.on('restore', publishForeground)

    // Restore the user's UI zoom. It must be set here once per window:
    // applyZoomLevel can only act on windows that **already exist**, and this
    // one was just created — omitting this line shows up as "I set a zoom
    // level, but after a restart it's back to 100%", recoverable only by
    // pressing the shortcut once more.
    win.webContents.setZoomLevel(clampZoomLevel(getGuiSettings().zoomLevel))

    win.once('ready-to-show', () => {
      if (!this.visibility.markReady(this.isAppQuitting) || win.isDestroyed()) return
      win.show()
      if (startMaximized) win.maximize()
      win.focus()
    })

    // macOS retracts its traffic-light buttons in native full screen. Tell the
    // renderer immediately so the top-left sidebar toggle can reclaim their
    // reserved inset; restore it when the native controls return.
    win.on('enter-full-screen', () => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(IPC.events.windowFullScreenChanged, true)
      }
    })
    win.on('leave-full-screen', () => {
      if (!win.webContents.isDestroyed()) {
        win.webContents.send(IPC.events.windowFullScreenChanged, false)
      }
    })

    // Cmd/Ctrl chords: supplementary zoom key bindings + Cmd/Ctrl+W
    // close-intent tracking (500ms TTL, used to tell a keyboard-shortcut close
    // from a window-button close).
    win.webContents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const isCmdOrCtrl = process.platform === 'darwin' ? !!input.meta : !!input.control
      if (!isCmdOrCtrl) return

      // **Supplementary** key bindings for zoom. The menu only registers
      // CmdOrCtrl+Plus / +- / +0 (see main/index.ts): `+` requires Shift on
      // most keyboards, so what users actually press is `=` without Shift; the
      // numeric keypad's +/- are also common. These can't be covered by hidden
      // menu items — acceleratorWorksWhenHidden is macOS-only. They're
      // mutually exclusive with the menu bindings, so nothing fires twice.
      const zoomDelta = pickZoomDelta(input.key, input.code, input.shift)
      if (zoomDelta !== null) {
        event.preventDefault()
        stepZoomLevel(zoomDelta)
        return
      }

      // Phase 3 — Cmd/Ctrl+W intent tracking (500ms TTL)
      if (input.key?.toLowerCase() !== 'w') return
      this.keyboardCloseIntent = true
      if (this.keyboardCloseIntentTimeout) clearTimeout(this.keyboardCloseIntentTimeout)
      this.keyboardCloseIntentTimeout = setTimeout(() => {
        this.keyboardCloseIntent = false
        this.keyboardCloseIntentTimeout = null
      }, 500)
    })

    // External links open in the user's default browser, not a new BrowserWindow.
    win.webContents.setWindowOpenHandler(({ url }) => {
      this.openExternal(url, 'new-window')
      return { action: 'deny' }
    })

    // Safety net: intercept in-page navigation. The app's own pages
    // (dev=devServerUrl, prod=file://) are allowed through (HMR reload /
    // anchors); every other http(s) external link is handed to the system
    // browser, preventing the whole webContents from being navigated away and
    // the app replaced by a web page — clicking an <a> inside markdown is by
    // default exactly this kind of in-page navigation and does not go through
    // the setWindowOpenHandler above.
    win.webContents.on('will-navigate', (event, targetUrl) => {
      const isExternalHttp =
        /^https?:\/\//i.test(targetUrl) &&
        (this.devServerUrl ? !targetUrl.startsWith(this.devServerUrl) : true)
      if (!isExternalHttp) return
      event.preventDefault()
      this.openExternal(targetUrl, 'will-navigate')
    })

    win.on('close', (event) => {
      // Persist window state into the GuiSettings blob. If maximized,
      // we deliberately keep the pre-maximize bounds so un-maximize
      // restores the user's preferred size.
      const isMax = win.isMaximized()
      const b = isMax ? bounds : win.getBounds()
      updateWindowState(b, isMax)

      // Cmd+Q (before-quit already set isAppQuitting=true) takes the native close path, no layering
      if (this.isAppQuitting) return
      // Unreachable renderer also takes the native path (avoids an IPC deadlock)
      if (win.webContents.isDestroyed() || !win.webContents.mainFrame) return

      // M1 hide-to-tray: when enabled (tray is active), the close
      // button hides the window instead of destroying it. Bypasses
      // the modal-dismiss flow on purpose — if a modal is open it
      // simply persists and the user sees it again when reopening
      // the window. The tray menu's "Quit Completely" sets isAppQuitting then
      // calls app.quit(), so a real quit still works.
      if (this.hideOnClose) {
        event.preventDefault()
        // Reset the Cmd/Ctrl+W intent here too (mirrors the window-button branch
        // below): a keyboard-triggered hide otherwise leaves the flag set until
        // its 500ms TTL, which could misread the close source if the window is
        // re-shown and closed again within that window.
        this.keyboardCloseIntent = false
        if (this.keyboardCloseIntentTimeout) {
          clearTimeout(this.keyboardCloseIntentTimeout)
          this.keyboardCloseIntentTimeout = null
        }
        win.hide()
        return
      }

      // Intercept the close so the renderer gets to dismiss a modal/overlay first
      event.preventDefault()
      const source: WindowCloseSource = this.keyboardCloseIntent
        ? WindowCloseSource.KeyboardShortcut
        : WindowCloseSource.WindowButton
      this.keyboardCloseIntent = false
      if (this.keyboardCloseIntentTimeout) {
        clearTimeout(this.keyboardCloseIntentTimeout)
        this.keyboardCloseIntentTimeout = null
      }

      win.webContents.send(IPC.events.windowCloseRequested, { source } satisfies WindowCloseRequest)

      // 3-second force-close fallback: if IPC deadlocks or the renderer has died, the window won't get stuck in a "fake close"
      this.clearPendingCloseTimeout()
      this.pendingCloseTimeout = setTimeout(() => {
        this.pendingCloseTimeout = null
        if (!win.isDestroyed()) win.destroy()
      }, 3000)
    })

    win.on('closed', () => {
      // Close-intercept timers tracked at instance level; clean up if either is
      // still pending when the window is destroyed via a non-`close`-listener
      // path (e.g., confirmClose() or the 3s fallback firing).
      if (this.keyboardCloseIntentTimeout) {
        clearTimeout(this.keyboardCloseIntentTimeout)
        this.keyboardCloseIntentTimeout = null
      }
      this.clearPendingCloseTimeout()
      this.embeddedBrowser.detachHost(win)
      this.excelHost.detachHost(win)
      if (this.mainWindow === win) {
        this.mainWindow = null
        this.visibility.reset()
      }
    })

    try {
      if (this.devServerUrl) {
        await this.loadDevUrlWithRetry(win, this.devServerUrl)
      } else {
        await win.loadFile(this.rendererIndexHtml)
      }
    } catch (error) {
      // A failed navigation may never emit ready-to-show. Mark the native host
      // revealable so a tray click (or the tray-init fail-open path) cannot
      // leave the process permanently invisible.
      const shouldReveal = this.visibility.markReady(this.isAppQuitting)
      if (shouldReveal && !win.isDestroyed()) this.revealMainWindow(win)
      throw error
    }

    // Open DevTools automatically only for an explicit foreground dev launch.
    // Override with --no-open-devtools (electron CLI flag) if needed.
    if (
      this.devServerUrl &&
      autoOpenDevTools &&
      !app.commandLine.hasSwitch('no-open-devtools')
    ) {
      win.webContents.openDevTools({ mode: 'detach' })
    }

    windowLog.info('[window] main window created')
    return win
  }

  private revealMainWindow(win: BrowserWindow): void {
    const wasVisible = win.isVisible()
    if (win.isMinimized()) win.restore()
    // Hidden from tray-close: un-hide before focusing or focus is a no-op.
    if (!win.isVisible()) win.show()
    win.focus()
    windowLog.info(`[window] main window revealed (wasVisible=${wasVisible})`)
  }

  /**
   * Last-resort presentation when native tray construction fails. Unlike the
   * normal foreground path this deliberately reveals before ready-to-show, so
   * even a renderer load failure cannot strand an invisible process.
   */
  failOpenMainWindow(): void {
    if (this.isAppQuitting) return
    this.visibility.requestForeground()
    if (!app.isReady()) return

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.revealMainWindow(this.mainWindow)
      return
    }
    void this.createMainWindow({ showWhenReady: true }).catch((error) => {
      windowLog.error('[window] fail-open window creation failed', error)
    })
  }

  focusOrCreateMain(): void {
    if (this.isAppQuitting) return

    // This also records foreground intent before app readiness. Cold deep links
    // and very early second-instance events therefore cannot call screen /
    // BrowserWindow too soon, yet still reveal the initial window once ready.
    const win = this.mainWindow && !this.mainWindow.isDestroyed() ? this.mainWindow : null
    const revealNow = this.visibility.requestForeground(win !== null)
    const appReady = app.isReady()
    windowLog.info(
      `[window] foreground requested (appReady=${appReady}, nativeWindow=${win !== null}, creating=${this.creatingMain !== null})`,
    )
    if (!appReady) return

    if (win) {
      if (revealNow) this.revealMainWindow(win)
      return
    }
    if (this.creatingMain) {
      // The native window may have been destroyed while its renderer-load
      // promise was still settling. Retry the foreground request after either
      // outcome instead of letting that stale promise swallow user intent.
      void this.creatingMain.then(
        () => {
          if (!this.isAppQuitting) this.focusOrCreateMain()
        },
        () => {
          if (!this.isAppQuitting) this.focusOrCreateMain()
        },
      )
      return
    }
    void this.createMainWindow({ showWhenReady: true }).catch((error) => {
      windowLog.error('[window] foreground window creation failed', error)
    })
  }

  /**
   * Enable / disable the M1 hide-to-tray close behaviour. When true,
   * clicking the close button hides the window (kept in memory) instead
   * of destroying it; the user reopens via the tray menu's "Open Main Window"
   * (which calls {@link focusOrCreateMain}).
   *
   * Tray menu "Quit Completely" → app.quit() → before-quit → isAppQuitting=true,
   * so the next close event short-circuits to native (real quit).
   */
  setHideOnClose(enable: boolean): void {
    this.hideOnClose = enable
  }

  /**
   * Mark app quit in progress. When true, the close-event handler bypasses
   * layered dismiss and lets native close proceed (Cmd+Q semantics).
   */
  setAppQuitting(quitting: boolean): void {
    this.isAppQuitting = quitting
  }

  /**
   * Renderer confirmed the close (no modal to dismiss, or layered dismiss
   * already done). Cancel the 3-second force-close timer and destroy the
   * window.
   *
   * Scope: acts on `this.mainWindow` (single-window app by design). Sibling
   * handlers in `handlers/window.ts` use `senderWindow(event)` and would
   * scope to the calling window if multi-window support is added — but this
   * method intentionally tracks the singleton main window because it owns
   * the close-intercept state machine.
   */
  confirmClose(): void {
    this.clearPendingCloseTimeout()
    const win = this.mainWindow
    if (win && !win.isDestroyed()) win.destroy()
  }

  /**
   * Renderer handled the close by dismissing a modal/overlay. Cancel the
   * 3-second force-close timer; the window stays open.
   *
   * Scope: acts on the singleton main-window's pending timer (no window ref
   * needed — `cancelClose` only cancels state, doesn't touch the window).
   */
  cancelClose(): void {
    this.clearPendingCloseTimeout()
  }

  // Dev only: Vite spawns in parallel with Electron and typically needs ~3 s.
  // Retry up to 15 s so the race never leaves the window blank.
  //
  // Only ERR_CONNECTION_REFUSED is treated as transient — anything else
  // (bad URL, DNS failure, certificate error) is an actual configuration bug
  // and should surface immediately rather than burn 15 s of retries.
  private async loadDevUrlWithRetry(
    win: BrowserWindow,
    url: string,
    maxAttempts = 30,
    delayMs = 500,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await win.loadURL(url)
        return
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        const isRetriable = message.includes('ERR_CONNECTION_REFUSED') || message.includes('ERR_NETWORK_CHANGED')
        if (!isRetriable || attempt === maxAttempts) throw err
        windowLog.info(`[window] dev URL not ready (${message}), retry ${attempt}/${maxAttempts}`)
        await new Promise((r) => setTimeout(r, delayMs))
      }
    }
  }

  private clearPendingCloseTimeout(): void {
    if (this.pendingCloseTimeout) {
      clearTimeout(this.pendingCloseTimeout)
      this.pendingCloseTimeout = null
    }
  }
}

export function buildPreloadPath(): string {
  return join(__dirname, 'bootstrap-preload.cjs')
}

export function buildExcelPreloadPath(): string {
  return join(__dirname, 'excel-host-preload.cjs')
}

export function buildRendererIndexHtml(): string {
  return join(__dirname, 'renderer/index.html')
}

export function buildExcelRendererIndexHtml(): string {
  return join(__dirname, 'renderer/excel.html')
}
