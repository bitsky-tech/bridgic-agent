/**
 * Persistent top chrome bar (macOS hidden-inset style) — the fixed home for
 * the sidebar / right-panel toggles + the current conversation title.
 *
 * Layout — toggles pinned to the edges, title fills the remaining chrome:
 *   [traffic lights][◧]  ──  conversation title ⌄  ──  [◨]
 * The left zone's width tracks the docked sidebar so the title aligns to the
 * start of the center column; collapsed → the zone shrinks and the title
 * slides left. Both toggles stay pinned in place across collapse states.
 *
 * The title only shows on the Home nav in a real conversation
 * (activeNavAtom + hasConversationAtom) — never on the landing / new-chat
 * draft, and never while another nav page (schedules / workflows / …) owns the center
 * column: the active session is deliberately kept alive across nav switches,
 * so hasConversation alone would leak the title onto every page.
 * Clicking it opens the SAME rename/delete menu
 * the sidebar rows use (SessionContextDropdown); rename edits inline here
 * (the sidebar may be collapsed), delete reuses the SessionDelete modal.
 *
 * Drag invariant: the bar is `app-drag`; ONLY the interactive controls opt out
 * with `app-no-drag`, so every empty patch of the bar still drags the window.
 *
 * Controls dim when the window loses focus (useWindowFocused) so the chrome
 * blends with macOS's grayed traffic lights instead of staying vivid.
 *
 * Non-obvious dep: `--titlebar-mac-inset` / `--titlebar-win-inset` (set
 * per-platform in index.css) reserve the native window buttons' width —
 * on macOS the traffic lights are on the left, while on Windows the
 * minimize/maximize/close buttons are drawn by the Control Overlay at the
 * **right end** of this bar (see main/titlebar-overlay.ts). The right-hand
 * padding is attached to the bar's root node, keeping long conversation titles
 * away from the native window controls.
 *
 * On Windows we do not place the logo + product name here a second time — the top of
 * the sidebar (LeftSidebar) already has them, the two are less than 40px apart
 * vertically, and showing them twice only adds clutter.
 */
