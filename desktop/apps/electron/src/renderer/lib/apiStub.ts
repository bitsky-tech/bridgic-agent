import { DEFAULT_SETTINGS } from '@app/shared/types'
import type { ElectronAPI } from '../../shared/types'
import { BackendState } from '../../main/python-client/types'

/**
 * In-renderer fallback for `window.api` so the app can boot under plain Vite
 * (Playwright tests, design preview) without an Electron preload. All methods
 * resolve to safe no-ops or in-memory defaults; the IPC contract types stay
 * intact so application code doesn't need to branch.
 */
export function installApiStub(): void {
  if (typeof window === 'undefined') return
  if ((window as { api?: ElectronAPI }).api) return

  const noopUnsub = () => () => {}
  let memorySettings = { ...DEFAULT_SETTINGS }
  let memoryDrafts: Record<string, unknown> = {}
  let memorySpecComments: Record<string, unknown> = {}
  let memoryMarketCache: Record<string, unknown> = {}

  const stub: ElectronAPI = {
    app: {
      getVersion: async () => '0.1.0-stub',
      getPath: async () => '/tmp/stub',
      openLogFile: async () => ({ ok: false, reason: 'stub' as const }),
      quit: async () => {},
    },
    // NOTE: stubs use `console.*` (not the renderer `rlog`) on purpose. The
    // stubs only ever execute in non-Electron contexts (Playwright, raw
    // Vite preview) where `electron-log/renderer` itself falls back to
    // `console.*` anyway — adding the indirection wouldn't change anything.
    shell: {
      openExternal: async (url: string) => {
        console.debug('[api-stub] shell.openExternal', url)
      },
      showItemInFolder: async () => {},
      openPath: async () => {},
      // Non-Electron context: no real file path available.
      getPathForFile: () => '',
    },
    dialog: {
      open: async () => ({ canceled: true, filePaths: [] }),
      save: async () => ({ canceled: true, filePath: '' }),
    },
    settings: {
      get: async () => memorySettings,
      set: async (next) => {
        memorySettings = next
      },
      reset: async () => {
        memorySettings = { ...DEFAULT_SETTINGS }
        return memorySettings
      },
      export: async () => ({ ok: false as const, reason: 'stub' }),
      import: async () => ({ ok: false as const, reason: 'stub' }),
      openFile: async () => ({ ok: false as const, reason: 'stub' }),
    },
    drafts: {
      load: async () => memoryDrafts,
      save: async (drafts) => {
        memoryDrafts = drafts
      },
    },
    specComments: {
      load: async () => memorySpecComments,
      save: async (specComments) => {
        memorySpecComments = specComments
      },
    },
    market: {
      load: async () => memoryMarketCache,
      save: async (cache) => {
        memoryMarketCache = cache
      },
    },
    window: {
      minimize: async () => {},
      maximizeToggle: async () => {},
      isForeground: async () => true,
      isFullScreen: async () => false,
      close: async () => {},
      confirmClose: async () => {},
      cancelClose: async () => {},
      setTrafficLightsVisible: async () => {},
    },
    browser: {
      snapshot: async () => ({ sessions: [] }),
      closeSession: async () => {},
      activateSession: async () => {},
      createTab: async () => ({
        tabId: 'stub-tab',
        targetId: null,
        webContentsId: 0,
        title: '',
        url: 'about:blank',
        loading: false,
        canGoBack: false,
        canGoForward: false,
        faviconUrl: null,
        crashed: false,
      }),
      activateTab: async () => {},
      closeTab: async () => {},
      navigateTab: async () => {},
      goBack: async () => {},
      goForward: async () => {},
      reload: async () => {},
      hasHorizontalOverflow: async () => false,
      setBounds: async () => {},
      setVisible: async () => {},
    },
    powerpoint: {
      snapshot: async () => ({ sessions: [] }),
      ensureSession: async (sessionId) => ({
        sessionId,
        targetId: null,
        webContentsId: 0,
        loading: false,
        crashed: false,
      }),
      closeSession: async () => {},
      activateSession: async () => {},
      setBounds: async () => {},
      setVisible: async () => {},
      requestClose: async () => {},
      setExpanded: async () => {},
      openFile: async () => { throw new Error('Opening PowerPoint files requires Electron') },
    },
    backend: {
      snapshot: async () => ({
        state: BackendState.Idle,
        endpoint: null,
        lastError: null,
        compatibility: null,
      }),
      refresh: async () => ({
        state: BackendState.Idle,
        endpoint: null,
        lastError: null,
        compatibility: null,
      }),
      start: async () => {},
      stop: async () => {},
      restart: async () => {},
      openLogs: async () => ({ ok: false as const, reason: 'stub' }),
      getClients: async () => ({ ok: false as const, reason: 'stub' }),
      autostartStatus: async () => ({ ok: false as const, reason: 'stub' }),
      setAutostart: async () => ({ ok: false as const, reason: 'stub' }),
      resolveCompatibility: async () => ({
        state: BackendState.Idle,
        endpoint: null,
        lastError: null,
        compatibility: null,
      }),
    },
    update: {
      installNow: async () => ({ ok: false as const, reason: 'update-disabled' as const }),
      checkNow: async () => 'disabled' as const,
      getStatus: async () => ({ isEnabled: false, stagedVersion: null }),
    },
    system: {
      osPrefersDark: async () => false,
      getDiagnostics: async () => ({
        appVersion: '0.1.0-stub',
        platform: 'browser',
        arch: 'unknown',
        osRelease: 'unknown',
        electronVersion: 'unavailable',
        chromeVersion: 'unavailable',
      }),
    },
    notify: {
      // No native notifications outside Electron — report not-shown.
      show: async () => ({ shown: false }),
    },
    issueReport: {
      exportFile: async () => ({ ok: false as const, reason: 'cancelled' as const }),
    },
    fs: {
      // Non-Electron context has no disk access — empty results degrade the
      // session-file tree and the @ popover to their empty states.
      listDir: async () => ({ ok: true as const, nodes: [] }),
      searchDir: async () => ({ hits: [], total: 0, partial: false }),
      // No watchers without a main process — the tree falls back to its
      // snapshot (manual re-expand) behavior, which is always present.
      setWatchDirs: async () => {},
      // No disk in a non-Electron context — accept + drop.
      writeFile: async () => {},
      writePresentation: async () => {},
      writeWorkflowArchive: async () => {},
      writeWorkflowRunArchive: async () => {},
    },
    events: {
      onDeepLink: noopUnsub,
      onAutoUpdate: noopUnsub,
      onAgentEvent: noopUnsub,
      onBackendState: noopUnsub,
      onSettingsChanged: noopUnsub,
      onSystemThemeChanged: noopUnsub,
      onWindowForegroundChanged: noopUnsub,
      onWindowFullScreenChanged: noopUnsub,
      onWindowCloseRequested: noopUnsub,
      onEmbeddedBrowserChanged: noopUnsub,
      onEmbeddedPowerPointChanged: noopUnsub,
      onPowerPointCloseRequested: noopUnsub,
      onPowerPointExpandedChanged: noopUnsub,
      onFsChanged: noopUnsub,
    },
  }

  ;(window as { api: ElectronAPI }).api = stub
}
