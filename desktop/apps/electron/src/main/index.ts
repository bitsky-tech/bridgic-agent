// Load the user's shell environment BEFORE any other import — anything that
// spawns subprocesses (npm packages, plugins) needs the full PATH on macOS.
import { loadShellEnv } from './shell-env'
loadShellEnv()

// Pin the Electron profile to this run's channel, for the same "must happen
// first" reason as loadShellEnv above — but stricter: the single-instance lock
// below is scoped to userData, so relocating it after anything has touched the
// profile would be too late. Dev and production GUIs coexist because of this
// one call. No-op unless AMPHI_DESKTOP_CHANNEL=development. See channel.ts.
import { applyDesktopChannel } from './channel'
const desktopChannel = applyDesktopChannel()

import { app, nativeTheme, powerMonitor, protocol, screen, session } from 'electron'
import { join } from 'node:path'
import log, { mainLog, isDebugMode, telemetryLog } from './logger'
import { WindowManager, buildPreloadPath, buildRendererIndexHtml } from './window-manager'
import { setupDeepLink } from './deep-link'
import { onQuitForUpdate, setAutoUpdateSink, startUpdateChecks } from './auto-update'
import { initNotificationService } from './notifications'
import { cleanupPowerManager } from './power-manager'
import { pythonClient } from './python-client'
import { BackendState } from './python-client/types'
import { cliAutostartStatus } from './python-client/cli'
import { trayManager } from './tray-manager'
import { installProcessErrorHooks } from './process-hooks'
import { registerAllHandlers } from './handlers'
import { disposeAllWatchers } from './handlers/fs-watch'
import { IPC } from '../shared/ipc-channels'
import {
  APP_DEEPLINK_SCHEME,
  APP_PRODUCT_NAME,
  APP_VERSION,
  TELEMETRY_STATE_FILE_NAME,
} from '../shared/app-meta'
import { applyApplicationIdentity } from './app-identity'
import {
  applyLocale,
  applyNativeThemeSource,
  getGuiSettings,
  loadGuiSettingsSync,
  onLocaleApplied,
  onTelemetryConsentChanged,
} from './gui-settings'
import { buildApplicationMenu } from './app-menu'
import { applyTitleBarOverlay, isDarkAppearance } from './titlebar-overlay'
import { isQuitConfirmed, quitWithDaemon } from './quit-with-daemon'
import { openDaemonLogs } from './handlers/backend'
import { EmbeddedBrowserController } from './embedded-browser-controller'
import { installWindowsSessionEndGuard } from './windows-session-end'
import { parseLaunchIntent, shouldStartBackendForLaunch } from './launch-intent'
import { initializeTrayWithFailOpen } from './window-visibility'
import { runPrimaryInstanceBootstrap } from './single-instance-bootstrap'
import { amphiUserFile } from './paths'
import { PostHogTelemetry } from './telemetry/posthog-telemetry'
import { UsageTelemetry } from './telemetry/usage-telemetry'
import {
  createLocalResourceToken,
  installLocalResourceProtocol,
  registerLocalResourceScheme,
} from './local-resource-protocol'
import { LOCAL_RESOURCE_TOKEN_ARGUMENT_PREFIX } from '../shared/local-resource'

// Privileged custom schemes must be declared before Electron emits ready.
// This scheme intentionally remains subject to CSP and unavailable to fetch/XHR;
// only resource elements can stream through its token-protected handler.
registerLocalResourceScheme(protocol)

const embeddedBrowserCdpEndpoint = EmbeddedBrowserController.configureRemoteDebugging(app)

// Enable electron-log's renderer-side bridge so logs from the renderer also
// land in the main log file. Must be called BEFORE any BrowserWindow is created.
log.initialize()

// Catch anything that escapes our try/catch sites — unhandled promise
// rejections, uncaught exceptions, node warnings. Must be installed BEFORE
// any async work starts so first-tick failures are captured.
installProcessErrorHooks()

// Keep the user-facing name separate from the packaged OS identity. `.env`'s
// APP_NAME may override display text, while Windows AppUserModelID remains the
// stable appId declared in electron-builder.yml.
applyApplicationIdentity(app, process.env.APP_NAME || APP_PRODUCT_NAME)

// The application menu is built in `app-menu.ts` and installed further down, after
// `applyLocale` has resolved the display language — building it here would pin every label
// to the pre-boot default before settings have even been read.

