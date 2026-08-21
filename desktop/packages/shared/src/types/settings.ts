/**
 * GuiSettings — everything the renderer wants persisted, in one shape.
 *
 * Lives at `~/.bridgic/amphi/gui-settings.json` (path centralized in
 * `apps/electron/src/main/paths.ts` :: amphiUserFile). Loaded
 * **synchronously** by main before any BrowserWindow construction so
 * the renderer's first frame is already correctly themed / sized
 * (zero FOUC).
 *
 * Boundary rules:
 *   - Anything in this file is GUI-only: theme, layout, window, UI
 *     preferences. Daemon never reads it.
 *   - Conversely, daemon-owned state (sessions, messages, model
 *     configs, API keys, MCP servers) MUST NOT be added here.
 *
 * Version is bumped whenever the shape changes; `gui-settings.ts ::
 * migrate` carries old blobs forward. Adding a new field with a
 * default does NOT require a version bump (loader merges defaults).
 */

export const SETTINGS_VERSION = 3
/** Persistent Session dock rail excluded from saved content widths since v3. */
export const RIGHT_PANEL_RAIL_WIDTH = 68

/**
 * UI zoom — the semantics of Electron's `webContents.setZoomLevel`: 0 = 100%,
 * each +1 level magnifies by 1.2x (`factor = 1.2 ** level`).
 *
 * The step is 0.5 rather than 1: `1.2 ** 0.5 ≈ 1.095`, which matches the feel of a
 * browser's first 100% → 110% notch; an integer step jumps straight to 120%, far
 * too coarse for the real complaint behind it ("the text is a bit small").
 */
export const ZOOM_LEVEL_STEP = 0.5
/** Min ≈ 69%, max ≈ 207%. Going out of range makes the UI unusable, so
 *  `clampZoomLevel` catches it. */
export const ZOOM_LEVEL_MIN = -2
export const ZOOM_LEVEL_MAX = 4

/** Clamp any input (including NaN / a dirty config) into the legal zoom range. */
export function clampZoomLevel(level: number): number {
  if (!Number.isFinite(level)) return 0
  return Math.min(ZOOM_LEVEL_MAX, Math.max(ZOOM_LEVEL_MIN, level))
}

/** Zoom level → the integer percentage shown to the user (0 → 100). */
export function zoomPercent(level: number): number {
  return Math.round(1.2 ** clampZoomLevel(level) * 100)
}

/**
 * Theme appearance mode — chosen by the user or follows OS.
 * Single source of truth (was duplicated in `apps/electron/src/shared/
 * ipc-channels.ts` until M1 cleanup).
 */
