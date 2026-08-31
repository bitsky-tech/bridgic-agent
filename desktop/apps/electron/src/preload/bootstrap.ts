import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type {
  AgentEventPayload,
  AutoUpdateEvent,
  BackendSnapshot,
  EmbeddedBrowserSnapshot,
  ElectronAPI,
  ExcelHostSnapshot,
  FsChangedEvent,
  GuiSettings,
  WindowCloseRequest,
} from '../shared/types'
import { localResourceTokenFromArgv } from '../shared/local-resource'

/**
 * Bridge exposed on `window.api`. Anything not surfaced here is not reachable
 * from the renderer — that's the security boundary.
 *
 * Pub/Sub channels (settings/theme/deep-link/auto-update/agent-event)
 * return an unsubscribe function so React effects can clean up properly.
 */

function subscribe<T>(channel: string, callback: (value: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, value: T) => callback(value)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: ElectronAPI = {
  app: {
    getVersion: () => ipcRenderer.invoke(IPC.app.getVersion),
    getPath: (name) => ipcRenderer.invoke(IPC.app.getPath, name),
    openLogFile: () => ipcRenderer.invoke(IPC.app.openLogFile),
    quit: () => ipcRenderer.invoke(IPC.app.quit),
  },
  shell: {
    openExternal: (url) => ipcRenderer.invoke(IPC.shell.openExternal, url),
    showItemInFolder: (path) => ipcRenderer.invoke(IPC.shell.showItemInFolder, path),
    openPath: (path) => ipcRenderer.invoke(IPC.shell.openPath, path),
    // Synchronous — webUtils resolves a File to its real on-disk path (or '').
    getPathForFile: (file) => webUtils.getPathForFile(file),
  },
  dialog: {
    open: (options) => ipcRenderer.invoke(IPC.dialog.open, options),
    save: (options) => ipcRenderer.invoke(IPC.dialog.save, options),
  },
  excel: {
    open: () => ipcRenderer.invoke(IPC.excel.open),
    save: (request) => ipcRenderer.invoke(IPC.excel.save, request),
    saveAs: (request) => ipcRenderer.invoke(IPC.excel.saveAs, request),
  },
  settings: {
    get: () => ipcRenderer.invoke(IPC.settings.get),
    set: (next) => ipcRenderer.invoke(IPC.settings.set, next),
    reset: () => ipcRenderer.invoke(IPC.settings.reset),
    export: () => ipcRenderer.invoke(IPC.settings.export),
    import: () => ipcRenderer.invoke(IPC.settings.import),
    openFile: () => ipcRenderer.invoke(IPC.settings.openFile),
  },
  drafts: {
    load: () => ipcRenderer.invoke(IPC.drafts.load),
    save: (drafts) => ipcRenderer.invoke(IPC.drafts.save, drafts),
  },
  specComments: {
    load: () => ipcRenderer.invoke(IPC.specComments.load),
    save: (specComments) => ipcRenderer.invoke(IPC.specComments.save, specComments),
  },
  market: {
    load: () => ipcRenderer.invoke(IPC.market.load),
    save: (cache) => ipcRenderer.invoke(IPC.market.save, cache),
  },
  window: {
    minimize: () => ipcRenderer.invoke(IPC.window.minimize),
    maximizeToggle: () => ipcRenderer.invoke(IPC.window.maximizeToggle),
    isForeground: () => ipcRenderer.invoke(IPC.window.isForeground),
    isFullScreen: () => ipcRenderer.invoke(IPC.window.isFullScreen),
    close: () => ipcRenderer.invoke(IPC.window.close),
    confirmClose: () => ipcRenderer.invoke(IPC.window.confirmClose),
    cancelClose: () => ipcRenderer.invoke(IPC.window.cancelClose),
    setTrafficLightsVisible: (visible: boolean) =>
      ipcRenderer.invoke(IPC.window.setTrafficLightsVisible, visible),
  },
  browser: {
    snapshot: () => ipcRenderer.invoke(IPC.browser.snapshot),
    closeSession: (sessionId) => ipcRenderer.invoke(IPC.browser.closeSession, sessionId),
    activateSession: (sessionId) => ipcRenderer.invoke(IPC.browser.activateSession, sessionId),
    createTab: (sessionId, url) => ipcRenderer.invoke(IPC.browser.createTab, sessionId, url),
    activateTab: (sessionId, tabId) =>
      ipcRenderer.invoke(IPC.browser.activateTab, sessionId, tabId),
    closeTab: (sessionId, tabId) => ipcRenderer.invoke(IPC.browser.closeTab, sessionId, tabId),
    navigateTab: (sessionId, tabId, url) =>
      ipcRenderer.invoke(IPC.browser.navigateTab, sessionId, tabId, url),
    goBack: (sessionId, tabId) => ipcRenderer.invoke(IPC.browser.goBack, sessionId, tabId),
    goForward: (sessionId, tabId) =>
      ipcRenderer.invoke(IPC.browser.goForward, sessionId, tabId),
    reload: (sessionId, tabId) => ipcRenderer.invoke(IPC.browser.reload, sessionId, tabId),
    hasHorizontalOverflow: (sessionId, tabId) =>
      ipcRenderer.invoke(IPC.browser.hasHorizontalOverflow, sessionId, tabId),
    setBounds: (bounds) => ipcRenderer.invoke(IPC.browser.setBounds, bounds),
    setVisible: (visible, focusHost) =>
      ipcRenderer.invoke(IPC.browser.setVisible, visible, focusHost),
  },
  excelHost: {
    snapshot: () => ipcRenderer.invoke(IPC.excelHost.snapshot),
    ensureSession: (sessionId, config) =>
      ipcRenderer.invoke(IPC.excelHost.ensureSession, sessionId, config),
    closeSession: (sessionId) => ipcRenderer.invoke(IPC.excelHost.closeSession, sessionId),
    activateSession: (sessionId) => ipcRenderer.invoke(IPC.excelHost.activateSession, sessionId),
    setBounds: (bounds) => ipcRenderer.invoke(IPC.excelHost.setBounds, bounds),
    setVisible: (visible, focusHost) =>
      ipcRenderer.invoke(IPC.excelHost.setVisible, visible, focusHost),
  },
  backend: {
    snapshot: () => ipcRenderer.invoke(IPC.backend.snapshot),
    refresh: (expectedEndpointEpoch) =>
      ipcRenderer.invoke(IPC.backend.refresh, expectedEndpointEpoch),
    start: () => ipcRenderer.invoke(IPC.backend.start),
    stop: () => ipcRenderer.invoke(IPC.backend.stop),
    restart: () => ipcRenderer.invoke(IPC.backend.restart),
    openLogs: () => ipcRenderer.invoke(IPC.backend.openLogs),
    getClients: () => ipcRenderer.invoke(IPC.backend.getClients),
    autostartStatus: () => ipcRenderer.invoke(IPC.backend.autostartStatus),
    setAutostart: (enabled) => ipcRenderer.invoke(IPC.backend.setAutostart, enabled),
    resolveCompatibility: () => ipcRenderer.invoke(IPC.backend.resolveCompatibility),
  },
  update: {
    installNow: () => ipcRenderer.invoke(IPC.update.installNow),
    checkNow: () => ipcRenderer.invoke(IPC.update.checkNow),
    getStatus: () => ipcRenderer.invoke(IPC.update.getStatus),
  },
  system: {
    osPrefersDark: () => ipcRenderer.invoke(IPC.system.osPrefersDark),
    getDiagnostics: () => ipcRenderer.invoke(IPC.system.getDiagnostics),
  },
  notify: {
    show: (payload) => ipcRenderer.invoke(IPC.notify.show, payload),
  },
  issueReport: {
    exportFile: (request) => ipcRenderer.invoke(IPC.issueReport.exportFile, request),
  },
  fs: {
    listDir: (absPath, relBase) => ipcRenderer.invoke(IPC.fs.listDir, absPath, relBase),
    searchDir: (req) => ipcRenderer.invoke(IPC.fs.searchDir, req),
    setWatchDirs: (paths) => ipcRenderer.invoke(IPC.fs.setWatchDirs, paths),
    writeFile: (absPath, content) => ipcRenderer.invoke(IPC.fs.writeFile, absPath, content),
    writeWorkflowArchive: (absPath, content) =>
      ipcRenderer.invoke(IPC.fs.writeWorkflowArchive, absPath, content),
    writeWorkflowRunArchive: (absPath, content) =>
      ipcRenderer.invoke(IPC.fs.writeWorkflowRunArchive, absPath, content),
  },
  events: {
    onDeepLink: (callback) => subscribe<string>(IPC.events.deepLink, callback),
    onAutoUpdate: (callback) => subscribe<AutoUpdateEvent>(IPC.events.autoUpdate, callback),
    onAgentEvent: (callback) => subscribe<AgentEventPayload>(IPC.events.agentEvent, callback),
    onBackendState: (callback) => subscribe<BackendSnapshot>(IPC.events.backendState, callback),
    onSettingsChanged: (callback) =>
      subscribe<GuiSettings>(IPC.events.settingsChanged, callback),
    onSystemThemeChanged: (callback) =>
      subscribe<boolean>(IPC.events.systemThemeChanged, callback),
    onWindowForegroundChanged: (callback) =>
      subscribe<boolean>(IPC.events.windowForegroundChanged, callback),
    onWindowFullScreenChanged: (callback) =>
      subscribe<boolean>(IPC.events.windowFullScreenChanged, callback),
    onWindowCloseRequested: (callback) =>
      subscribe<WindowCloseRequest>(IPC.events.windowCloseRequested, callback),
    onEmbeddedBrowserChanged: (callback) =>
      subscribe<EmbeddedBrowserSnapshot>(IPC.events.embeddedBrowserChanged, callback),
    onExcelHostChanged: (callback) =>
      subscribe<ExcelHostSnapshot>(IPC.events.excelHostChanged, callback),
    onFsChanged: (callback) => subscribe<FsChangedEvent>(IPC.events.fsChanged, callback),
  },
}

contextBridge.exposeInMainWorld('api', api)

/**
 * Per-process capability used only to construct `bridgic-local:` resource URLs.
 *
 * BrowserWindow preloads can be inherited by child frames on some Electron
 * configurations. Keep the token on the trusted top-level application frame;
 * the remote showcase iframe shares the default Session (and therefore the
 * protocol registration) but must not be able to mint local-file requests.
 */
if (process.isMainFrame) {
  const localResourceToken = localResourceTokenFromArgv(process.argv)
  if (localResourceToken) {
    contextBridge.exposeInMainWorld('__localResourceToken__', localResourceToken)
  }
}

/**
 * Seed initial GuiSettings to the renderer BEFORE the first React paint.
 *
 * Main loads the blob synchronously (`loadGuiSettingsSync`) and base64-
 * encodes it into `webPreferences.additionalArguments`. We pluck it
 * off `process.argv` here and expose it on `window.__initialSettings__`
 * so `atoms/settings.ts` can initialize its atom synchronously — no
 * async round-trip, no flash of the wrong theme.
 *
 * Defensive on every parsing step: malformed blob → null seed → renderer
 * falls through to DEFAULT_SETTINGS.
 */
const INITIAL_SETTINGS_FLAG = '--initial-settings='
const initialSettingsArg = process.argv.find((a) => a.startsWith(INITIAL_SETTINGS_FLAG))
let initialSettings: GuiSettings | null = null
if (initialSettingsArg) {
  try {
    const b64 = initialSettingsArg.slice(INITIAL_SETTINGS_FLAG.length)
    initialSettings = JSON.parse(Buffer.from(b64, 'base64').toString('utf-8')) as GuiSettings
  } catch {
    initialSettings = null
  }
}
contextBridge.exposeInMainWorld('__initialSettings__', initialSettings)

/**
 * Platform marker: lets renderer CSS switch layout via
 * html[data-platform="darwin"] (e.g. the macOS hidden-inset titlebar yielding
 * 86px to the traffic lights).
 *
 * It must wait for DOMContentLoaded before writing: the preload runs early
 * against the initial blank document, and the subsequent loadURL replaces the
 * whole document, so an attribute set beforehand is lost (the documentElement
 * the renderer sees only carries the attributes hard-coded in the HTML).
 */
function setPlatformMarker(): void {
  document.documentElement.dataset.platform = process.platform
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', setPlatformMarker, { once: true })
} else {
  setPlatformMarker()
}
