/**
 * Horizontal stage rail — pills of dot + stage name, strung together by fixed-width connector lines.
 *
 * The session header has two such rails (Build's four stages, Workflow run's two stages). They used to be two
 * independently evolving copies that had already drifted apart in four unintentional ways: pill padding
 * (px-2.5 / px-3), whether the pill was wrapped in a Tooltip, whether done/active styles used a helper or an
 * inline cn, and whether the transition carried ease-out. They were merged into one place, and while at it
 * unified on "the better half" of each difference (always a Tooltip, always the helper).
 *
 * Invariants:
 *   - The rail as a whole is **fixed width** and everything inside is `shrink-0`. The connector line used to be
 *     `flex-1`, so as soon as the container got wider it stretched into a long bar, pushed the stages to both
 *     ends and left a big white gap in the middle (commit 94ee44e).
 *   - Precisely because it cannot shrink, **the consumer must let it size to its content** (`flex-[1_0_auto]`,
 *     not `flex-1`). `flex-1` has a basis of 0%, so when there is not enough width that column is computed as
 *     0 wide while the rail does not shrink with it — and the whole rail overflows onto the status text and
 *     buttons on the right. When it does not fit, the consumer should degrade it (switch to the compact form)
 *     or let the title on the left absorb it via truncate, rather than letting the rail deform itself.
 *   - `current = -1` means no stage has been entered yet: everything pending, no active node.
 */

import { cn } from '@/lib/cn'
import { Icons, Tooltip } from '@/components/amphi'

/** One segment on the rail. `description` goes into the hover Tooltip and takes up no rail width. */
export interface StageRailItem {
  id: string
  label: string
  description: string
}

export interface StageRailProps {
  items: StageRailItem[]
  /** Which segment we have reached (0-based); -1 = not started. */
  current: number
  /** Whether the current segment is actively progressing — when true the active pill gets an extra pulsing dot. */
  isRunning?: boolean
}

/** Three-state colors for the numbered circle (done / active / pending). */
function getStageDotClass(isDone: boolean, isActive: boolean): string {
  if (isDone) return 'bg-brand-blue text-white'
  if (isActive) return 'bg-bg-elevated text-brand-blue border-[1.5px] border-brand-blue'
  return 'bg-stage-track text-text-tertiary'
}

/** Three-state weight/color for the stage name. */
function getStageTextClass(isDone: boolean, isActive: boolean): string {
  if (isActive) return 'font-semibold text-text-primary'
  if (isDone) return 'font-medium text-text-primary'
  return 'font-medium text-text-tertiary'
}

/** Horizontal stage rail (full form). In narrow containers the consumer decides how to degrade it — see the invariants in the file header. */
export function StageRail({ items, current, isRunning = false }: StageRailProps) {
  return (
    <div className="flex items-center justify-center">
      {items.map((item, index) => {
        const isDone = index < current
        const isActive = index === current
        return (
          <div key={item.id} className="flex items-center">
            {index > 0 && (
              <div
                className={cn(
                  'h-0.5 w-10 shrink-0 rounded-full transition-colors duration-300 ease-out',
                  isDone || isActive ? 'bg-brand-blue' : 'bg-stage-track',
                )}
              />
            )}
            <Tooltip content={item.description}>
              <div
                className={cn(
                  'flex shrink-0 items-center gap-1.5 rounded-full border border-transparent px-2.5 py-1 transition-colors duration-300 ease-out',
                  isActive && 'border-brand-blue/30 bg-accent-blue-subtle animate-stage-activate',
                )}
              >
                <span
                  className={cn(
                    'flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-bold transition-colors duration-300 ease-out',
                    getStageDotClass(isDone, isActive),
                  )}
                >
                  {isDone ? Icons.check(9) : index + 1}
                </span>
                <span
                  className={cn(
                    'whitespace-nowrap text-xs transition-colors duration-300 ease-out',
                    getStageTextClass(isDone, isActive),
                  )}
                >
                  {item.label}
                </span>
                {isActive && isRunning && (
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-blue animate-pulse" />
                )}
              </div>
            </Tooltip>
          </div>
        )
      })}
    </div>
  )
}
