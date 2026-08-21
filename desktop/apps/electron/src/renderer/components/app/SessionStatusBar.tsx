/**
 * Skeleton of the session status bar — the **only** implementation of "how the
 * top strip is laid out" in this project.
 *
 * Build is the only Session mode with a top status rail. Workflow execution
 * reports progress in its transcript and optional right-side details pane.
 *
 * Full-density layout (**this is the entire point of this file**):
 *
 *   [left minmax(0, 1fr)]       [center auto]            [right minmax(0, 1fr)]
 *   icon+title+badge / desc      fixed-width stage rail   status
 *
 *   - The equal outer tracks keep the rail's geometric center on the status
 *     bar's center, regardless of the different widths of the identity and
 *     status content. A flex layout with two independently sized outer columns
 *     made the rail drift right as the header became wider.
 *   - The left column truncates and the right column aligns to its outer edge.
 *     Consumers switch to compact mode before either side can collide with the
 *     fixed-width rail.
 *   - **`overflow-hidden` on the outer element** is the final backstop: when
 *     the left column has truncated as far as it can and still does not fit,
 *     we would rather clip than let content overflow and cover things.
 *   - The title and badge must be `shrink-0 whitespace-nowrap`, otherwise they
 *     blow out the left column while it shrinks.
 *
 * Compact density continues to use flex because its rail is intentionally
 * shrinkable and the status column is omitted. This component is not
 * responsible for the rail's internal shape or responsive thresholds.
 */

import type { ReactNode, Ref } from 'react'
import { cn } from '@/lib/cn'
import { Icons, Tooltip } from '@/components/amphi'

/** Shared height of the Session mode status band and its aligned right-side detail header. */
export const SESSION_STATUS_BAR_HEIGHT_PX = 53

export interface SessionStatusBarProps {
  /** Main title on the left, e.g. "Workflow Build". */
  title: string
  /** Pill label to the right of the title (stage name / progress). */
  badge: ReactNode
  /** Sub-line description; auto-truncates when too wide, Tooltip only when truncated. */
  description: string
  /** Stage rail for the center column. */
  rail: ReactNode
  /** Status area on the right (dot + text); usually hidden in compact mode. */
  status?: ReactNode
  /** Compact mode: tighter horizontal padding and column gaps. */
  isCompact?: boolean
  /** Root node ref — used by consumers to measure width for responsive breakpoints. */
  rootRef?: Ref<HTMLDivElement>
  testId?: string
}

/** Session-level status bar skeleton. See the file header for the three-column flex strategy; understand why before changing it. */
export function SessionStatusBar({
  title,
  badge,
  description,
  rail,
  status,
  isCompact = false,
  rootRef,
  testId,
}: SessionStatusBarProps) {
  let density = 'full'
  let horizontalPadding = 'px-6'
  let columnGap = 'gap-5'
  if (isCompact) {
    density = 'compact'
    horizontalPadding = 'px-4'
    columnGap = 'gap-3'
  }
  return (
    <div
      ref={rootRef}
      data-testid={testId}
      data-density={density}
      style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
      className={cn(
        'relative z-20 w-full shrink-0 border-b border-border-subtle bg-bg-surface animate-focus-enter',
        horizontalPadding,
      )}
    >
      <section
        className={cn(
          'h-full min-w-0 items-center overflow-hidden',
          isCompact ? 'flex' : 'grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]',
          columnGap,
        )}
      >
        <div
          className={cn(
            'flex min-w-0 items-center gap-2.5 overflow-hidden',
            isCompact && 'flex-1',
          )}
          data-testid="session-status-identity"
        >
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[image:var(--brand-gradient)] text-white shadow-sm">
            {Icons.workflow(15)}
          </span>
          <div className="min-w-0 flex-1 overflow-hidden">
            <div className="flex min-w-0 items-center gap-2 overflow-hidden">
              <span className="min-w-0 truncate whitespace-nowrap text-sm font-semibold text-text-primary">
                {title}
              </span>
              <span
                className="shrink-0"
                data-testid="session-status-badge"
              >
                {badge}
              </span>
            </div>
            <Tooltip content={description} onlyWhenTruncated>
              <div className="mt-0.5 truncate text-xs text-text-tertiary">{description}</div>
            </Tooltip>
          </div>
        </div>

        <div
          className={cn(
            isCompact && 'flex-[1_0_auto]',
            !isCompact && 'justify-self-center',
          )}
          data-testid="session-status-rail"
        >
          {rail}
        </div>

        {!isCompact && status && (
          <div className="flex shrink-0 items-center justify-self-end gap-2" data-testid="session-status-state">
            {status}
          </div>
        )}
      </section>
    </div>
  )
}