const deepLinkScheme = process.env.APP_DEEPLINK_SCHEME || APP_DEEPLINK_SCHEME
const wasOpenedAtLogin = (() => {
  if (process.platform !== 'darwin' || !app.isPackaged) return false
  try {
    return app.getLoginItemSettings().wasOpenedAtLogin === true
  } catch (error) {
    mainLog.warn('[main] could not read macOS login-item launch state', error)
    return false
  }
})()
const launchIntent = parseLaunchIntent(process.argv, deepLinkScheme, { wasOpenedAtLogin })
mainLog.info(
  `[main] starting (debug=${isDebugMode}, channel=${desktopChannel}, background=${launchIntent.background})`,
)

// In Electron, the renderer Vite dev server URL is injected by scripts/electron-dev.ts.
const devServerUrl = process.env.VITE_DEV_SERVER_URL
const preloadPath = buildPreloadPath()
const rendererIndexHtml = buildRendererIndexHtml()

/**
 * Load GuiSettings synchronously BEFORE constructing BrowserWindow.
 * Two reasons:
 *   1. The renderer atom (atoms/settings.ts) seeds from
 *      `window.__initialSettings__`, which preload reads off
 *      `process.argv`. The blob must be encoded into
 *      `webPreferences.additionalArguments` at BrowserWindow ctor time.
 *   2. The OS-painted first frame uses `backgroundColor` — deriving it
 *      from `settings.theme.mode` (instead of `nativeTheme` alone)
 *      makes the very first paint match the user's chosen scheme,
 *      not just the OS preference.
 */
const initialSettings = loadGuiSettingsSync()
// Tell macOS the app's appearance (light/dark/system). Must happen before the
// window is created — otherwise, on blur, the native traffic lights paint
// their inactive gray dots according to the OS appearance, which is invisible
// on a UI using the opposite theme.
applyNativeThemeSource(initialSettings)
// Resolve the display language before anything native is drawn: the tray and the
// application menu are built from it, and both exist before the first window. Registering
// the rebuild here (rather than letting gui-settings reach for these modules) keeps the
// dependency one-way — both of them already write settings.
onLocaleApplied(() => {
  buildApplicationMenu()
  trayManager.refreshMenu()
})
applyLocale(initialSettings)
// When theme.mode = 'system', the OS switching light/dark on its own does
// **not** go through writeGuiSettings, so without this subscription the WCO
// palette would stay stuck on the old theme (a black ✕ invisible in dark
// mode). No-op off win32.
nativeTheme.on('updated', () => applyTitleBarOverlay(getGuiSettings()))
const initialSettingsArg =
  '--initial-settings=' + Buffer.from(JSON.stringify(initialSettings)).toString('base64')
const localResourceToken = createLocalResourceToken()
const localResourceTokenArg = LOCAL_RESOURCE_TOKEN_ARGUMENT_PREFIX + localResourceToken

// Reuse titlebar-overlay's decision instead of rewriting the same ternary
// here: within one process there must be exactly one answer to "are we dark
// right now", otherwise adding a ThemeMode value later would mean updating one
// site and missing the other, and the window base color would no longer match
// the caption-button palette.
const backgroundColorOverride = isDarkAppearance(initialSettings) ? '#0b0b0c' : '#ffffff'

const postHogTelemetry = new PostHogTelemetry({
  projectToken: process.env.POSTHOG_PROJECT_TOKEN || '',
  identityPath: amphiUserFile(TELEMETRY_STATE_FILE_NAME),
  appVersion: APP_VERSION,
  releaseChannel: desktopChannel,
  distribution: app.isPackaged ? 'official' : 'development',
  platform: process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux',
  log: telemetryLog,
})
const usageTelemetry = new UsageTelemetry({
  transport: postHogTelemetry,
  powerMonitor,
  log: telemetryLog,
})
let telemetryConsent = initialSettings.ui.telemetryOptIn
let telemetryReady = false
onTelemetryConsentChanged((consented) => {
  telemetryConsent = consented
  if (telemetryReady) usageTelemetry.setConsent(consented)
})

