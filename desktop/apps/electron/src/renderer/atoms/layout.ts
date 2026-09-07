/**
 * Layout atoms — sidebar / right-panel width + collapse state.
 *
 * The latest widths + collapse preference are persisted in `GuiSettings.layout`.
 * While the app is running, panel width, Browser width and collapse are additionally
 * remembered per Session: switching Sessions must restore each dock's geometry
 * instead of letting one conversation overwrite every other conversation.
 * Widths are clamped in the setters so a bad drag value never reaches disk.
 *
 * `sidebarOverlayOpenAtom` is pure pointer state and never persists. The
 * per-Session right-panel families are also transient by design, matching the
 * workbench surface and expanded-Browser state in atoms/browser.ts.
 *
 * Non-obvious dep: writes only work through the Provider-bound store —
 * `getDefaultStore()` is a different store the UI never reads. Always
 * consume via hooks.
 */
import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import { RIGHT_PANEL_RAIL_WIDTH } from '@app/shared/types'
import { activeSessionIdAtom } from './sessions'
import { settingsAtom, updateSettingsAtom } from './settings'

/** Drag clamp bounds (px). Sidebar pinned to a tight 200–300 rail: floor 200
 *  keeps session labels intact, ceiling 300 stops it from stealing the center.
 *  Right panel floor 320; NO fixed ceiling. The center column has NO minimum
 *  of its own — it is pure flex remainder (window − sidebar − right). Right's
 *  upper bound is dynamic (AppLayout::rightMax) only as an anti-collapse guard
 *  so dragging right can't squeeze the center to zero. */
export const SIDEBAR_MIN = 200
export const SIDEBAR_MAX = 300
export const RIGHT_PANEL_MIN = 320
export const EXCEL_DOCK_MIN = 720
export { RIGHT_PANEL_RAIL_WIDTH }

const clamp = (v: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(v)))

/* ─── Read state ─── */

/** Current sidebar width in px. */
export const sidebarWidthAtom = atom((get) => get(settingsAtom).layout.sidebarWidth)
/** Whether the sidebar is collapsed to the floating-toggle state. */
export const sidebarCollapsedAtom = atom((get) => get(settingsAtom).layout.sidebarCollapsed)
/** Per-Session ordinary panel width. `null` inherits the persisted fallback. */
const rightPanelWidthFamily = atomFamily(
  (_sessionId: string) => atom<number | null>(null),
)

/** Per-Session Browser canvas width. `undefined` is the unremembered sentinel;
 *  `null` is a remembered "use the responsive minimum" preference. */
const browserDockWidthFamily = atomFamily(
  (_sessionId: string) => atom<number | null | undefined>(undefined),
)

/** Excel is intentionally wide and independent from ordinary panel/Browser widths. */
const excelDockWidthFamily = atomFamily(
  (_sessionId: string) => atom<number | null>(null),
)

/** Current ordinary right-surface content width in px, excluding its fixed rail. */
export const rightPanelWidthAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) {
    const remembered = get(rightPanelWidthFamily(sessionId))
    if (remembered !== null) return remembered
  }
  return get(settingsAtom).layout.rightPanelWidth
})

/** Current Browser canvas width, excluding the fixed Session surface rail. */
export const browserDockWidthAtom = atom((get): number | null => {
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) {
    const remembered = get(browserDockWidthFamily(sessionId))
    if (remembered !== undefined) return remembered
  }
  return get(settingsAtom).layout.browserPanelWidth ?? null
})

/** Current Excel canvas width, excluding the fixed Session surface rail. */
export const excelDockWidthAtom = atom((get): number => {
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) return get(excelDockWidthFamily(sessionId)) ?? EXCEL_DOCK_MIN
  return EXCEL_DOCK_MIN
})
/** Per-Session override. `null` means this Session has not been viewed yet and
 *  should inherit the persisted latest preference. */
const rightPanelCollapsedFamily = atomFamily(
  (_sessionId: string) => atom<boolean | null>(null),
)

/** User-intent collapse of the active Session's right content; the fixed rail remains visible. */
export const rightPanelCollapsedAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) {
    const remembered = get(rightPanelCollapsedFamily(sessionId))
    if (remembered !== null) return remembered
  }
  return get(settingsAtom).layout.rightPanelCollapsed
})

