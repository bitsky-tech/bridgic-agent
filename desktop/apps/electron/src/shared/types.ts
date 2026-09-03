import type { AgentEvent } from './agent-events'
import type {
  AgentMessage,
  AgentMessageOptions,
  AgentTurnStatus,
  AgentMessageSubagent,
  AgentMessageToolCall,
  MessageBlock,
  AppSettings,
  GuiSettings,
  SessionMeta,
  SessionTitleSource,
  SubAgentMode,
} from '@app/shared/types'
import { AgentRole } from '@app/shared/types'
import type {
  OpenDialogOptions,
  OpenDialogReturnValue,
  SaveDialogOptions,
  SaveDialogReturnValue,
} from 'electron'
import type { AppPathName } from './ipc-channels'
import type { DirListResult, FsChangedEvent, SearchDirRequest, SearchDirResult } from './dir-tree'
import type {
  AutostartResult,
  AutostartStatusJson,
  BackendCompatibility,
  BackendSnapshot,
  BackendState,
  BackendEndpoint,
  ClientInfoResponse,
  GetClientsResult,
} from '../main/python-client/types'

/**
 * Outcome of `update.installNow`.
 *
 * A refusal is a value, not an exception: the downloaded update stays staged and
 * the banner turns the reason into an actionable message (e.g. "stop the gateway
 * first"). Throwing would surface as an opaque IPC rejection with nothing the
 * user could act on.
 */
export type UpdateInstallResult =
  | { ok: true }
  | { ok: false; reason: 'no-update-staged' | 'daemon-busy' | 'update-disabled'; detail?: string }

/**
 * Why a manual check did or did not start.
 *
 * `disabled` is NOT an error — it is the normal answer in a dev build or one
 * shipped without an update feed, and the About row says so instead of leaving a
 * button that appears broken.
 */
export type UpdateCheckOutcome = 'started' | 'busy' | 'staged' | 'disabled'

/** Updater state snapshot, for a UI that mounted after the events fired. */
export interface UpdateStatus {
  /** False in dev builds and in any build without a configured feed. */
  isEnabled: boolean
  /** Version waiting to be installed, or null when nothing is staged. */
  stagedVersion: string | null
}

/** Small, credential-free environment snapshot suitable for a user-approved issue report. */
export interface SystemDiagnostics {
  appVersion: string
  platform: string
  arch: string
  osRelease: string
  electronVersion: string
  chromeVersion: string
}

/** A native desktop notification request (daemon `schedule.notify` relay).
 *  title/body arrive pre-localized from the daemon — render them verbatim. */
export interface ShowNotificationPayload {
  title: string
  body: string
  /** The scheduled run's session — notification click opens its run drawer. */
  sessionId: string
  /** The owning schedule — needed to locate the run in the schedules UI. */
  scheduleId: string
  kind: 'failed' | 'action_required'
}

export interface ShowNotificationResult {
  /** false = Notification.isSupported() said no (rare; e.g. Linux without libnotify). */
  shown: boolean
}

/** User-approved Markdown export used when an issue report cannot fit in a URL. */
export interface IssueReportExportRequest {
  suggestedName: string
  content: string
}

export type IssueReportExportResult =
  | { ok: true; path: string }
  | { ok: false; reason: 'cancelled' }

export type {
  AutostartResult,
  AutostartStatusJson,
  BackendCompatibility,
  AgentMessage,
  AgentMessageOptions,
  AgentTurnStatus,
  AgentMessageSubagent,
  AgentMessageToolCall,
  MessageBlock,
  AppSettings,
  GuiSettings,
  BackendEndpoint,
  BackendSnapshot,
  BackendState,
  ClientInfoResponse,
  GetClientsResult,
  SessionMeta,
  SessionTitleSource,
  SubAgentMode,
}
export { AgentRole }

/** Agent event protocol types — single source of truth in `./agent-events`,
 *  re-exported so consumers import everything from `@shared/types`. */
export type {
  AgentEvent,
  AskUserQuestion,
  AskUserQuestionOption,
  ContextUsageSnapshot,
  PermissionItem,
  ThinkPosition,
  WorkflowRunState,
} from './agent-events'

/** WS wire protocol — single source of truth in `./ws-protocol`. Frames, turn
 *  events, and their `const` vocabularies all re-exported so consumers import
 *  everything from `@shared/types`. */
