/**
 * GuiSettings persistence + broadcast.
 *
 * Single source of truth for everything UI-side that needs to survive
 * a restart. Stored as one whole JSON blob at
 * `~/.bridgic/amphi/gui-settings.json` (path resolved via `paths.ts ::
 * amphiUserFile`).
 *
 * Loaded SYNCHRONOUSLY by `main/index.ts` before any BrowserWindow is
 * constructed so the first frame uses the persisted bounds and theme:
 *
 *     const settings = loadGuiSettingsSync()
 *     // → use settings.window.bounds + maximized for BrowserWindow ctor
 *     // → base64-encode the blob into webPreferences.additionalArguments
 *     //   so the renderer's atom seeds correctly on first paint.
 *
 * Reads fail silently to DEFAULT_SETTINGS — a corrupted file must
 * never prevent the GUI from booting. Writes are atomic via tmp →
 * rename so a mid-write crash leaves either the old or the new blob
 * intact, never a partial corrupt file.
 */

import { app, BrowserWindow, nativeTheme } from 'electron'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  clampZoomLevel,
  type GuiSettings,
} from '@app/shared/types'
import { GUI_SETTINGS_FILE_NAME } from '../shared/app-meta'
import { IPC } from '../shared/ipc-channels'
import { resolveLocale } from '../shared/locale'
import { setMainLocale } from './i18n'
import { mainLog } from './logger'
import { amphiUserFile } from './paths'
import { applyTitleBarOverlay } from './titlebar-overlay'

let cached: GuiSettings | null = null

function settingsPath(): string {
  return amphiUserFile(GUI_SETTINGS_FILE_NAME)
}

// ────────────────────────────────────────────────────────────────────────────
// Load / write
// ────────────────────────────────────────────────────────────────────────────

/**
 * Read gui-settings.json from disk, migrate to the current version,
 * deep-merge with DEFAULT_SETTINGS to fill any gaps. Cached after
 * first successful call; subsequent reads are O(1).
 *
 * MUST be called from main/index.ts BEFORE BrowserWindow construction.
 */
export function loadGuiSettingsSync(): GuiSettings {
  if (cached) return cached
  const file = settingsPath()
  try {
    const raw = readFileSync(file, 'utf-8')
    cached = migrate(JSON.parse(raw))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') {
      mainLog.info('[gui-settings] no file yet; using defaults')
    } else {
      mainLog.warn('[gui-settings] failed to read; using defaults', err)
    }
    cached = { ...DEFAULT_SETTINGS }
  }
  return cached
}

/** Cached snapshot accessor. Returns defaults if `loadGuiSettingsSync`
 *  was never called (shouldn't happen in practice). */
export function getGuiSettings(): GuiSettings {
  return cached ?? loadGuiSettingsSync()
}

/**
 * Replace the whole blob and persist atomically (`*.tmp` + rename).
 * After write, broadcast the new snapshot to all renderer windows so
 * any subscriber atoms refresh.
 *
 * `excludeWebContentsId` — the window that ORIGINATED this write (from
 * `settings:set`). It already holds the value optimistically; echoing it back
 * only creates a chance for a late echo to roll a newer local change back.
 */
export function writeGuiSettings(next: GuiSettings, excludeWebContentsId?: number): void {
  const previousTelemetryOptIn = getGuiSettings().ui.telemetryOptIn
  const file = settingsPath()
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf-8', mode: 0o600 })
  renameSync(tmp, file)
  cached = next
  applyNativeThemeSource(next)
  applyZoomLevel(next)
  applyLocale(next)
  // Windows caption buttons are drawn by the system and ignore CSS, so the
  // palette must be explicitly re-applied whenever the theme changes, otherwise
  // a black ✕ is left behind under the dark theme (see titlebar-overlay.ts).
  // No-op off win32.
  applyTitleBarOverlay(next)
  if (previousTelemetryOptIn !== next.ui.telemetryOptIn) {
    notifyTelemetryConsentChanged(next.ui.telemetryOptIn)
  }
  broadcastSettingsChanged(next, excludeWebContentsId)
}

/**
 * Tell the OS which appearance the app's UI is using.
 *
 * Without this, `nativeTheme.themeSource` stays 'system' and macOS paints
 * native chrome (notably the INACTIVE traffic-light dots on blur) for the
 * OS appearance, not the app's — e.g. OS dark + app light renders the
 * inactive dots in dark-appearance style, invisible against our light top
 * bar (electron/electron#44034: "macOS calculates the contrast itself").
 * ThemeMode's values ('light'|'dark'|'system') match themeSource exactly.
 *
 * Called at startup (main/index.ts) and on every settings write.
 */