const windowManager = new WindowManager({
  preloadPath,
  devServerUrl,
  rendererIndexHtml,
  additionalArguments: [initialSettingsArg, localResourceTokenArg],
  backgroundColorOverride,
  onMainWindowCreated: (window) => usageTelemetry.attachMainWindow(window),
})
const embeddedBrowserController = new EmbeddedBrowserController(
  windowManager.getEmbeddedBrowser(),
  embeddedBrowserCdpEndpoint,
  windowManager.getEmbeddedPowerPoint(),
)
const shutdownEmbeddedBrowser = async () => {
  try {
    await embeddedBrowserController.stop()
  } finally {
    await windowManager.getEmbeddedBrowser().shutdown()
    windowManager.getEmbeddedPowerPoint().closeAll()
  }
}
let telemetryShutdownComplete = false
let telemetryShutdownPromise: Promise<void> | null = null
let resumeQuitAfterTelemetry = false
const shutdownUsageTelemetry = (): Promise<void> => {
  telemetryShutdownPromise ??= usageTelemetry.shutdown().finally(() => {
    telemetryShutdownComplete = true
  })
  return telemetryShutdownPromise
}
const shutdownBeforeQuit = async () => {
  await shutdownUsageTelemetry()
  await shutdownEmbeddedBrowser()
}
const quitApp = () => quitWithDaemon(shutdownBeforeQuit)

let windowsSessionEnding = false
let backgroundBootstrapComplete = !launchIntent.background
let explicitForegroundRequested = !launchIntent.background

const requestForeground = () => {
  if (windowsSessionEnding) return
  explicitForegroundRequested = true
  windowManager.focusOrCreateMain()
  // A normal second launch / deep link / tray click is explicit user intent.
  // If the original process came from a background login item whose daemon
  // autostart was disabled, upgrade that already-running process to the same
  // behavior as a normal foreground launch. BrowserWindow creation is
  // synchronous, so the Windows session-end guard exists before this start.
  if (launchIntent.background && app.isReady() && windowManager.getMainWindow()) {
    void pythonClient.start()
  }
}

let signalShutdown: Promise<void> | null = null
const exitAfterSignal = (): Promise<void> => {
  signalShutdown ??= (async () => {
    try {
      await shutdownUsageTelemetry()
    } catch (error) {
      mainLog.warn('[shutdown] telemetry cleanup failed after process signal', error)
    }
    try {
      await shutdownEmbeddedBrowser()
    } catch (error) {
      mainLog.warn('[shutdown] embedded browser cleanup failed after process signal', error)
    } finally {
      windowManager.setAppQuitting(true)
      pythonClient.stop()
      cleanupPowerManager()
      disposeAllWatchers()
      app.exit(0)
    }
  })()
  return signalShutdown
}
// Single-instance enforcement + deep-link routing must happen before
// app.whenReady. setupDeepLink owns BOTH: it calls
// app.requestSingleInstanceLock() (the second process exits with the
// lock denied) AND wires a `second-instance` handler that brings the
// running window back to the front. The result is the design
// invariant: at most one Amphi GUI per OS user, second
// double-clicks focus the existing window instead of opening another.
// See deep-link.ts §3 for the implementation.
const ownsSingleInstanceLock = setupDeepLink({
  // Defaults to the single source of truth in app-meta; `.env`'s
  // APP_DEEPLINK_SCHEME can still override it (for local debugging), but it is
  // no longer the only source — that would let a stale .env copy get silently
  // baked into the artifact (see APP_DEEPLINK_SCHEME).
  scheme: deepLinkScheme,
  onUrl: (url) => {
    const win = windowManager.getMainWindow()
    win?.webContents.send(IPC.events.deepLink, url)
  },
  focusWindow: requestForeground,
})