/** Snapshot persisted fallbacks when a Session is first viewed, before another
 *  Session can change them. Called by useRememberRightPanelState. */
export const rememberRightPanelStateAtom = atom(null, (get, set, sessionId: string) => {
  const layout = get(settingsAtom).layout
  const collapsedAtom = rightPanelCollapsedFamily(sessionId)
  if (get(collapsedAtom) === null) set(collapsedAtom, layout.rightPanelCollapsed)
  const panelWidthAtom = rightPanelWidthFamily(sessionId)
  if (get(panelWidthAtom) === null) set(panelWidthAtom, layout.rightPanelWidth)
  const browserWidthAtom = browserDockWidthFamily(sessionId)
  if (get(browserWidthAtom) === undefined) {
    set(browserWidthAtom, layout.browserPanelWidth ?? null)
  }
  const excelWidthAtom = excelDockWidthFamily(sessionId)
  if (get(excelWidthAtom) === null) set(excelWidthAtom, EXCEL_DOCK_MIN)
})

/** Pending Browser-safe collapse handoff, isolated so a switch cannot make the
 *  destination Session consume the source Session's request. */
const rightPanelCollapseRequestFamily = atomFamily(
  (_sessionId: string) => atom(false),
)

export const rightPanelCollapseRequestAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  return sessionId ? get(rightPanelCollapseRequestFamily(sessionId)) : false
})

/* ─── Write atoms ─── */

/** Flip sidebar collapsed state; also clears the hover overlay on collapse. */
export const toggleSidebarCollapsedAtom = atom(null, (get, set) => {
  const next = !get(sidebarCollapsedAtom)
  set(updateSettingsAtom, (prev) => ({
    ...prev,
    layout: { ...prev.layout, sidebarCollapsed: next },
  }))
  // Pinning open / collapsing should never leave a stale hover panel up.
  set(sidebarOverlayOpenAtom, false)
})

/** Set the right content's collapsed state without relying on a stale toggle read. */
export const setRightPanelCollapsedAtom = atom(null, (get, set, collapsed: boolean) => {
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) set(rightPanelCollapsedFamily(sessionId), collapsed)
  // Keep the persisted fallback aligned even when this Session already had the
  // requested override. The singleton draft id is reused: without this write,
  // entering it again as collapsed after an open Session would leave the fallback
  // open, and its newly materialized daemon id would inherit the wrong state.
  if (get(settingsAtom).layout.rightPanelCollapsed === collapsed) return
  set(updateSettingsAtom, (prev) => ({
    ...prev,
    layout: { ...prev.layout, rightPanelCollapsed: collapsed },
  }))
})

/** Persist and remember the active Session's ordinary panel content width. */
export const setRightPanelWidthAtom = atom(null, (get, set, width: number) => {
  const next = Math.max(RIGHT_PANEL_MIN, Math.round(width))
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) set(rightPanelWidthFamily(sessionId), next)
  if (get(settingsAtom).layout.rightPanelWidth === next) return
  set(updateSettingsAtom, (prev) => ({
    ...prev,
    layout: { ...prev.layout, rightPanelWidth: next },
  }))
})

/** Persist and remember the active Session's Browser canvas width. */
export const setBrowserDockWidthAtom = atom(null, (get, set, width: number) => {
  const next = Math.max(0, Math.round(width))
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) set(browserDockWidthFamily(sessionId), next)
  if (get(settingsAtom).layout.browserPanelWidth === next) return
  set(updateSettingsAtom, (prev) => ({
    ...prev,
    layout: { ...prev.layout, browserPanelWidth: next },
  }))
})

/** Remember the active Session's Excel canvas width for this app lifetime. */
export const setExcelDockWidthAtom = atom(null, (get, set, width: number) => {
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) set(excelDockWidthFamily(sessionId), Math.max(0, Math.round(width)))
})

/** Flip right-content collapse state. */
export const toggleRightPanelCollapsedAtom = atom(null, (get, set) => {
  const next = !get(rightPanelCollapsedAtom)
  set(setRightPanelCollapsedAtom, next)
})

