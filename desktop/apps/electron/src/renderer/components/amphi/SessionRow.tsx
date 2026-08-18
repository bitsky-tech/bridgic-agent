/**
 * One session row in the left sidebar — selectable, hover-reveals a ⋯ menu
 * (rename / delete), and supports inline-rename editing.
 *
 * Interaction state that must be singular across the list (which row's menu
 * is open / which row is in edit mode) is owned by LeftSidebar and passed in;
 * per-row transient state (hover, the in-flight edit draft) lives here.
 *
 * Non-obvious dep: `skipBlur` guards the Enter/Escape → blur double-fire.
 * Enter and Escape both blur the input as a side effect, which would
 * otherwise re-commit (Enter) or commit-instead-of-cancel (Escape); the ref
 * makes the trailing onBlur a no-op when the key handler already decided.
 *
 * The ⋯ trigger is ALWAYS in the layout (revealed via opacity on group-hover),
 * never conditionally mounted — mounting it on hover would grow the row height
 * (svg + padding > the text line-box) and cause a vertical jump.
 *
 * The ⋯ dropdown is portaled to `document.body` with `fixed`, viewport-relative
 * coords (computed from the trigger's rect on open) — an `absolute` menu was
 * clipped by the session list's `overflow-auto` and hidden behind the bottom
 * gateway/user strip for rows near the list's foot. It flips ABOVE the trigger
 * when there isn't room below (mirrors the Tooltip primitive's flip logic).
 */

import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import type { SessionItem } from './LeftSidebar'
import { SessionContextDropdown } from './Overlays'
import { AgentStatusIndicator } from './AgentStatusIndicator'
import type { AgentStatusIndicatorSpec } from './AgentStatusIndicator'

export interface SessionRowProps {
  session: SessionItem
  active: boolean
  depth?: number
  childCount?: number
  expanded?: boolean
  menuOpen: boolean
  editing: boolean
  onSelect: () => void
  onToggleChildren?: () => void
  onOpenMenu: () => void
  onCloseMenu: () => void
  onStartRename: () => void
  /** Commit the edited title (already includes the raw input value). */
  onCommitRename: (title: string) => void
  onCancelRename: () => void
  onDelete: () => void
}

/** ⋯ dropdown geometry: MENU_WIDTH matches Overlays.SessionContextDropdown's `w-[170px]`;
 *  used when portaling the menu as fixed, to compute viewport coordinates from the trigger point and to decide whether there is enough room below (flipping up when there is not). */
const MENU_WIDTH = 170
const MENU_HEIGHT = 90
const MENU_GAP = 4

/** The menu's viewport coordinates relative to the trigger point + whether it flips upward (not enough room below). */
interface MenuPos {
  left: number
  top: number
  up: boolean
}

/** Derive the ⋯ menu's fixed coordinates from the trigger element's viewport rect: the right edge aligns with the trigger, below by default,
 *  flipping above when it does not fit below (`up` → rendering adds `-translate-y-full` so the bottom edge lands on top). */
function computeMenuPos(rect: DOMRect): MenuPos {
  const up = window.innerHeight - rect.bottom < MENU_HEIGHT + MENU_GAP
  return {
    left: rect.right - MENU_WIDTH,
    top: up ? rect.top - MENU_GAP : rect.bottom + MENU_GAP,
    up,
  }
}

