/**
 * Left sidebar — fixed-width (240px) primary navigation.
 *
 * Logo + "new session" button at top, nav items below (workflows / assets — these
 * swap the CENTER column, not the sidebar), then the session list (always
 * visible). The bottom strip is two rows:
 *   1. Gateway control — status dot · "Gateway" + version · restart · stop
 *      (start when daemon is stopped). Clicking the label opens Settings →
 *      Gateway tab. Replaces the old gear-with-dot pill that buried daemon
 *      lifecycle behind a settings icon.
 *   2. Utility row — global feedback · approval bell · settings gear. The
 *      optional avatar/name area also opens Settings (Model tab when daemon
 *      is running, Gateway otherwise). Theme switching lives inside the
 *      Settings → Appearance tab, not on this strip — keeps the bottom
 *      compact and routes all preference changes through one surface.
 *
 * State is owned by the App via atoms/amphi — this component is purely
 * presentational. Refactored to Tailwind className per §1.22.
 */

import { useAtomValue } from 'jotai'
import { Flag } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { backendStateAtom } from '@/atoms/backend'
import { BackendState } from '../../../main/python-client/types'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import { Tooltip } from './Tooltip'
import { WindowedList } from './WindowedList'
import { SettingsTabId } from './Modals'
import { BridgicLogo, Btn, Divider } from './Primitives'
import { SessionRow } from './SessionRow'
import type { AgentStatusIndicatorSpec } from './AgentStatusIndicator'
import { APP_PRODUCT_NAME } from '@shared/app-meta'
import { NavKey as NavigationNavKey } from '@/atoms/navigation'
import type { NavKey as NavigationKey } from '@/atoms/navigation'

/**
 * Top-level sidebar nav slot. Typed-const so the renderer can compare
 * with `NavKey.Home` rather than the raw `'home'` literal — the same
 * keys flow into `activeNavAtom` (atoms/amphi.ts).
 */
export const NavKey = NavigationNavKey
export type NavKey = NavigationKey

export interface SessionItem {
  id: string
  title: string
  stage?: string
  hasRedDot?: boolean
  /** A parked Child interaction awaits the user (independent of the unread dot). */
  hasPendingInteraction?: boolean
  /** Specific interaction shown by the pending marker, if known. */
  pendingInteractionLabel?: string
  /** This Session currently has an in-flight Agent turn. */
  isRunning?: boolean
  /** Exact lifecycle marker for states not represented by the ordinary Session flags. */
  statusIndicator?: AgentStatusIndicatorSpec
  /** Blocking/RPC Child marker that must remain visible on the parent row. */
  foregroundChildStatusIndicator?: AgentStatusIndicatorSpec
  /** Background Child marker shown on its row or beside the collapsed child count. */
  backgroundChildStatusIndicator?: AgentStatusIndicatorSpec
  children?: SessionItem[]
}

export interface LeftSidebarProps {
  sessions?: SessionItem[]
  activeSessionId?: string | null
  activeNav?: NavKey
  onNewSession?: () => void
  onSelectSession?: (id: string) => void
  /** Commit a new title for a session (inline-rename from the ⋯ menu). */
  onRenameSession?: (id: string, title: string) => void
  /** Request deletion of a session (the ⋯ menu opens the confirm modal). */
  onDeleteSession?: (id: string) => void
  onSelectNav?: (nav: NavKey) => void
  /**
   * Open the settings modal. Optional `initialTab` lets callers (e.g. the
   * gateway status dot) jump straight to a non-default pane.
   */
  onOpenSettings?: (initialTab?: SettingsTabId) => void
  /** Number of pending approvals (schedule feature); when >0 the bell in the user row shows a badge. */
  pendingCount?: number
  /** Clicking the bell → open the approval center. */
  onBell?: () => void
  /** Open a global renderer issue report without attaching conversation context. */
  onFeedback?: () => void
}