export type {
  ChatBlock,
  HelloFrame,
  SetLocaleFrame,
  SubscribeFrame,
  ChatFrame,
  BuildConfirmFrame,
  TaskConfirmFrame,
  WorkflowConfirmFrame,
  PermissionAnswerFrame,
  PermissionAnswerItem,
  ChoiceAnswerFrame,
  ChoiceAnswerItem,
  ClientFrame,
  ReadyFrame,
  AckFrame,
  CmdErrorFrame,
  ShutdownFrame,
  ControlFrame,
  TurnEvent,
  TurnEventName,
} from './ws-protocol'
export { CLIENT_FRAME, CONTROL_FRAME, TURN_EVENT, SYSTEM_TOPIC, sessionTopic } from './ws-protocol'

/** Dir wire types — single source of truth in `./dir-tree`. */
export type {
  DirTreeNode,
  DirListResult,
  FsChangedEvent,
  SearchDirRequest,
  SearchDirResult,
} from './dir-tree'

export type AutoUpdateEvent =
  | { type: 'checking' }
  | { type: 'available'; info: { version: string } }
  /**
   * Rebuilding the differential source before the download starts.
   *
   * Only ever emitted once per machine — the first update after a .pkg install,
   * where nothing left an `update.zip` behind to diff against. It takes ~44 s,
   * which is long enough that a click on "check for updates" would otherwise
   * look like it did nothing.
   */
  | { type: 'preparing' }
  | { type: 'not-available' }
  /**
   * A background failure. Stays silent in the floating card by design.
   *
   * `code` is electron-updater's machine-readable reason (`newError` puts it on
   * `error.code`, never in the message), and it is the only way to tell
   * "no build for this CPU" apart from a network blip — Settings → About needs
   * that distinction to say something actionable.
   */
  | { type: 'error'; message: string; code?: string }
  | { type: 'progress'; percent: number; bytesPerSecond: number }
  | { type: 'downloaded'; info: { version: string } }
  /**
   * The handover the user asked for did not happen.
   *
   * Distinct from `error`, which covers background failures the UI stays silent
   * about: this one always follows a click, and swallowing it leaves the user
   * staring at an app that stopped its gateway and then did nothing.
   */
  | { type: 'install-failed'; message: string }

/** Payload shape pushed to the renderer for each agent event. */
export interface AgentEventPayload {
  sessionId: string
  event: AgentEvent
}

/**
 * Source of a window-close-requested event from main → renderer.
 * `window-button` = user clicked traffic light / X / close button.
 * `keyboard-shortcut` = user pressed Cmd/Ctrl+W (tracked via 500ms TTL in WindowManager).
 *
 * Renderer currently treats both sources the same (layered dismiss).
 * Reserved for future UX divergence (e.g., keyboard skips modal-close confirmation).
 */
/**
 * Source of a window-close-requested event from main → renderer.
 * `WindowButton` = traffic light / X / native close button.
 * `KeyboardShortcut` = Cmd/Ctrl+W (tracked via 500ms TTL in WindowManager).
 */
export const WindowCloseSource = {
  WindowButton: 'window-button',
  KeyboardShortcut: 'keyboard-shortcut',
} as const
export type WindowCloseSource = (typeof WindowCloseSource)[keyof typeof WindowCloseSource]

export interface WindowCloseRequest {
  source: WindowCloseSource
}

export interface EmbeddedBrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface EmbeddedBrowserTabInfo {
  tabId: string
  targetId: string | null
  webContentsId: number
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  faviconUrl: string | null
  crashed: boolean
}

export interface EmbeddedBrowserSessionInfo {
  sessionId: string
  activeTabId: string | null
  tabs: EmbeddedBrowserTabInfo[]
}

export interface EmbeddedBrowserSnapshot {
  sessions: EmbeddedBrowserSessionInfo[]
}

/**
 * The shape exposed on `window.api` by the preload script.
 * Imported by both renderer and preload so the contract stays in sync.
 */