export function SessionRow({
  session,
  active,
  depth = 0,
  childCount = 0,
  expanded = true,
  menuOpen,
  editing,
  onSelect,
  onToggleChildren,
  onOpenMenu,
  onCloseMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: SessionRowProps) {
  const { t } = useTranslation()
  const skipBlur = useRef(false)
  // ⋯ menu coordinates: computed from the trigger's rect when the menu opens, then portaled as fixed (escaping the list's overflow clipping).
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null)
  useEffect(() => {
    if (!menuOpen) return
    // The fixed menu's coordinates are computed only once on open; any scroll container scrolling or window resize would make them stale.
    // Like Tooltip, just close it, so the menu never "floats" at its old position.
    const closeMenu = (): void => onCloseMenu()
    window.addEventListener('scroll', closeMenu, true)
    window.addEventListener('resize', closeMenu)
    return () => {
      window.removeEventListener('scroll', closeMenu, true)
      window.removeEventListener('resize', closeMenu)
    }
  }, [menuOpen, onCloseMenu])

  if (editing) {
    return (
      <div className="px-2 py-[5px]">
        <input
          autoFocus
          defaultValue={session.title}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              skipBlur.current = true
              onCommitRename(e.currentTarget.value)
            } else if (e.key === 'Escape') {
              skipBlur.current = true
              onCancelRename()
            }
          }}
          onBlur={(e) => {
            if (!skipBlur.current) onCommitRename(e.currentTarget.value)
          }}
          className="w-full px-2 py-[5px] rounded-md text-sm bg-bg-app text-text-primary border border-brand-blue outline-none"
        />
      </div>
    )
  }

  const foregroundChildStatus = session.foregroundChildStatusIndicator
  const backgroundChildStatus = session.backgroundChildStatusIndicator
  const foregroundStatusIsProminent =
    foregroundChildStatus?.indicator === 'attention' ||
    foregroundChildStatus?.indicator === 'failed'
  const backgroundStatusIsProminent =
    backgroundChildStatus?.indicator === 'attention' ||
    backgroundChildStatus?.indicator === 'failed'
  let projectedChildStatus: AgentStatusIndicatorSpec | undefined
  if (foregroundStatusIsProminent) {
    projectedChildStatus = foregroundChildStatus
  } else if (childCount === 0 && backgroundStatusIsProminent) {
    projectedChildStatus = backgroundChildStatus
  }
  const waitingForInteraction =
    session.hasPendingInteraction ||
    session.statusIndicator?.indicator === 'attention' ||
    projectedChildStatus?.indicator === 'attention'

  return (
    <div
      data-testid={`session-${session.id}`}
      onClick={onSelect}
      className={cn(
        'group flex items-center gap-2 px-2 py-[9px] rounded-md cursor-pointer relative',
        active ? 'bg-bg-selected' : 'bg-transparent',
      )}
    >
      {depth > 0 && (
        <span className="flex shrink-0 text-text-tertiary">{Icons.robot(13)}</span>
      )}
      {session.isRunning && !waitingForInteraction && (
        <AgentStatusIndicator indicator="spinner" label={t('session.row.agentRunning')} />
      )}
      {session.hasRedDot && (
        <AgentStatusIndicator indicator="completed" label={t('session.row.newCompletedContent')} />
      )}
      {/* Pending-interaction marker is orthogonal to the unread dot. */}
      {session.hasPendingInteraction && (
        <AgentStatusIndicator
          indicator="attention"
          label={session.pendingInteractionLabel ?? t('session.row.awaitingAnswer')}
        />
      )}
      {session.statusIndicator && (
        <AgentStatusIndicator {...session.statusIndicator} />
      )}
      {projectedChildStatus && (
        <AgentStatusIndicator {...projectedChildStatus} />
      )}
      <div className="flex-1 min-w-0">
        <div
          className={cn(
            'text-sm text-text-primary truncate',
            active ? 'font-medium' : 'font-normal',
          )}
        >
          {session.title}
        </div>
        {session.stage && <div className="text-xs text-text-accent mt-0.5">{session.stage}</div>}
      </div>
      {childCount > 0 && (
        <button
          type="button"
          aria-label={expanded ? t('session.row.collapseChildren') : t('session.row.expandChildren')}
          onClick={(event) => {
            event.stopPropagation()
            onToggleChildren?.()
          }}
          className="flex shrink-0 items-center gap-0.5 text-2xs text-text-tertiary hover:text-text-secondary"
        >
          {!expanded && backgroundChildStatus && (
            <AgentStatusIndicator {...backgroundChildStatus} />
          )}
          <span>{childCount}</span>
          <span className={cn('transition-transform', !expanded && '-rotate-90')}>
            {Icons.chevronDown(12)}
          </span>
        </button>
      )}
      <div
        data-testid={`session-menu-trigger-${session.id}`}
        onClick={(e) => {
          e.stopPropagation()
          setMenuPos(computeMenuPos(e.currentTarget.getBoundingClientRect()))
          onOpenMenu()
        }}
        className={cn(
          // `flex items-center` collapses the svg's inline baseline gap so the
          // trigger box hugs the 16px icon; always-rendered + opacity keeps the
          // row height constant (no hover jump).
          'flex items-center text-text-tertiary p-0.5 cursor-pointer flex-shrink-0 hover:text-text-primary transition-opacity',
          menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
        )}
      >
        {Icons.dots(16)}
      </div>
      {menuOpen &&
        menuPos &&
        // Portal to body so `fixed` coords escape the session list's overflow-auto
        // clip (an absolute menu was hidden behind the bottom gateway/user strip).
        createPortal(
          <>
            {/* Click-away backdrop — closes the menu on any outside click. */}
            <div
              className="fixed inset-0 z-40"
              onClick={(e) => {
                e.stopPropagation()
                onCloseMenu()
              }}
            />
            <div
              className={cn(
                'fixed z-50',
                // The upward flip uses the pure-opacity animate-fade (to avoid animate-enter's translateY
                // overriding the -translate-y-full positioning); downward has no translate, so animate-enter slides it in.
                menuPos.up ? 'animate-fade -translate-y-full' : 'animate-enter',
              )}
              style={{ left: menuPos.left, top: menuPos.top }}
              onClick={(e) => e.stopPropagation()}
            >
              <SessionContextDropdown
                onRename={() => {
                  onCloseMenu()
                  onStartRename()
                }}
                onDelete={() => {
                  onCloseMenu()
                  onDelete()
                }}
              />
            </div>
          </>,
          document.body,
        )}
    </div>
  )
}