function bootstrapPrimaryInstance(): void {
  // Windows does not emit Electron's `before-quit` during OS shutdown/logoff.
  // Install this only in the lock owner, before backend discovery or native
  // window creation, so a losing process cannot register app lifecycle work.
  installWindowsSessionEndGuard(app, (event) => {
    windowsSessionEnding = true
    mainLog.info(`[shutdown] Windows ${event}; disabling local backend recovery`)
    usageTelemetry.stopWithoutFlush()
    windowManager.setAppQuitting(true)
    pythonClient.stop()
    trayManager.destroy()
    cleanupPowerManager()
    disposeAllWatchers()
  })
  process.on('SIGINT', () => { void exitAfterSignal() })
  process.on('SIGTERM', () => { void exitAfterSignal() })

  void app.whenReady().then(async () => {
  // Re-resolve the display language now that `app.getLocale()` works: before `ready` it
  // returns '' on Windows/Linux, so the module-level applyLocale above lands on the 'en'
  // fallback for a fresh install (locale = System). Without this the tray built below is
  // English while the window — which resolves via `navigator.language` — is not.
  applyLocale(getGuiSettings())
  initNotificationService()
  telemetryReady = true
  usageTelemetry.start(telemetryConsent, launchIntent.background ? 'background' : 'foreground')

  // The third trigger source for WCO palette/height: the display scale
  // changed. The overlay height is a static value the main process computes in
  // DIP and pushes to the system, while the renderer's top bar re-lays-out
  // automatically with the DPI — dragging the window to another screen with a
  // different scale factor, or changing the system scaling, misaligns the two
  // sides unless we re-push (the caption buttons end up taller or shorter than
  // the top bar). The other two trigger sources (settings change / system
  // light-dark) only fire on deliberate user action and can't cover this one.
  //
  // Must live inside whenReady: calling the `screen` module before app ready throws outright.
  screen.on('display-metrics-changed', () => applyTitleBarOverlay(getGuiSettings()))

  // Register only on the default session used by the trusted application UI.
  // The embedded browser has its own persistent session and cannot access this
  // local-file bridge.
  installLocalResourceProtocol(session.defaultSession, localResourceToken)

  registerAllHandlers(windowManager)

  // Dev-only: project icon.png is NOT bundled into the prod app (only
  // dist/** ships per electron-builder.yml), but in dev the source
  // file is still on disk under apps/electron/resources/icon.png.
  // In prod, macOS dock + Win/Linux task bar pick up the icon via
  // electron-builder's icon.icns/icon.ico defaults, so we skip this
  // path entirely once packaged.
  applyDevDockIcon()

  // createMainWindow constructs and publishes BrowserWindow synchronously,
  // then returns the renderer-load promise. This preserves the Windows
  // session-end event target while allowing the tray to appear immediately,
  // even when renderer navigation is slow or eventually fails.
  const initialWindowLoad = windowManager.createMainWindow({
    showWhenReady: !launchIntent.background,
  })
  // Attach rejection handling in the same turn. A Windows session-end event
  // can make us return before the later await, but navigation failure must
  // never become an unhandled rejection or disappear from the main log.
  const initialWindowSettled = initialWindowLoad.then(
    () => undefined,
    (error: unknown) => {
      mainLog.error('[window] initial renderer load failed; native host remains available', error)
    },
  )
  if (windowsSessionEnding) return

  initializeTrayWithFailOpen({
    initialize: () => {
      trayManager.init({
        openMain: requestForeground,
        // "Quit Completely" = quit the GUI + stop the gateway (showing a native
        // confirmation first when other clients are attached). Closing the
        // window remains hide-to-tray and never touches the shared daemon.
        quitApp: () => {
          void quitApp()
        },
        // The tray has nowhere to render an error, but openDaemonLogs already
        // logs every failure with its reason — repeating it here just doubled
        // each line. The result is discarded on purpose.
        openLogs: () => {
          void openDaemonLogs()
        },
      })
    },
    destroyPartial: () => trayManager.destroy(),
    setHideOnClose: (enabled) => windowManager.setHideOnClose(enabled),
    failOpen: () => windowManager.failOpenMainWindow(),
    reportError: (error) => {
      mainLog.error('[tray] initialization failed; showing main window instead', error)
    },
    reportCleanupError: (error) => {
      mainLog.warn('[tray] partial initialization cleanup failed', error)
    },
  })
  // A packaged macOS login item is opened without activating the app, so once
  // its tray exists a later Dock activation is necessarily explicit user
  // intent and may foreground even while renderer navigation is still pending.
  if (wasOpenedAtLogin) backgroundBootstrapComplete = true
  if (windowsSessionEnding) return

  // A foreground launch is explicit user intent and always discovers/starts
  // the daemon. A background login launch must first confirm that the daemon's
  // OS autostart is EFFECTIVE, not merely registered: Windows Startup Apps can
  // retain the Run value while disabling it. Starting unconditionally here
  // would bypass that opt-out.
  const daemonAutostart = launchIntent.background ? await cliAutostartStatus() : null
  if (windowsSessionEnding) return
  if (shouldStartBackendForLaunch(
    launchIntent,
    daemonAutostart,
    explicitForegroundRequested,
  )) {
    void pythonClient.start()
  } else {
    mainLog.warn(
      '[main] background launch kept gateway stopped because daemon autostart is disabled or unavailable',
    )
  }

  await initialWindowSettled
  backgroundBootstrapComplete = true
  if (windowsSessionEnding) return

  // Register only after the native host exists. Otherwise a browser request
  // arriving during startup could select embedded mode before a WebContentsView
  // has anywhere to attach and unnecessarily fall back to an external window.
  try {
    await embeddedBrowserController.start()
    if (windowsSessionEnding) return
    const registerEmbeddedBrowser = (snapshot: ReturnType<typeof pythonClient.snapshot>) => {
      if (snapshot.state !== BackendState.Ready || !snapshot.endpoint) return
      void embeddedBrowserController.registerWithDaemon(snapshot.endpoint).catch((error) => {
        mainLog.warn('[embedded-browser] daemon registration failed; browser tools remain unavailable', error)
      })
    }
    pythonClient.onState(registerEmbeddedBrowser)
    registerEmbeddedBrowser(pythonClient.snapshot())
  } catch (error) {
    mainLog.warn('[embedded-browser] controller startup failed; browser tools remain unavailable', error)
  }
  if (windowsSessionEnding) return

  setAutoUpdateSink((event) => {
    const win = windowManager.getMainWindow()
    win?.webContents.send(IPC.events.autoUpdate, event)
  })
  startUpdateChecks()
})

// macOS — keep the app alive when all windows close; re-create on dock click.
// On Windows/Linux, hide-to-tray means we should NOT quit when the user
// closes the (only) window — they expect the tray icon to keep the app
// alive. Quitting only happens via tray "Quit Completely" / Cmd+Q / OS shutdown.
app.on('window-all-closed', () => {
  // Intentionally no app.quit() — even on Windows/Linux. The tray's "Quit Completely"
  // is the canonical way out (it calls app.quit() directly).
  //
  // Close session-file watchers though: with no renderer alive nothing can
  // update the watch set, and a tray-resident app would otherwise leak the
  // last window's fds. The renderer re-syncs the set when a window returns.
  disposeAllWatchers()
})

app.on('activate', () => {
  // macOS: fires on Dock-icon click AND on `open` event when app is
  // already running. Pre-tray code only created a window when count==0
  // — with M1 hide-to-tray the window count stays >=1 even when hidden,
  // so that conditional never fired and Dock clicks did nothing.
  // focusOrCreateMain handles all three cases (hidden / minimized /
  // missing) correctly.
  if (!windowsSessionEnding && backgroundBootstrapComplete) requestForeground()
})

/**
 * Install React DevTools as a session extension. Dev-only. Idempotent
 * across launches (Electron persists installed extensions to the
 * session profile so subsequent launches don't re-download).
 *
 * Non-fatal on failure — we'd rather start without React DevTools than
 * abort the whole app.
 */
/**
 * Apply the project icon to the macOS dock during dev runs.
 *
 * Why: Electron in dev mode runs from `node_modules/electron/dist/Electron.app`,
 * whose bundle still carries the framework's default icon — `resources/icon.icns`
 * never gets read at dev time. `app.dock.setIcon()` is the only way to override
 * the running dock tile without rebuilding the host bundle.
 *
 * No-op when:
 *   - The app is packaged (electron-builder already wired icon.icns into the bundle)
 *   - The platform is not darwin (`app.dock` is `undefined` elsewhere)
 *   - The icon file is missing (so we don't crash on a fresh clone before `bun run icons`)
 */
function applyDevDockIcon(): void {
  if (app.isPackaged) return
  if (process.platform !== 'darwin') return
  if (!app.dock) return
  try {
    const iconPath = join(app.getAppPath(), 'resources', 'icon.png')
    app.dock.setIcon(iconPath)
    mainLog.info(`[dock] dev icon applied: ${iconPath}`)
  } catch (err) {
    mainLog.warn('[dock] dev icon setIcon failed (non-fatal)', err)
  }
}

app.on('before-quit', (event) => {
  // Intercept the first pass and run the "Quit Completely" confirmation flow —
  // both ⌘Q and Dock right-click Quit come in through here. They used to
  // bypass the whole flow and quit directly, so even though it means the same
  // thing ("quit the app"), quitting from the Dock would silently leave the
  // gateway running. The tray path already called quitWithDaemon directly; it
  // sets the flag when done and then calls app.quit(), whose second pass falls
  // through to the native flow below.
  //
  // When the user picks "Cancel" in the confirmation dialog, quitWithDaemon
  // neither sets the flag nor quits again — so this preventDefault is the
  // final outcome and the app keeps running.
  if (!isQuitConfirmed()) {
    event.preventDefault()
    void quitApp()
    return
  }
  // Update installation can reach this path without going through quitApp().
  // Keep the final quit bounded but give consented events one normal SDK flush.
  if (!telemetryShutdownComplete) {
    event.preventDefault()
    if (!resumeQuitAfterTelemetry) {
      resumeQuitAfterTelemetry = true
      // Timed because this is the one awaited step on the quit path, and the
      // only way to tell "the flush is slow" apart from "something else is
      // holding the app open" after the fact.
      const flushStartedAt = Date.now()
      mainLog.info('[shutdown] flushing telemetry before quit')
      void shutdownUsageTelemetry().finally(() => {
        mainLog.info(`[shutdown] telemetry flush settled in ${Date.now() - flushStartedAt}ms`)
        app.quit()
      })
    }
    return
  }
  mainLog.info('[shutdown] quit confirmed and telemetry settled; releasing resources')
  releaseForQuit()
})

// Squirrel's handover is a SECOND quit path, and it skips everything above:
// `autoUpdater.quitAndInstall()` closes the windows without emitting
// `before-quit`, so the teardown that unlocks the window-close guard would
// never run and the app would refuse to die while ShipIt waits for it. See
// `onQuitForUpdate`.
//
// NOTE: telemetry gets no flush on this path. `before-quit-for-update` is a
// notification, not a vetoable event — there is nowhere to await an async
// flush before Squirrel closes the windows.
onQuitForUpdate(releaseForQuit)
}

