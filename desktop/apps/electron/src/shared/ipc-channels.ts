/**
 * Single source of truth for IPC channel names.
 *
 * Used by:
 *   - main/handlers/*  → ipcMain.handle / ipcMain.on
 *   - preload/bootstrap → ipcRenderer.invoke / ipcRenderer.on
 *
 * Channel-name strings live in only one place so renaming / refactoring is
 * a single edit and there are no string-typo bugs.
 */

export const IPC = {
  app: {
    getVersion: 'app:getVersion',
    getPath: 'app:getPath',
    openLogFile: 'app:openLogFile',
    /** Fully quit — NOT the same as closing the window. This app hides to tray
     *  on window close (`window-all-closed` deliberately does not quit), so a
     *  renderer that wants the process gone has to say so explicitly. */
    quit: 'app:quit',
  },
  shell: {
    openExternal: 'shell:openExternal',
    showItemInFolder: 'shell:showItemInFolder',
    openPath: 'shell:openPath',
  },
  dialog: {
    open: 'dialog:open',
    save: 'dialog:save',
  },
  /**
   * GuiSettings (single JSON blob at ~/.bridgic/amphi/gui-settings.json).
   * Whole-blob style — `get()` returns the entire shape, `set(next)`
   * replaces it. Push updates land on `events.settingsChanged`.
   *
   * Theme lives inside settings.theme now — there's no separate theme
   * IPC namespace anymore. OS-level dark-mode probing is still
   * exposed via `system.osPrefersDark` below (used to resolve
   * `theme.mode === 'system'`).
   */
  settings: {
    get: 'settings:get',
    set: 'settings:set',
    reset: 'settings:reset',
    export: 'settings:export',
    import: 'settings:import',
    openFile: 'settings:openFile',
  },
  /**
   * Per-session composer drafts (unsent input, including @ mention chips).
   * One JSON blob at ~/.bridgic/amphi/drafts.json — kept OUT of
   * gui-settings.json on purpose: drafts are high-frequency writes and would
   * otherwise trigger the settings-changed broadcast on every keystroke flush.
   */
  drafts: {
    load: 'drafts:load',
    save: 'drafts:save',
  },
  /**
   * Per-session staged spec comments (unsent selection comments). Like drafts,
   * a standalone JSON blob (~/.bridgic/amphi/spec-comments.json): written
   * frequently, and kept out of the settings broadcast.
   */
  specComments: {
    load: 'spec-comments:load',
    save: 'spec-comments:save',
  },
  /**
   * Workflow-market payload cached from showcase.bridgic.ai
   * (~/.bridgic/amphi/market-cache.json). A standalone blob for the same reason as
   * the two above -- it must stay off the settings broadcast -- though it is
   * written rarely (once per refresh interval) rather than on every keystroke.
   */
  market: {
    load: 'market:load',
    save: 'market:save',
  },
  window: {
    minimize: 'window:minimize',
    maximizeToggle: 'window:maximizeToggle',
    isForeground: 'window:isForeground',
    isFullScreen: 'window:isFullScreen',
    close: 'window:close',
    confirmClose: 'window:confirmClose',
    cancelClose: 'window:cancelClose',
    setTrafficLightsVisible: 'window:setTrafficLightsVisible',
  },
  browser: {
    snapshot: 'browser:snapshot',
    closeSession: 'browser:closeSession',
    activateSession: 'browser:activateSession',
    createTab: 'browser:createTab',
    activateTab: 'browser:activateTab',
    closeTab: 'browser:closeTab',
    navigateTab: 'browser:navigateTab',
    goBack: 'browser:goBack',
    goForward: 'browser:goForward',
    reload: 'browser:reload',
    hasHorizontalOverflow: 'browser:hasHorizontalOverflow',
    setBounds: 'browser:setBounds',
    setVisible: 'browser:setVisible',
  },
  workbench: {
    ensure: 'workbench:ensure',
    activate: 'workbench:activate',
    close: 'workbench:close',
  },
  // Bridgic Agent Python daemon coordination — the live backend
  // control plane (discover / spawn / stop / clients). The renderer chats with
  // the daemon directly over HTTP+WS; these channels are the main-process
  // lifecycle surface. Its backend counterpart lives in amphi_service.server.
  backend: {
    snapshot: 'backend:snapshot',
    /** Re-verify the currently published runtime credentials without spawning
     *  or restarting the daemon. Used after an authenticated channel rejects
     *  the current token (HTTP 401 / WS 4401). */
    refresh: 'backend:refresh',
    start: 'backend:start',
    stop: 'backend:stop',
    restart: 'backend:restart',
    openLogs: 'backend:openLogs',
    /** Fetch the daemon's current connected-clients list (M1+).
     *  Returns the parsed /api/gateway/clients response or an error
     *  shape — see GetClientsResult in main/python-client/types.ts.
     *  Main-side wrapper so the Tray (Phase E) and any other main-only
     *  consumer can share the same fetch path with the renderer atom. */
    getClients: 'backend:getClients',
    /** Login-autostart configuration (`amphi server autostart …`).
     *  Surfaced in the GUI because on macOS this setting silently decides HOW
     *  the daemon is launched — launchd (bare PATH) vs a detached child of the
     *  CLI (inherits ours). CLI-only meant users could neither see it was on
     *  nor turn it off. */
    autostartStatus: 'backend:autostartStatus',
    setAutostart: 'backend:setAutostart',
    /** User-triggered escape from a GUI/daemon version mismatch: restart the
     *  daemon so the newly installed bundle takes over. Deliberately a separate
     *  channel from `restart` so it is greppable and can never be reached from
     *  health probing, discovery or the installer — a version mismatch means a
     *  half-applied update, and bouncing the daemon behind the user's back would
     *  drop whatever an agent was doing. */
    resolveCompatibility: 'backend:resolveCompatibility',
  },
  // Desktop auto-update control plane. Events flow the other way through
  // `events.autoUpdate`; this is the one action the renderer can take.
  update: {
    /** Install a already-downloaded update NOW: stop the daemon gracefully,
     *  then quit and hand over to the installer. */
    installNow: 'update:installNow',
    /** Check the feed on the user's behalf (Settings → About). Same guards as
     *  the background timer — a click cannot start a second download. */
    checkNow: 'update:checkNow',
    /** Current updater state, for a UI that opened after the events fired. */
    getStatus: 'update:getStatus',
  },
  system: {
    osPrefersDark: 'system:osPrefersDark',
    getDiagnostics: 'system:getDiagnostics',
  },
  // Native desktop notifications. Triggered by the renderer when the daemon's
  // `schedule.notify` WS frame arrives — main owns the Notification API and
  // the click-to-navigate behavior (focus window + deep-link to the session).
  notify: {
    show: 'notify:show',
  },
  issueReport: {
    exportFile: 'issue-report:exportFile',
  },
  // Local-filesystem reads for UI display (session-file tree / @ popover).
  // Main reads the disk directly — co-location with the daemon is already a
  // baked-in assumption of the mount flow (drag/paste mounts local paths).
  // listDir = one lazy level for browsing; searchDir = names-only walk +
  // scoring where the data lives (whole trees never cross IPC).
  fs: {
    listDir: 'fs:listDir',
    searchDir: 'fs:searchDir',
    // Declarative: renderer pushes the WHOLE set of currently-expanded dir
    // paths; main reconciles its live (non-recursive) watchers to match and
    // pushes `events.fsChanged` when one changes. See main/handlers/fs-watch.ts.
    setWatchDirs: 'fs:setWatchDirs',
    // Write a session's `.work/.build/task.md` directly to disk (the user
    // manually editing the requirements spec). Main strictly validates that the
    // path lands only inside that Build workspace, guarding against out-of-bounds writes.
    writeFile: 'fs:writeFile',
    writeWorkflowArchive: 'fs:writeWorkflowArchive',
    writeWorkflowRunArchive: 'fs:writeWorkflowRunArchive',
  },
  events: {
    deepLink: 'deep-link',
    autoUpdate: 'auto-update',
    agentEvent: 'agent-event',
    backendState: 'backend-state',
    settingsChanged: 'settings-changed',
    systemThemeChanged: 'system-theme-changed',
    windowForegroundChanged: 'window-foreground-changed',
    windowFullScreenChanged: 'window-full-screen-changed',
    windowCloseRequested: 'window-close-requested',
    embeddedBrowserChanged: 'embedded-browser-changed',
    // A watched session-file directory changed on disk → renderer re-reads it.
    fsChanged: 'fs-changed',
  },
} as const

export type AppPathName =
  | 'home'
  | 'appData'
  | 'userData'
  | 'sessionData'
  | 'temp'
  | 'exe'
  | 'desktop'
  | 'documents'
  | 'downloads'
  | 'music'
  | 'pictures'
  | 'videos'
  | 'logs'

// ThemeMode moved to @app/shared/types/settings — single source of truth.
// Re-exported here (both value + type) so existing relative imports
// from ipc-channels keep working without churn.
export { ThemeMode } from '@app/shared/types'