/** Ask the mounted Session dock to collapse through its surface-aware handoff. */
export const requestRightPanelCollapseAtom = atom(null, (get, set) => {
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) set(rightPanelCollapseRequestFamily(sessionId), true)
})

/** Mark the current surface-aware collapse handoff as consumed or cancelled. */
export const clearRightPanelCollapseRequestAtom = atom(null, (get, set) => {
  const sessionId = get(activeSessionIdAtom)
  if (sessionId) set(rightPanelCollapseRequestFamily(sessionId), false)
})

/** Carry dock state across the draft id -> daemon Session id swap.
 *
 * The reusable draft families are reset in place instead of removed: during a
 * background materialization the renderer may still subscribe to their atom
 * instances, and atomFamily.remove() alone cannot notify those subscribers. */
export const remapRightPanelLayoutStateAtom = atom(
  null,
  (
    get,
    set,
    payload: { sourceSessionId: string; targetSessionId: string },
  ) => {
    const sourceCollapsedAtom = rightPanelCollapsedFamily(payload.sourceSessionId)
    const collapsed = get(sourceCollapsedAtom)
    if (collapsed !== null) {
      set(rightPanelCollapsedFamily(payload.targetSessionId), collapsed)
    }
    const sourcePanelWidthAtom = rightPanelWidthFamily(payload.sourceSessionId)
    const panelWidth = get(sourcePanelWidthAtom)
    if (panelWidth !== null) {
      set(rightPanelWidthFamily(payload.targetSessionId), panelWidth)
    }
    const sourceBrowserWidthAtom = browserDockWidthFamily(payload.sourceSessionId)
    const browserWidth = get(sourceBrowserWidthAtom)
    if (browserWidth !== undefined) {
      set(browserDockWidthFamily(payload.targetSessionId), browserWidth)
    }
    const sourceExcelWidthAtom = excelDockWidthFamily(payload.sourceSessionId)
    const excelWidth = get(sourceExcelWidthAtom)
    if (excelWidth !== null) set(excelDockWidthFamily(payload.targetSessionId), excelWidth)
    const sourceRequestAtom = rightPanelCollapseRequestFamily(payload.sourceSessionId)
    if (get(sourceRequestAtom)) {
      set(rightPanelCollapseRequestFamily(payload.targetSessionId), true)
    }
    set(sourceCollapsedAtom, null)
    set(sourcePanelWidthAtom, null)
    set(sourceBrowserWidthAtom, undefined)
    set(sourceExcelWidthAtom, null)
    set(sourceRequestAtom, false)
  },
)

/** Release transient dock state after a Session is deleted. */
export function purgeRightPanelLayoutState(sessionId: string): void {
  rightPanelCollapsedFamily.remove(sessionId)
  rightPanelWidthFamily.remove(sessionId)
  browserDockWidthFamily.remove(sessionId)
  excelDockWidthFamily.remove(sessionId)
  rightPanelCollapseRequestFamily.remove(sessionId)
}

/** Persist a new sidebar width (clamped). Called on drag-end. */
export const setSidebarWidthAtom = atom(null, (_get, set, width: number) => {
  set(updateSettingsAtom, (prev) => ({
    ...prev,
    layout: { ...prev.layout, sidebarWidth: clamp(width, SIDEBAR_MIN, SIDEBAR_MAX) },
  }))
})

/* ─── Transient UI state (NOT persisted) ─── */

/** Hover-reveal floating sidebar visibility while collapsed. Pointer-only. */
export const sidebarOverlayOpenAtom = atom(false)


/** Read: persisted width of the run-detail drawer (RunLogDrawer); defaults to 600 when unset. */
export const runLogDrawerWidthAtom = atom((get) => {
  const stored = get(settingsAtom).layout.runLogDrawerWidth
  return typeof stored === 'number' ? stored : 600
})

/** Write: clamp to [480, 1240] (matching RunLogDrawer's drag range) and persist. */
export const setRunLogDrawerWidthAtom = atom(null, (_get, set, width: number) => {
  const clamped = Math.min(1240, Math.max(480, width))
  set(updateSettingsAtom, (prev) => ({
    ...prev,
    layout: { ...prev.layout, runLogDrawerWidth: clamped },
  }))
})