import { useEffect, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { activeNavAtom, ModalKind, openModalAtom, showRightPanelAtom } from '@/atoms/amphi'
import { setBrowserSurfaceBlockerAtom } from '@/atoms/browser'
import { hasConversationAtom } from '@/atoms/agent'
import {
  requestRightPanelCollapseAtom,
  rightPanelCollapsedAtom,
  setRightPanelCollapsedAtom,
  sidebarCollapsedAtom,
  sidebarWidthAtom,
  toggleSidebarCollapsedAtom,
} from '@/atoms/layout'
import { activeSessionIdAtom, activeSessionTitleAtom, renameSessionAtom } from '@/atoms/sessions'
import { sessionFocusPaneOpenAtom } from '@/atoms/session-focus-pane-view'
import { useWindowFocused } from '@/hooks/useWindowFocused'
import { useSidebarOverlayHover } from '@/hooks/useSidebarOverlayHover'
import { Icons } from './Icons'
import { NavKey } from './LeftSidebar'
import { Tooltip } from './Tooltip'
import { SessionContextDropdown } from './Overlays'

export function TopBar() {
  const { t } = useTranslation()
  const sidebarCollapsed = useAtomValue(sidebarCollapsedAtom)
  const sidebarWidth = useAtomValue(sidebarWidthAtom)
  const rightHasContent = useAtomValue(showRightPanelAtom)
  const rightCollapsed = useAtomValue(rightPanelCollapsedAtom)
  const focusPaneOpen = useAtomValue(sessionFocusPaneOpenAtom)
  const activeNav = useAtomValue(activeNavAtom)
  const hasConversation = useAtomValue(hasConversationAtom)
  const title = useAtomValue(activeSessionTitleAtom)
  const sessionId = useAtomValue(activeSessionIdAtom)
  const toggleSidebar = useSetAtom(toggleSidebarCollapsedAtom)
  const requestRightCollapse = useSetAtom(requestRightPanelCollapseAtom)
  const setRightCollapsed = useSetAtom(setRightPanelCollapsedAtom)
  const setBrowserSurfaceBlocker = useSetAtom(setBrowserSurfaceBlockerAtom)
  const openModal = useSetAtom(openModalAtom)
  const renameSession = useSetAtom(renameSessionAtom)
  const focused = useWindowFocused()
  // Collapsed-state: hovering the toggle reveals the floating sidebar overlay.
  const { open: openOverlay, scheduleClose: closeOverlay } = useSidebarOverlayHover()

  // Title context menu + inline rename — singular, local to the top bar.
  const [menuOpen, setMenuOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  // Guards the Enter/Escape → blur double-fire (same trick as SessionRow).
  const skipBlur = useRef(false)

  useEffect(() => {
    setBrowserSurfaceBlocker({ source: 'topbar-session-menu', blocked: menuOpen })
    return () => {
      setBrowserSurfaceBlocker({ source: 'topbar-session-menu', blocked: false })
    }
  }, [menuOpen, setBrowserSurfaceBlocker])

  // Dim controls on blur, matching macOS graying the native traffic lights.
  const dim = focused ? '' : 'opacity-50'
  const showTitle =
    activeNav === NavKey.Home && hasConversation && title != null && sessionId != null
  const rightContentOpen = focusPaneOpen || !rightCollapsed
  const rightToggleLabel = rightContentOpen
    ? t('topBar.collapseOutputs')
    : t('topBar.expandOutputs')

  const commitRename = (value: string) => {
    setEditing(false)
    if (sessionId != null) renameSession({ id: sessionId, title: value })
  }

  return (
    <div className="h-[var(--titlebar-height)] flex items-stretch bg-bg-surface border-b border-border-subtle flex-shrink-0 app-drag select-none pr-[var(--titlebar-win-inset)]">
      {/* Left zone — traffic-light inset + sidebar toggle. Width = sidebar
          when docked so the title aligns to the center column edge. */}
      <div
        className="flex items-center"
        style={{
          paddingLeft: 'var(--titlebar-mac-inset)',
          width: sidebarCollapsed ? undefined : sidebarWidth,
        }}
      >
        <Tooltip content={sidebarCollapsed ? t('topBar.expandSidebar') : t('topBar.collapseSidebar')}>
          <button
            type="button"
            data-testid="toggle-sidebar"
            onClick={() => toggleSidebar()}
            onMouseEnter={() => sidebarCollapsed && openOverlay()}
            onMouseLeave={() => sidebarCollapsed && closeOverlay()}
            className={cn(
              'app-no-drag p-1.5 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-opacity',
              dim,
            )}
          >
            {sidebarCollapsed ? Icons.panelLeft(18) : Icons.panelLeftFilled(18)}
          </button>
        </Tooltip>
      </div>

      {/* Center zone — current conversation title (real conversation only). */}
      <div className="flex-1 flex items-center min-w-0 px-3">
        {showTitle &&
          (editing ? (
            <input
              autoFocus
              defaultValue={title}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  skipBlur.current = true
                  commitRename(e.currentTarget.value)
                } else if (e.key === 'Escape') {
                  skipBlur.current = true
                  setEditing(false)
                }
              }}
              onBlur={(e) => {
                if (!skipBlur.current) commitRename(e.currentTarget.value)
                skipBlur.current = false
              }}
              className="app-no-drag w-[240px] max-w-full px-2 py-1 rounded-md text-sm bg-bg-app text-text-primary border border-brand-blue outline-none"
            />
          ) : (
            <div className="relative">
              <button
                type="button"
                data-testid="topbar-title"
                onClick={() => setMenuOpen((v) => !v)}
                className={cn(
                  'app-no-drag flex items-center gap-1 min-w-0 max-w-[360px] px-1.5 py-1 rounded-md text-text-primary hover:bg-bg-hover transition-opacity',
                  dim,
                )}
              >
                <span className="text-sm font-semibold truncate">{title}</span>
                <span className="text-text-tertiary flex-shrink-0">{Icons.chevronDown(14)}</span>
              </button>
              {menuOpen && (
                <>
                  {/* Click-away backdrop — closes on any outside click. */}
                  <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
                  <div className="absolute left-0 top-9 z-50 animate-enter">
                    <SessionContextDropdown
                      onRename={() => {
                        setMenuOpen(false)
                        setEditing(true)
                      }}
                      onDelete={() => {
                        setMenuOpen(false)
                        if (sessionId == null) return
                        openModal({ type: ModalKind.SessionDelete, id: sessionId, name: title })
                      }}
                    />
                  </div>
                </>
              )}
            </div>
          ))}
      </div>

      {/* Right zone — a discoverable global control for the complete Session dock.
          Collapse requests go through the dock so a native Browser can hide first. */}
      {rightHasContent && (
        <div className="flex shrink-0 items-center pr-2">
          <Tooltip content={rightToggleLabel}>
            <button
              type="button"
              data-testid="toggle-right-panel"
              aria-label={rightToggleLabel}
              aria-expanded={rightContentOpen}
              onClick={() => {
                if (rightContentOpen) requestRightCollapse()
                else setRightCollapsed(false)
              }}
              className={cn(
                'app-no-drag p-1.5 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary transition-opacity',
                dim,
              )}
            >
              {rightContentOpen ? Icons.panelRightFilled(18) : Icons.panelRight(18)}
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  )
}