const navItems: { id: Exclude<NavKey, typeof NavKey.Home>; icon: (s?: number) => JSX.Element; labelKey: string }[] = [
  { id: NavKey.Workflows, icon: Icons.workflow, labelKey: 'sidebar.nav.workflows' },
  { id: NavKey.Skills, icon: Icons.terminal, labelKey: 'sidebar.nav.skills' },
  { id: NavKey.Schedules, icon: Icons.clock, labelKey: 'sidebar.nav.schedules' },
  { id: NavKey.Assets, icon: Icons.folder, labelKey: 'sidebar.nav.assets' },
]

export function LeftSidebar({
  sessions = [],
  activeSessionId = null,
  activeNav = NavKey.Home,
  onNewSession,
  onSelectSession,
  onRenameSession,
  onDeleteSession,
  onSelectNav,
  onOpenSettings,
  pendingCount = 0,
  onBell,
  onFeedback,
}: LeftSidebarProps) {
  const { t } = useTranslation()
  // Singular-across-the-list interaction state: at most one row's ⋯ menu is
  // open, and at most one row is in inline-rename mode. Per-row hover lives
  // inside SessionRow.
  const [menuForId, setMenuForId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [collapsedSessionIds, setCollapsedSessionIds] = useState<Set<string>>(new Set())
  // Backend state decides where the user row's click lands: the Gateway tab
  // when the daemon is not ready, the default (Model) tab otherwise.
  const backendState = useAtomValue(backendStateAtom)
  const isRunning = backendState === BackendState.Ready
  const renderSession = (session: SessionItem, depth = 0): JSX.Element => {
    const active = activeNav === NavKey.Home && activeSessionId === session.id
    const children = session.children ?? []
    const expanded = !collapsedSessionIds.has(session.id)
    return (
      <div key={session.id}>
        <SessionRow
          session={session}
          active={active}
          depth={depth}
          childCount={children.length}
          expanded={expanded}
          menuOpen={menuForId === session.id}
          editing={editingId === session.id}
          onSelect={() => onSelectSession?.(session.id)}
          onToggleChildren={() => {
            setCollapsedSessionIds((current) => {
              const next = new Set(current)
              if (next.has(session.id)) next.delete(session.id)
              else next.add(session.id)
              return next
            })
          }}
          onOpenMenu={() => setMenuForId(session.id)}
          onCloseMenu={() => setMenuForId(null)}
          onStartRename={() => setEditingId(session.id)}
          onCommitRename={(title) => {
            setEditingId(null)
            const nextTitle = title.trim()
            if (nextTitle && nextTitle !== session.title) onRenameSession?.(session.id, nextTitle)
          }}
          onCancelRename={() => setEditingId(null)}
          onDelete={() => onDeleteSession?.(session.id)}
        />
        {children.length > 0 && expanded && (
          <div className="ml-3 border-l border-border-subtle pl-1">
            {children.map((child) => renderSession(child, depth + 1))}
          </div>
        )}
      </div>
    )
  }
  const handleOpenUserSettings = () => {
    const tab = isRunning ? SettingsTabId.Model : SettingsTabId.Gateway
    onOpenSettings?.(tab)
  }

  return (
    <>
      {/* Logo + new-session button */}
      <div className="pt-3 px-3 pb-1">
        <div className="flex items-center gap-2 mb-3 px-1">
          <BridgicLogo size={22} />
          <span className="text-sm font-bold text-text-primary tracking-[-0.2px]">{APP_PRODUCT_NAME}</span>
        </div>
        <Btn
          data-testid="new-session"
          onClick={onNewSession}
          variant="primary"
          size="md"
          className="w-full justify-center"
        >
          {Icons.plus(14)} {t('sidebar.newSession')}
        </Btn>
      </div>

      {/* Nav items — these change the CENTER content, not the sidebar itself */}
      <div className="pt-2 px-2 flex flex-col gap-px">
        {navItems.map((m) => {
          const active = activeNav === m.id
          return (
            <div
              key={m.id}
              data-testid={`nav-${m.id}`}
              onClick={() => onSelectNav?.(m.id)}
              className={cn(
                'flex items-center gap-2.5 px-2.5 py-[7px] rounded-md cursor-pointer',
                active ? 'bg-bg-hover text-text-primary' : 'bg-transparent text-text-secondary',
              )}
            >
              <span className={cn('flex items-center flex-shrink-0', active ? 'opacity-100' : 'opacity-60')}>
                {m.icon(16)}
              </span>
              <span className={cn('flex-1 text-sm', active ? 'font-semibold' : 'font-normal')}>{t(m.labelKey)}</span>
              <span className="text-text-tertiary opacity-50">{Icons.chevronRight(14)}</span>
            </div>
          )
        })}
      </div>

      <Divider style={{ margin: '6px 12px' }} />

      {/* Session list label */}
      <div className="px-2">
        <div className="flex items-center justify-between px-1.5 pt-1 pb-1.5">
          <span className="text-xs font-semibold text-text-tertiary uppercase tracking-[0.5px]">{t('sidebar.sessions')}</span>
          <span className="text-[10px] text-text-tertiary">{sessions.length}</span>
        </div>
      </div>

      {/* Session list — always visible. Root rows are DOM-windowed (heavy
          users accumulate hundreds of sessions); children render with their
          parent row, so expanding is never chunked mid-tree. */}
      <div className="flex-1 overflow-auto px-2">
        <WindowedList items={sessions}>
          {(session) => renderSession(session)}
        </WindowedList>
      </div>

      {/* Bottom: gateway control row + user/theme row.
          The old layout merged the gateway status dot onto the settings
          gear; users couldn't tell daemon state was clickable. This
          two-row layout promotes the gateway to a first-class strip
          (status · version · restart · stop) while keeping settings
          accessible through the user-row click. */}
      <div className="border-t border-border-subtle">
        {/* The gateway strip (status · version · restart · stop) used to live
            here and is deliberately not rendered: daemon lifecycle is plumbing,
            not something a user should be asked to reason about on the main
            surface. `GatewayRow` is kept intact and self-contained — restoring
            the row is putting `<GatewayRow onOpenSettings={onOpenSettings} />`
            back on this line. Cost of hiding it: this was the only one-click
            restart; Settings → Gateway still offers stop/start in two clicks. */}

        {/* Utility row — global feedback stays visible on the left; the
            approval bell and settings gear stay aligned on the right. */}
        <div className="flex items-center gap-2.5 px-3 py-2.5">
          <Tooltip content={t('sidebar.feedback')}>
            <button
              type="button"
              data-testid="sidebar-feedback"
              aria-label={t('sidebar.feedback')}
              onClick={onFeedback}
              className="flex-1 min-w-0 h-7 px-1.5 rounded-md flex items-center gap-1.5 text-xs font-medium text-text-tertiary cursor-pointer hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40"
            >
              <Flag size={16} strokeWidth={1.6} className="flex-shrink-0" aria-hidden="true" />
              <span className="truncate">{t('sidebar.feedback')}</span>
            </button>
          </Tooltip>
          {/* Approval-center bell: shows a badge and turns a warm color when pendingCount>0. */}
          <Tooltip content={t('sidebar.approvalCenter')}>
            <button
              type="button"
              data-testid="approval-bell"
              onClick={onBell}
              className={cn(
                'relative w-7 h-7 rounded-md flex items-center justify-center cursor-pointer hover:bg-bg-hover flex-shrink-0',
                pendingCount > 0 ? 'text-status-warning' : 'text-text-tertiary',
              )}
            >
              {Icons.bell(16)}
              {pendingCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full bg-status-warning text-white text-[9px] font-bold flex items-center justify-center leading-none">
                  {pendingCount}
                </span>
              )}
            </button>
          </Tooltip>
          <Tooltip content={t('sidebar.settings')}>
            <button
              type="button"
              data-testid="open-settings-gear"
              aria-label={t('sidebar.settings')}
              onClick={handleOpenUserSettings}
              className="p-1.5 rounded cursor-pointer text-text-tertiary hover:bg-bg-hover hover:text-text-primary flex-shrink-0"
            >
              {Icons.settings(16)}
            </button>
          </Tooltip>
        </div>
      </div>
    </>
  )
}