export const ThemeMode = {
  Light: 'light',
  Dark: 'dark',
  System: 'system',
} as const
export type ThemeMode = (typeof ThemeMode)[keyof typeof ThemeMode]

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface GuiSettings {
  version: number

  theme: {
    /** light / dark / system (follow OS). */
    mode: ThemeMode
    /** Accent color hex. Drives `--accent` CSS variable. */
    accent: string
  }

  /**
   * UI zoom level (Electron zoomLevel semantics, 0 = 100%). The whole UI scales
   * proportionally — font size, icons and spacing together, so you never get the
   * "text grew but the container didn't follow" misalignment.
   *
   * Replaces the earlier `font: { family, size }`: those two fields were written
   * into `--font-family` / `--font-size` but nobody consumed them (the CSS uses
   * `--font-sans`, and no rule reads `--font-size` at all), and the settings panel
   * never exposed an entry point for them either — dead config through and through.
   */
  zoomLevel: number

  /** BCP-47 locale string. Empty = follow OS. */
  locale: string

  window: {
    /** Absent on first launch — main falls back to its DEFAULT_BOUNDS. */
    bounds?: WindowBounds
    maximized: boolean
  }

  layout: {
    sidebarWidth: number
    sidebarCollapsed: boolean
    /** Right-column width — the session output and the requirements-spec preview
     *  share this single value (the preview merely occupies the same right column,
     *  it has no independent width). */
    rightPanelWidth: number
    /** User-intent collapse of the right output panel (independent of
     *  whether there's content to show — see showRightPanelAtom). */
    rightPanelCollapsed: boolean
    /** Browser workbench width after the user resizes it; absent uses its minimum. */
    browserPanelWidth?: number
    /** Drag width of the run-detail drawer (RunLogDrawer); once the user has
     *  dragged it, remembered across sessions. */
    runLogDrawerWidth: number
  }

  composer: {
    /**
     * `'enter'`     — Enter sends, Shift+Enter inserts newline (default).
     * `'cmd-enter'` — Enter inserts newline, Cmd/Ctrl+Enter sends.
     */
    inputSendKey: 'enter' | 'cmd-enter'
  }

  /**
   * Double-click-to-open confirm gate. A session-file double-click opens with
   * the OS default program only after a per-key confirm the user can choose to
   * remember; these buckets hold the remembered keys (cross-session).
   */
  fileOpen: {
    /** Files WITH an extension — remembered by lowercased extension, no dot
     *  (e.g. ["txt","ts"]). One entry covers every file of that extension. */
    autoOpenExtensions: string[]
    /** Files WITHOUT an extension (and dotfiles like ".gitignore") —
     *  remembered by exact basename (e.g. ["Makefile","LICENSE"]). */
    autoOpenFilenames: string[]
  }

  notifications: {
    desktop: boolean
    sound: boolean
  }

  /**
   * Gateway (the backend daemon) connection preferences. These are
   * **client-side** choices (how do we connect?), not daemon config
   * (what does the daemon do?) — the latter lives in the daemon.
   */
  gateway: {
    /** If true, Electron calls `amphi server start` automatically on
     *  app launch when no daemon is registered. */
    autoStart: boolean
    /** Override the host/port pair the client probes. Both undefined
     *  means trust the daemon's runtime.json (default). */
    host?: string
    port?: number
  }

  ui: {
    /** Prevent the display from sleeping during long-running tasks. */
    keepAwakeEnabled: boolean
    /** Pseudonymous product-usage telemetry. On by default; users may disable it. */
    telemetryOptIn: boolean
    /** Most-recently-used model ids (UI cache; truth lives in daemon). */
    mruModels: string[]
    /** Cached id for boot-time session restore. Content fetched from
     *  daemon — this is just a quick "which one was open last". */
    lastSessionId: string | null
    /** Last selected sidebar nav slot, so reopening lands on the same view.
     *  Typed as `string` (not `NavKey`) on purpose: `NavKey` lives in the
     *  renderer (`components/amphi/LeftSidebar.tsx`) and this shared package
     *  must not depend on it. The renderer guards the value on read. */
    lastNav: string
    /** Bumped each time the intro tour ships a new step set. */
    seenIntroVersion: number
    devToolsOnStartup: boolean
  }
}

export const DEFAULT_SETTINGS: GuiSettings = {
  version: SETTINGS_VERSION,
  theme: { mode: ThemeMode.System, accent: '#3b82f6' },
  zoomLevel: 0,
  locale: '',
  window: { maximized: false },
  layout: { sidebarWidth: 240, sidebarCollapsed: false, rightPanelWidth: 320, rightPanelCollapsed: false, runLogDrawerWidth: 600 },
  composer: { inputSendKey: 'enter' },
  fileOpen: { autoOpenExtensions: [], autoOpenFilenames: [] },
  notifications: { desktop: true, sound: false },
  gateway: { autoStart: true },
  ui: {
    keepAwakeEnabled: false,
    telemetryOptIn: true,
    mruModels: [],
    lastSessionId: null,
    lastNav: 'home',
    seenIntroVersion: 0,
    devToolsOnStartup: false,
  },
}

/**
 * @deprecated `AppSettings` was the previous shape (with llmProvider /
 * llmApiKey / mcpServers / permissionDefaults baked in). Phase G
 * renamed it to `GuiSettings` and split off the daemon-owned fields
 * (they now live in the daemon). The alias keeps transitional code
 * compiling for one release — new code should `import { GuiSettings }`.
 */
export type AppSettings = GuiSettings