export function applyNativeThemeSource(settings: GuiSettings): void {
  nativeTheme.themeSource = settings.theme.mode
}

/** Redraw-on-language-change subscribers, registered by main/index.ts. */
const localeListeners: Array<() => void> = []

/**
 * Register native UI that must be rebuilt when the display language changes.
 *
 * Inverted rather than calling the tray / application menu directly: those modules already
 * depend on this one (menu items write settings), so importing them back would make this
 * the first import cycle in main. `index.ts` is the composition root and wires both ends.
 */
export function onLocaleApplied(rebuild: () => void): void {
  localeListeners.push(rebuild)
}

/** Telemetry consent subscribers, notified only after the settings file is safely persisted. */
const telemetryConsentListeners = new Set<(consented: boolean) => void>()

/**
 * Register a main-process consumer of the persisted telemetry preference.
 *
 * The initial value is intentionally not emitted; the composition root applies
 * it during startup. Subsequent callbacks run only after the atomic settings
 * rename succeeds, so a failed write can never enable collection transiently.
 */
export function onTelemetryConsentChanged(listener: (consented: boolean) => void): () => void {
  telemetryConsentListeners.add(listener)
  return () => telemetryConsentListeners.delete(listener)
}

function notifyTelemetryConsentChanged(consented: boolean): void {
  for (const listener of telemetryConsentListeners) {
    try {
      listener(consented)
    } catch (error) {
      mainLog.warn('[gui-settings] telemetry consent listener failed', error)
    }
  }
}

/**
 * Point the main process's native UI at the user's display language, and redraw what is
 * already on screen.
 *
 * Priority is the same one the renderer applies (`shared/locale.resolveLocale`): an
 * explicit `GuiSettings.locale` wins, and an empty one — the state until the user picks a
 * language — falls back to the OS. So a first launch follows the system, and every launch
 * after a manual pick reads the persisted value back.
 *
 * Redrawing matters because both native surfaces are built once and cached: the tray menu
 * is a `Menu` object handed to the OS, and the application menu is installed globally.
 * Neither re-reads its labels, so without this a language switch would leave the window
 * translated and the native chrome stuck in the previous language until the next restart.
 *
 * Called at startup (main/index.ts) and on every settings write.
 */
export function applyLocale(settings: GuiSettings): void {
  setMainLocale(resolveLocale(settings.locale, app.getLocale()))
  for (const rebuild of localeListeners) rebuild()
}

/**
 * Push the persisted zoom level onto every live window.
 *
 * Single apply point: the View-menu shortcuts and the Appearance settings row
 * BOTH just write `zoomLevel` through `writeGuiSettings`, and land here — so
 * the two entry points can never disagree, and there is exactly one place that
 * touches `webContents`. New windows seed themselves from settings at creation
 * (`window-manager.ts`), since they don't exist yet when this runs.
 *
 * Clamped defensively: a hand-edited / imported blob with `zoomLevel: 40` would
 * otherwise render the UI at a scale where nothing is clickable — including the
 * control that would undo it.
 */
export function applyZoomLevel(settings: GuiSettings): void {
  const level = clampZoomLevel(settings.zoomLevel)
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.setZoomLevel(level)
  }
}

/**
 * Step (or, with `delta === 0`, reset) the persisted zoom level.
 *
 * The single mutation path shared by all three entry points — View-menu
 * accelerators, the raw-key fallbacks in `window-manager`, and the Appearance
 * settings row. They all write `zoomLevel` and land in `writeGuiSettings`, so
 * they cannot drift apart and the change survives a restart.
 *
 * NOT `role: 'zoomIn' / 'zoomOut' / 'resetZoom'`: those mutate `webContents`
 * behind settings' back — nothing would persist, and the settings row would
 * show a stale percentage.
 */
export function stepZoomLevel(delta: number): void {
  const current = getGuiSettings()
  const next = clampZoomLevel(delta === 0 ? 0 : current.zoomLevel + delta)
  if (next === current.zoomLevel) return
  writeGuiSettings({ ...current, zoomLevel: next })
}

/**
 * Update only the `window` slice — convenience for WindowManager's
 * `close` handler, which doesn't want to clone the whole blob.
 */