/**
 * Release everything that would otherwise keep the app alive or outlive it.
 *
 * Shared by the two quit paths (`before-quit` and Squirrel's
 * `before-quit-for-update`) because forgetting it on either one strands the
 * process: `setAppQuitting` is what stops `window-manager`'s close handler from
 * hiding to tray instead of closing.
 */
function releaseForQuit(): void {
  const releaseStartedAt = Date.now()
  windowManager.setAppQuitting(true)
  // Best-effort telemetry close. On the `before-quit` path the awaited shutdown
  // above already ran and this is a no-op (the tracker latches `closed`); on
  // Squirrel's `before-quit-for-update` path there is nowhere to await, because
  // that event cannot be vetoed — so the synchronous variant is the only way the
  // final active period gets recorded at all. Events go out immediately anyway
  // (`flushAt: 1`), so not awaiting costs at most an in-flight request.
  try {
    usageTelemetry.stopWithoutFlush()
  } catch (err) {
    // Best-effort means best-effort: telemetry must never block the daemon
    // teardown below, which the update handover depends on.
    mainLog.warn('[telemetry] synchronous close failed', err)
  }
  // pythonClient.stop() only tears down OUR timers/state — the daemon
  // (managed by launchd / `amphi server`) keeps running.
  //
  // Architecture invariant: closing the GUI must
  // NOT bring the daemon down. The daemon is shared with the CLI and
  // potentially the tray (T24+) — only explicit user action via
  // Settings → Gateway → [Stop] or `amphi server stop` from the CLI
  // tears it down. PythonClient.stop() (PythonClient.ts:118-125)
  // intentionally does NOT shell out to cliStop().
  const daemonStartedAt = Date.now()
  pythonClient.stop()
  const watchersStartedAt = Date.now()
  cleanupPowerManager()
  disposeAllWatchers()
  mainLog.info(
    `[shutdown] released in ${Date.now() - releaseStartedAt}ms ` +
      `(daemon=${watchersStartedAt - daemonStartedAt}ms watchers=${Date.now() - watchersStartedAt}ms)`,
  )
}

runPrimaryInstanceBootstrap(ownsSingleInstanceLock, bootstrapPrimaryInstance)