export interface ElectronAPI {
  app: {
    getVersion(): Promise<string>
    getPath(name: AppPathName): Promise<string>
    openLogFile(): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    /** Fully quit the app. Closing the window only hides it to the tray. */
    quit(): Promise<void>
  }
  shell: {
    openExternal(url: string): Promise<void>
    showItemInFolder(fullPath: string): Promise<void>
    /** Open a file/folder with the OS default program (`shell.openPath`).
     *  Rejects when the OS reports no handler / a missing path. */
    openPath(fullPath: string): Promise<void>
    /** Resolve a pasted/dropped File's real absolute path on the daemon host
     *  (Electron `webUtils.getPathForFile`). Returns '' for files with no
     *  on-disk source (clipboard image data / screenshots). Synchronous. */
    getPathForFile(file: File): string
  }
  dialog: {
    open(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
    save(options: SaveDialogOptions): Promise<SaveDialogReturnValue>
  }
  /**
   * GuiSettings IPC — single whole-blob shape. Theme is part of
   * `settings.theme`; no separate `window.api.theme` anymore.
   *
   * Push updates land on `events.onSettingsChanged`. Renderer atoms
   * (atoms/settings.ts) seed from `window.__initialSettings__`
   * injected by preload, so the first paint is already correctly
   * themed — no async-load FOUC.
   */
  settings: {
    get(): Promise<GuiSettings>
    set(next: GuiSettings): Promise<void>
    reset(): Promise<GuiSettings>
    export(): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    import(): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    openFile(): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
  }
  /**
   * Per-session composer drafts. The map is opaque to main (it just persists
   * the JSON blob); the renderer owns the value shape (`Segment[]` per session)
   * and casts on load. Keyed by session id.
   */
  drafts: {
    load(): Promise<Record<string, unknown>>
    save(drafts: Record<string, unknown>): Promise<void>
  }
  /**
   * Per-session staged spec comments. The map passes straight through main (it
   * only stores JSON); the renderer owns the `PendingComment[]` value shape and
   * casts on load. Keyed by session id.
   */
  specComments: {
    load(): Promise<Record<string, unknown>>
    save(specComments: Record<string, unknown>): Promise<void>
  }
  /** Workflow-market cache from showcase.bridgic.ai. A single global entry under a
   *  fixed key, not keyed by session like the two blobs above. */
  market: {
    load(): Promise<Record<string, unknown>>
    save(cache: Record<string, unknown>): Promise<void>
  }
  window: {
    minimize(): Promise<void>
    maximizeToggle(): Promise<void>
    /** Whether the native host is visible, focused, and not minimized. */
    isForeground(): Promise<boolean>
    /** Whether the native host window currently occupies an OS full-screen
     *  space. On macOS, full screen retracts the traffic-light buttons. */
    isFullScreen(): Promise<boolean>
    close(): Promise<void>
    confirmClose(): Promise<void>
    cancelClose(): Promise<void>
    /** Show/hide the macOS traffic lights. No-op on Windows/Linux (no such
     *  control) — callers don't need to branch on platform. */
    setTrafficLightsVisible(visible: boolean): Promise<void>
  }
  browser: {
    snapshot(): Promise<EmbeddedBrowserSnapshot>
    closeSession(sessionId: string): Promise<void>
    activateSession(sessionId: string | null): Promise<void>
    createTab(sessionId: string, url?: string): Promise<EmbeddedBrowserTabInfo>
    activateTab(sessionId: string, tabId: string): Promise<void>
    closeTab(sessionId: string, tabId: string): Promise<void>
    navigateTab(sessionId: string, tabId: string, url: string): Promise<void>
    goBack(sessionId: string, tabId: string): Promise<void>
    goForward(sessionId: string, tabId: string): Promise<void>
    reload(sessionId: string, tabId: string): Promise<void>
    /** Whether the requested page exceeds its current viewport horizontally. */
    hasHorizontalOverflow(sessionId: string, tabId: string): Promise<boolean>
    setBounds(bounds: EmbeddedBrowserBounds): Promise<void>
    setVisible(visible: boolean, focusHost?: boolean): Promise<void>
  }
  backend: {
    snapshot(): Promise<BackendSnapshot>
    /** Re-read and authenticate the existing daemon endpoint. This operation
     *  never starts or restarts a daemon. */
    refresh(expectedEndpointEpoch?: number): Promise<BackendSnapshot>
    /** Idempotent — discover existing daemon or spawn one. */
    start(): Promise<void>
    /** Send SIGTERM to the daemon via `amphi server stop`. Only call
     *  from explicit user action in the gateway settings panel. */
    stop(): Promise<void>
    restart(): Promise<void>
    openLogs(): Promise<{ ok: true; path: string } | { ok: false; reason: string }>
    /** Fetch the daemon's currently-connected clients (M1+). Returns
     *  { ok: false, reason } when the daemon is unreachable / lacks
     *  a token / rejects auth — never throws. */
    getClients(): Promise<GetClientsResult>
    /** Read the login-autostart configuration. Never throws — a missing CLI
     *  or unsupported platform comes back as { ok: false, reason }. */
    autostartStatus(): Promise<AutostartResult>
    /** Turn login autostart on/off without changing the current gateway. */
    setAutostart(enabled: boolean): Promise<AutostartResult>
    /** Restart the daemon so a freshly installed bundle takes over, then return
     *  the new snapshot. ONLY call from an explicit user action on the version
     *  mismatch screen — it disconnects every client attached to the running
     *  gateway. Never called automatically. */
    resolveCompatibility(): Promise<BackendSnapshot>
  }
  update: {
    /** Install an already-downloaded update: stop the daemon gracefully, then
     *  quit and launch the installer. Returns a typed refusal instead of
     *  throwing when nothing is staged or the daemon will not stop, leaving the
     *  downloaded update in place for a later attempt. */
    installNow(): Promise<UpdateInstallResult>
    /** Check the feed now. Returns why the check did or did not start. */
    checkNow(): Promise<UpdateCheckOutcome>
    /** Read the current updater state without waiting for an event. */
    getStatus(): Promise<UpdateStatus>
  }
  system: {
    osPrefersDark(): Promise<boolean>
    getDiagnostics(): Promise<SystemDiagnostics>
  }
  notify: {
    /** Show a native desktop notification (daemon `schedule.notify` relay).
     *  Clicking it focuses the window and deep-links to `sessionId`.
     *  `shown: false` = notifications unsupported on this platform. */
    show(payload: ShowNotificationPayload): Promise<ShowNotificationResult>
  }
  issueReport: {
    /** Ask the user for a destination and write a Markdown report there. */
    exportFile(request: IssueReportExportRequest): Promise<IssueReportExportResult>
  }
  fs: {
    /** Read ONE directory level (lazy browse), fresh from disk, async.
     *  `relBase` prefixes returned relPaths for in-place grafting. UI display
     *  only — mention resolution stays daemon-side via mount id + relPath. */
    listDir(absPath: string, relBase?: string): Promise<DirListResult>
    /** Names-only recursive search across mount roots under a time budget,
     *  scored in the main process; only ranked hits cross IPC. */
    searchDir(req: SearchDirRequest): Promise<SearchDirResult>
    /** Declarative: set the WHOLE set of session-file directories to watch for
     *  live changes. Main reconciles its non-recursive watchers to match and
     *  pushes `events.onFsChanged` per changed dir. Empty array = watch none. */
    setWatchDirs(paths: string[]): Promise<void>
    /** Write the content directly to `<workspace_root>/.work/.build/task.md`
     *  (the user manually editing the requirements spec). Main strictly validates
     *  the path before writing and rejects anything out of bounds. */
    writeFile(absPath: string, content: string): Promise<void>
    /** Write an exported Workflow package to the path chosen in the native save dialog. */
    writeWorkflowArchive(absPath: string, content: Uint8Array): Promise<void>
    /** Write an exported Workflow Run ZIP to the path chosen in the native save dialog. */
    writeWorkflowRunArchive(absPath: string, content: Uint8Array): Promise<void>
  }
  events: {
    onDeepLink(callback: (url: string) => void): () => void
    onAutoUpdate(callback: (event: AutoUpdateEvent) => void): () => void
    onAgentEvent(callback: (payload: AgentEventPayload) => void): () => void
    onBackendState(callback: (snapshot: BackendSnapshot) => void): () => void
    onSettingsChanged(callback: (next: GuiSettings) => void): () => void
    onSystemThemeChanged(callback: (osPrefersDark: boolean) => void): () => void
    /** Native host entered or left the visible, focused foreground state. */
    onWindowForegroundChanged(callback: (foreground: boolean) => void): () => void
    /** Native host window entered or left OS full screen. */
    onWindowFullScreenChanged(callback: (fullScreen: boolean) => void): () => void
    onWindowCloseRequested(callback: (req: WindowCloseRequest) => void): () => void
    onEmbeddedBrowserChanged(callback: (snapshot: EmbeddedBrowserSnapshot) => void): () => void
    /** A watched session-file directory changed on disk — re-read that level. */
    onFsChanged(callback: (event: FsChangedEvent) => void): () => void
  }
}

declare global {
  interface Window {
    api: ElectronAPI
    /** Startup-only capability exposed by preload to the trusted top-level
     * renderer. It is absent in plain-browser previews and child frames. */
    __localResourceToken__?: string
  }
}

export {}
