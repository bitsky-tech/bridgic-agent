/**
 * 3-column app layout: top chrome bar + left sidebar (sessions/nav) +
 * center (route view) + right panel (workflow output).
 *
 * Layout owner: reads `atoms/layout.ts` directly for widths + collapse state
 * (App.tsx already reads showRightPanelAtom, so consuming layout atoms here
 * keeps the wiring in one place). Content arrives via the `left` / `center` /
 * `right` slot props.
 *
 * The conversation title and both global collapse controls live in the persistent `TopBar`.
 * The right navigation rail is part of this layout and remains mounted while
 * its content surface collapses. This component owns the columns, resize
 * handles, and the collapsed-sidebar hover overlay.
 *
 * Widths are draggable (`ResizeHandle`) and remembered per Session; the latest
 * value also remains the persisted fallback. During a drag the transient local
 * width overrides the remembered value so the IPC write fires only on mouse-up.
 *
 * `rightCollapsed` (prop) = no Session dock to show. `rightPanelCollapsedAtom`
 * (user intent) = hide only the dock content while preserving its fixed rail.
 *
 * macOS hidden-inset traffic-light inset: --titlebar-mac-inset (horizontal) is consumed by TopBar;
 * the platform marker is written to <html data-platform> by preload.
 */

import { useEffect, useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { cn } from '@/lib/cn'
import {
  RIGHT_PANEL_MIN,
  RIGHT_PANEL_RAIL_WIDTH,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
  browserDockWidthAtom,
  rightPanelCollapsedAtom,
  rightPanelWidthAtom,
  requestRightPanelCollapseAtom,
  setBrowserDockWidthAtom,
  setRightPanelWidthAtom,
  setSidebarWidthAtom,
  sidebarCollapsedAtom,
  sidebarOverlayOpenAtom,
  sidebarWidthAtom,
} from '@/atoms/layout'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { sessionFocusPaneOpenAtom } from '@/atoms/session-focus-pane-view'
import { useSidebarOverlayHover } from '@/hooks/useSidebarOverlayHover'
import { ResizeHandle } from './ResizeHandle'
import { TopBar } from './TopBar'
import { APP_PRODUCT_NAME } from '@shared/app-meta'

export interface AppLayoutProps {
  left: ReactNode
  center: ReactNode
  right?: ReactNode
  rightCollapsed?: boolean
  /** Canvas tools use a wider independent dock instead of the output-panel width. */
  rightKind?: 'panel' | 'browser' | 'presentation'
  /** An expanded canvas tool owns the complete work area beside the sidebar. */
  rightExpanded?: boolean
  /** When false, render the custom TopBar chrome (the app default). */
  titleBar?: boolean
  title?: string
}

export function AppLayout({
  left,
  center,
  right,
  rightCollapsed = false,
  rightKind = 'panel',
  rightExpanded = false,
  titleBar = true,
  title = APP_PRODUCT_NAME,
}: AppLayoutProps) {
  const sidebarWidth = useAtomValue(sidebarWidthAtom)
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const rightPanelWidth = useAtomValue(rightPanelWidthAtom)
  const browserDockWidth = useAtomValue(browserDockWidthAtom)
  const sessionId = useAtomValue(activeSessionIdAtom)
  const focusPaneOpen = useAtomValue(sessionFocusPaneOpenAtom)
  const rightUserCollapsed = useAtomValue(rightPanelCollapsedAtom)
  const persistSidebarWidth = useSetAtom(setSidebarWidthAtom)
  const persistRightWidth = useSetAtom(setRightPanelWidthAtom)
  const setBrowserDockWidth = useSetAtom(setBrowserDockWidthAtom)
  const requestRightCollapse = useSetAtom(requestRightPanelCollapseAtom)

  // Transient drag widths — non-null only mid-drag. Overrides the persisted
  // width so the column tracks the pointer without persisting every frame.
  const [dragSidebarW, setDragSidebarW] = useState<number | null>(null)
  const [dragRight, setDragRight] = useState<{
    sessionId: string | null
    kind: 'panel' | 'browser' | 'presentation'
    width: number | null
  }>({ sessionId, kind: rightKind, width: null })
  if (dragRight.sessionId !== sessionId || dragRight.kind !== rightKind) {
    setDragRight({ sessionId, kind: rightKind, width: null })
  }

  // Window width (external-system sync, §1.17 compliant): the right column's maximum draggable width must be recomputed live as the window changes.
  const [winW, setWinW] = useState(() => window.innerWidth)
  useEffect(() => {
    const onResize = () => setWinW(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const effectiveSidebarW = dragSidebarW ?? sidebarWidth
  // Center-column floor: the right column can only be dragged until "the center column has exactly CENTER_MIN left", never narrower. So
  // the right column's dynamic upper bound = window width − sidebar footprint (0 when collapsed) − CENTER_MIN, then clamped into [MIN, MAX].
  const sidebarUsed = sidebarCollapsed ? 0 : effectiveSidebarW
  // The center column has no minimum width of its own — it is simply the flex remainder (window − sidebar − right column). The right column has
  // no fixed upper bound: it can keep being dragged wider while the center column narrows accordingly. rightMax is only the "do not squeeze the
  // center to 0" backstop (the right column can be dragged until the center still has RIGHT_PANEL_MIN); it also clamps when the window shrinks or a persisted value is too large.
  const panelMin = RIGHT_PANEL_MIN + RIGHT_PANEL_RAIL_WIDTH
  const rightMax = Math.max(panelMin, winW - sidebarUsed - RIGHT_PANEL_MIN)
  const availableWorkWidth = Math.max(0, winW - sidebarUsed)
  const dragRightW = dragRight.sessionId === sessionId && dragRight.kind === rightKind
    ? dragRight.width
    : null
  const preferredBrowserContentWidth = dragRightW === null
    ? browserDockWidth
    : Math.max(0, dragRightW - RIGHT_PANEL_RAIL_WIDTH)
  const browserGeometry = browserDockGeometry(availableWorkWidth, preferredBrowserContentWidth)
  const isCanvasDock = rightKind === 'browser' || rightKind === 'presentation'
  const effectiveRightW = isCanvasDock
    ? browserGeometry.width
    : Math.min(dragRightW ?? rightPanelWidth + RIGHT_PANEL_RAIL_WIDTH, rightMax)
  const effectiveRightMin = isCanvasDock ? browserGeometry.min : panelMin
  const effectiveRightMax = isCanvasDock ? browserGeometry.max : rightMax

  // Session context controls whether the dock exists; user collapse controls
  // only its content. Focused mode panes temporarily force that content open.
  const showRightDock = !rightCollapsed && Boolean(right)
  const rightContentOpen = focusPaneOpen || !rightUserCollapsed
  const shownRightW = rightContentOpen ? effectiveRightW : RIGHT_PANEL_RAIL_WIDTH
  const shownRightMin = rightContentOpen ? effectiveRightMin : RIGHT_PANEL_RAIL_WIDTH
  const expandRight = rightExpanded && showRightDock && rightContentOpen
  const resizingRight = dragRightW !== null
  const rightStageW = expandRight ? null : effectiveRightW

  const persistDockWidth = (totalWidth: number) => {
    if (isCanvasDock) {
      setBrowserDockWidth(Math.max(0, totalWidth - RIGHT_PANEL_RAIL_WIDTH))
    } else {
      persistRightWidth(totalWidth - RIGHT_PANEL_RAIL_WIDTH)
    }
  }

  return (
    <div className="w-full h-full flex flex-col bg-bg-app font-sans overflow-hidden">
      {titleBar ? (
        <div className="h-11 flex items-center bg-bg-surface border-b border-border-subtle flex-shrink-0 app-drag">
          <div className="app-no-drag flex-shrink-0" style={{ width: 'var(--titlebar-mac-inset)' }} />
          <div className="flex-1 text-center text-sm text-text-secondary font-medium px-4 pointer-events-none select-none">
            {title}
          </div>
          <div className="app-no-drag flex-shrink-0" style={{ width: 'var(--titlebar-mac-inset)' }} />
        </div>
      ) : (
        <TopBar />
      )}

      <div className="flex-1 flex overflow-hidden" data-browser-layout-root>
        {!sidebarCollapsed && (
          <div
            className="relative flex flex-col bg-bg-surface border-r border-border-subtle"
            style={{ width: effectiveSidebarW, minWidth: SIDEBAR_MIN }}
          >
            {left}
            <ResizeHandle
              side="left"
              width={sidebarWidth}
              min={SIDEBAR_MIN}
              max={SIDEBAR_MAX}
              onResize={setDragSidebarW}
              onCommit={(w) => {
                setDragSidebarW(null)
                persistSidebarWidth(w)
              }}
            />
          </div>
        )}

        {/* Center column = the flex remainder (window − sidebar − right column), with no minimum width of its own; min-w-0 lets it
            keep shrinking as the right column is dragged wider, and the content is clipped by overflow-hidden. */}
        <div className={cn(
          'relative flex-1 min-w-0 flex flex-col overflow-hidden bg-bg-app',
          expandRight && 'hidden',
        )}>
          {center}
          {sidebarCollapsed && <CollapsedSidebarOverlay sidebarWidth={sidebarWidth}>{left}</CollapsedSidebarOverlay>}
        </div>

        {showRightDock && (
          <div
            data-testid="session-right-dock"
            data-browser-dock
            data-content-open={rightContentOpen}
            className={cn(
              'relative flex flex-col bg-bg-surface',
              !expandRight && rightContentOpen && 'border-l border-border-strong/60',
              expandRight && 'flex-1 min-w-0',
              !expandRight && !resizingRight
                && 'transition-[width,min-width] duration-200 ease-out motion-reduce:transition-none',
            )}
            style={expandRight ? undefined : { width: shownRightW, minWidth: shownRightMin }}
          >
            <div
              className="absolute inset-0 overflow-hidden"
              data-browser-dock-clip
              data-testid="session-right-dock-clip"
            >
              <div
                className={cn(
                  'absolute inset-y-0 right-0 flex flex-col',
                  expandRight && 'left-0 min-w-0',
                )}
                style={rightStageW === null
                  ? undefined
                  : { width: rightStageW, minWidth: rightStageW }}
                data-testid="session-right-dock-stage"
              >
                {right}
              </div>
            </div>
            {/* Handle renders AFTER content (mirrors the left side) so DOM
                order keeps it on top — z-index alone proved insufficient. */}
            {!expandRight && rightContentOpen && (
              <ResizeHandle
                key={`${sessionId ?? 'no-session'}:${rightKind}`}
                side="right"
                width={effectiveRightW}
                min={effectiveRightMin}
                max={effectiveRightMax}
                collapseOvershoot={RIGHT_PANEL_COLLAPSE_OVERSHOOT}
                onResize={(width) => setDragRight({ sessionId, kind: rightKind, width })}
                onCommit={(w) => {
                  setDragRight({ sessionId, kind: rightKind, width: null })
                  persistDockWidth(w)
                }}
                onCollapse={(minimumWidth) => {
                  setDragRight({ sessionId, kind: rightKind, width: null })
                  persistDockWidth(minimumWidth)
                  requestRightCollapse()
                }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export const BROWSER_DOCK_MIN = 520
export const BROWSER_DOCK_COMPACT_MIN = 240
export const BROWSER_CENTER_MIN = 420
export const RIGHT_PANEL_COLLAPSE_OVERSHOOT = 24

/** Resolve the responsive browser dock without squeezing a narrow window to zero. */
export function browserDockGeometry(
  availableWidth: number,
  preferredContentWidth: number | null,
): { width: number; min: number; max: number } {
  const available = Math.max(0, Math.round(availableWidth))
  const compactCenter = Math.min(
    BROWSER_CENTER_MIN,
    Math.max(160, Math.round(available * 0.4)),
  )
  const max = Math.max(Math.min(BROWSER_DOCK_COMPACT_MIN, available), available - compactCenter)
  const min = Math.min(BROWSER_DOCK_MIN + RIGHT_PANEL_RAIL_WIDTH, max)
  const preferred = (preferredContentWidth ?? BROWSER_DOCK_MIN)
    + RIGHT_PANEL_RAIL_WIDTH
  return { width: Math.min(max, Math.max(min, preferred)), min, max }
}

/**
 * Collapsed-sidebar hover overlay: a left-edge hot strip that slides the full
 * sidebar over the center as a floating panel (the docked sidebar and this
 * overlay are never mounted at once, so SidebarContainer's effects don't
 * double-fire). Pinning open/closed is the TopBar toggle's job — this is the
 * transient hover preview only.
 *
 * No-flicker model: the strip (lower z) opens the overlay; the overlay's own
 * mouse-leave closes it. Moving strip → overlay never crosses out of a
 * tracked region.
 */
function CollapsedSidebarOverlay({
  sidebarWidth,
  children,
}: {
  sidebarWidth: number
  children: ReactNode
}) {
  const overlayOpen = useAtomValue(sidebarOverlayOpenAtom)
  const { open, scheduleClose } = useSidebarOverlayHover()

  return (
    <>
      <div className="absolute left-0 top-0 bottom-0 w-3 z-10" onMouseEnter={open} />
      {overlayOpen && (
        <div
          onMouseEnter={open}
          onMouseLeave={scheduleClose}
          className={cn(
            'absolute left-0 top-0 bottom-0 z-30 flex flex-col',
            'bg-bg-surface border-r border-border-subtle shadow-md',
          )}
          style={{ width: sidebarWidth }}
        >
          {children}
        </div>
      )}
    </>
  )
}
