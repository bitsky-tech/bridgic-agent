/**
 * Windows Control Overlay (WCO) colors — on Windows, paint the native
 * minimize/maximize/close buttons into our own TopBar, eliminating the native
 * title-bar layer.
 *
 * Background: the Windows branch previously only set `autoHideMenuBar`, so the
 * window still carried a native title bar (~32px) stacked above the self-drawn
 * TopBar = two layers at the top, 32px of wasted space. Switching to
 * `titleBarStyle:'hidden'` + `titleBarOverlay` leaves only one layer, and the
 * three buttons are still drawn by the **system**, which preserves
 * high-contrast-mode support (fully self-drawn buttons would lose it).
 *
 * About Snap Layouts (the split-screen menu that pops up on maximize-hover),
 * don't treat it as a freebie:
 *   - It is a **Windows 11 exclusive** feature; it simply doesn't exist on
 *     Win10, and that has nothing to do with our implementation.
 *   - Even on Win11 it depends on Chromium returning `HTMAXBUTTON` for
 *     `WM_NCHITTEST`. Electron once broke that return value while fixing
 *     hover highlighting, and Snap Layouts stopped working entirely
 *     (electron#32360, now closed); there are also reports of the maximize
 *     button failing on external monitors (electron#35245, Electron 18–21).
 *     Worth re-checking both after an Electron upgrade.
 *
 * Compatibility itself is not a concern: WCO is drawn by Chromium itself and
 * doesn't go through the Win32 native title-bar API, so it isn't gated on a
 * particular Windows build; the floor is set by Electron (39 requires Win10+).
 *
 * Invariants:
 *   - The overlay height must match the height the TopBar **actually renders
 *     at** (the zoom-related arithmetic lives in `titlebar-metrics.ts`, which
 *     has unit tests). Forgetting to multiply by the zoom factor shows up as
 *     the top bar drifting out of alignment with the three buttons as soon as
 *     the user presses ⌘/Ctrl +/-.
 *   - `color` / `symbolColor` must be re-applied whenever the theme changes:
 *     the overlay is drawn by the **system** and ignores CSS, so switching
 *     themes without calling `setTitleBarOverlay` leaves the old palette in
 *     place (a black ✕ painted on a dark bar under the dark theme = invisible).
 *   - Every function is a no-op off win32 — macOS uses hiddenInset + traffic
 *     lights, Linux uses the default frame.
 *
 * Horizontal insetting is not in this file: the renderer's
 * `useWindowControlsInset()` measures the caption-button width from the
 * browser and writes it into `--titlebar-win-inset` (the full reasoning for
 * why it doesn't use CSS `env(titlebar-area-*)` lives there).
 *
 * Non-obvious dep: the color values come from `--bg-surface` /
 * `--text-secondary` in `renderer/styles/tokens.css`, and the two sides must
 * be kept in sync by hand (the main process can't read CSS).
 */

import { BrowserWindow, nativeTheme } from 'electron'
import { ThemeMode, type GuiSettings } from '@app/shared/types'
import { mainLog } from './logger'
import { overlayHeightFor } from './titlebar-metrics'

/** Per-theme color pairs — aligned with `--bg-surface` / `--text-secondary` in tokens.css. */
const OVERLAY_COLORS = {
  dark: { color: '#2A2A28', symbolColor: '#A8A5A0' },
  light: { color: '#FFFFFF', symbolColor: '#6B7084' },
} as const

/**
 * Whether dark is currently in effect — ask the OS when the mode is `system`,
 * otherwise use the user's explicit choice.
 *
 * Exported so `main/index.ts` can reuse it when computing the window's
 * `backgroundColor`: within one process there must be exactly one answer to
 * "are we dark right now", otherwise when ThemeMode gains a new value later
 * (e.g. auto-switching by time of day), updating one site and missing the
 * other would make the window base color and the caption-button palette
 * disagree.
 */
export function isDarkAppearance(settings: GuiSettings): boolean {
  if (settings.theme.mode === ThemeMode.System) return nativeTheme.shouldUseDarkColors
  return settings.theme.mode === ThemeMode.Dark
}

/** The `titleBarOverlay` the BrowserWindow ctor should use for the current theme + zoom; returns undefined off win32. */
export function titleBarOverlayFor(settings: GuiSettings) {
  if (process.platform !== 'win32') return undefined
  const palette = isDarkAppearance(settings) ? OVERLAY_COLORS.dark : OVERLAY_COLORS.light
  return { ...palette, height: overlayHeightFor(settings.zoomLevel) }
}

/**
 * Push the overlay config for the current theme + zoom to every live window.
 *
 * All three sources must land here: the user changing the theme, the user
 * changing the zoom (both go through `writeGuiSettings`), and the OS switching
 * light/dark on its own when mode=system (`nativeTheme`'s `updated` event).
 * Returns immediately off win32.
 */
export function applyTitleBarOverlay(settings: GuiSettings): void {
  const overlay = titleBarOverlayFor(settings)
  if (!overlay) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    // setTitleBarOverlay throws if the window was not created with
    // titleBarStyle:'hidden'; this project only has one kind of window on
    // win32, but we still guard so a single exception can't take down the
    // entire settings write.
    try {
      win.setTitleBarOverlay(overlay)
    } catch (err) {
      // Keep processing the remaining windows, but leave a trace: if we
      // swallowed this silently and some window really did miss
      // titleBarStyle:'hidden', the symptom would just be "the close button is
      // black under the dark theme" with nothing in the log — impossible to
      // diagnose (§1.3: pass the Error as an argument, don't interpolate it).
      mainLog.warn('[titlebar] setTitleBarOverlay failed', err)
    }
  }
}