export function updateWindowState(
  bounds: { x: number; y: number; width: number; height: number },
  maximized: boolean,
): void {
  const current = getGuiSettings()
  writeGuiSettings({
    ...current,
    window: { ...current.window, bounds, maximized },
  })
}

// ────────────────────────────────────────────────────────────────────────────
// Migration
// ────────────────────────────────────────────────────────────────────────────

type MigrationStep = (prev: Record<string, unknown>) => Record<string, unknown>

/** Register new migrations under their target version. */
const migrations: Record<number, MigrationStep> = {
  // 1 → 2: drop the dead `font` slice, introduce `zoomLevel`.
  // `font.family` / `font.size` were written to `--font-family` / `--font-size`
  // by useTheme but nothing consumed them (CSS reads `--font-sans`, and no rule
  // reads `--font-size`), and no UI ever exposed them. Deleting the key here —
  // rather than leaving mergeDeep to carry it along — keeps the on-disk blob
  // honest; otherwise every user file keeps a slice no code will ever read.
  2: ({ font: _font, ...rest }) => ({ ...rest, zoomLevel: 0 }),
  // 2 → 3: saved right widths now describe content only; the fixed rail is added by layout.
  // The subtrahend is frozen at the rail width v2 blobs were measured against, NOT the live
  // RIGHT_PANEL_RAIL_WIDTH: a migration restates history, so following the current constant
  // would resize every upgrading user's panel by however much the rail was later redesigned.
  3: (prev) => {
    const V2_RAIL_WIDTH = 54
    const layout = prev.layout
    if (layout === null || typeof layout !== 'object' || Array.isArray(layout)) return prev
    const nextLayout = { ...(layout as Record<string, unknown>) }
    if (typeof nextLayout.rightPanelWidth === 'number') {
      nextLayout.rightPanelWidth = Math.max(
        320,
        Math.round(nextLayout.rightPanelWidth) - V2_RAIL_WIDTH,
      )
    }
    if (typeof nextLayout.browserPanelWidth === 'number') {
      nextLayout.browserPanelWidth = Math.max(
        0,
        Math.round(nextLayout.browserPanelWidth) - V2_RAIL_WIDTH,
      )
    }
    return { ...prev, layout: nextLayout }
  },
}

/**
 * Bring a parsed settings blob to the current version, then deep-merge it onto
 * DEFAULT_SETTINGS so every gap (missing key, partial nested object) is filled.
 * Used both on disk read (`loadGuiSettingsSync`) and on file import
 * (`handlers/settings.ts`) — both ingest untrusted / older-shaped blobs that
 * must be normalized before they're persisted or broadcast.
 */
export function migrate(raw: unknown): GuiSettings {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_SETTINGS }
  let working = raw as Record<string, unknown>
  const start = typeof working.version === 'number' ? working.version : 0
  for (let v = start + 1; v <= SETTINGS_VERSION; v++) {
    const step = migrations[v]
    if (step) working = step(working)
  }
  working.version = SETTINGS_VERSION
  return mergeDeep(DEFAULT_SETTINGS, working) as GuiSettings
}

function mergeDeep<T>(base: T, override: unknown): T {
  if (override === null || typeof override !== 'object') return base
  if (Array.isArray(base)) {
    return Array.isArray(override) ? (override as unknown as T) : base
  }
  const o = override as Record<string, unknown>
  const out: Record<string, unknown> = { ...(base as object) }
  for (const key of Object.keys(o)) {
    const baseVal = (base as Record<string, unknown>)[key]
    const overVal = o[key]
    if (
      baseVal !== null &&
      typeof baseVal === 'object' &&
      !Array.isArray(baseVal) &&
      overVal !== null &&
      typeof overVal === 'object' &&
      !Array.isArray(overVal)
    ) {
      out[key] = mergeDeep(baseVal, overVal)
    } else if (overVal !== undefined) {
      out[key] = overVal
    }
  }
  return out as T
}

// ────────────────────────────────────────────────────────────────────────────
// Broadcast
// ────────────────────────────────────────────────────────────────────────────

function broadcastSettingsChanged(next: GuiSettings, excludeWebContentsId?: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.isDestroyed()) continue
    if (win.webContents.id === excludeWebContentsId) continue
    win.webContents.send(IPC.events.settingsChanged, next)
  }
}

/** Test-only — drops cached blob so the next load re-reads disk. */
export function _resetForTests(): void {
  cached = null
}
