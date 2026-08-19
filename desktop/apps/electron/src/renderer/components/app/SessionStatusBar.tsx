/**
 * Skeleton of the session status bar — the **only** implementation of "how the
 * top strip is laid out" in this project.
 *
 * The Build header (`FocusModeHeader`) and the Workflow run header
 * (`WorkflowRunHeader`) used to be two heavily duplicated copies. When fixing
 * "the stage rail covers the right-hand buttons", only the Workflow copy was
 * fixed (its comment spelled out the cause very clearly); the Build copy was
 * left untouched — it took two user screenshots to catch it. Once the skeleton
 * was converged there is a single place holding the layout invariants, so
 * "fix one, forget the other" cannot happen.
 *
 * Three-column layout and each column's flex strategy (**this is the entire
 * point of this file**):
 *
 *   [left flex-1 min-w-0]     [center flex-[1_0_auto]]   [right shrink-0]
 *   icon+title+badge / desc    stage rail (fixed width)   status + buttons
 *
 *   - **The center column MUST be `flex-[1_0_auto]`, never `flex-1`**.
 *     `flex-1` has a basis of 0%, and flex-shrink is weighted by basis — a
 *     basis of 0 does not participate in shrinking, it only claims "leftover
 *     space", so under pressure it is computed as 0 wide. Everything inside
 *     the rail is `shrink-0 whitespace-nowrap`, so the whole rail overflows
 *     and covers the status text and buttons on the right (in the user's
 *     screenshots "④Validate" sat on top of "Building", and the compact rail's
 *     "2/4" sat on top of "Collapse" — both are this one cause).
 *   - **The left column absorbs the leftover** (`flex-1 min-w-0` plus internal
 *     truncate). The rail is fixed content: if it does not fit, the only
 *     option is to degrade it; the title is elastic content with truncate as a
 *     fallback — so the title is what should give way. It used to be the other
 *     way round: the title got a fixed basis (28rem) and the rail took the
 *     leftover, which is exactly why the rail got squeezed away.
 *   - **`overflow-hidden` on the outer element** is the final backstop: when
 *     the left column has truncated as far as it can and still does not fit,
 *     we would rather clip than let content overflow and cover things.
 *   - The title and badge must be `shrink-0 whitespace-nowrap`, otherwise they
 *     blow out the left column while it shrinks.
 *
 * Not responsible for: the shape of the stage rail and its degradation (passed
 * in by the consumer via `rail`; Build swaps in a compact rail in narrow
 * containers), or the content and open/closed state of right-column detail panes.
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
  /** Narrow mode: preserve only the title and rail; the rail owns progress. */
  isNarrow?: boolean
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
  isNarrow = false,
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
  if (isNarrow) {
    density = 'narrow'
    horizontalPadding = 'px-3'
    columnGap = 'gap-2'
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
          'flex h-full min-w-0 items-center overflow-hidden',
          columnGap,
        )}
      >
        <div
          className="flex min-w-0 flex-1 items-center gap-2.5 overflow-hidden"
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
                className={cn('shrink-0', isNarrow && 'hidden')}
                data-testid="session-status-badge"
              >
                {badge}
              </span>
            </div>
            {!isNarrow && (
              <Tooltip content={description} onlyWhenTruncated>
                <div className="mt-0.5 truncate text-xs text-text-tertiary">{description}</div>
              </Tooltip>
            )}
          </div>
        </div>

        <div
          className={cn(isNarrow ? 'shrink-0 overflow-hidden' : 'flex-[1_0_auto]')}
          data-testid="session-status-rail"
        >
          {rail}
        </div>

        {!isCompact && status && (
          <div className="flex shrink-0 items-center gap-2" data-testid="session-status-state">
            {status}
          </div>
        )}
      </section>
    </div>
  )
}
