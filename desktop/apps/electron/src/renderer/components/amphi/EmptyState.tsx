/**
 * The "nothing here" panel a center page shows in place of its list.
 *
 * Two shapes, chosen by whether an icon is given:
 * - With an icon: the full empty state — a dashed circle, a heading, a line of
 *   explanation, and optionally the action that would fill the page. The dashed
 *   ring is the point: a solid tinted badge reads as a status, a dashed outline
 *   reads as an empty slot.
 * - Without one: a single centred line, for the transient "loading" / "failed"
 *   notes that are not really empty states but need the same vertical rhythm.
 *
 * This replaced four hand-rolled versions that disagreed on every axis — 44px
 * solid square vs 52px dashed circle vs no icon, py-8 vs py-12 vs py-20 vs
 * h-full centring, 13px vs 16px headings.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function EmptyState({
  icon,
  title,
  description,
  action,
  tone = 'default',
}: {
  icon?: (size?: number) => ReactNode
  title: ReactNode
  description?: ReactNode
  action?: ReactNode
  /** 'error' paints the note red; it has no effect on the full, icon-bearing shape. */
  tone?: 'default' | 'error'
}) {
  if (!icon) {
    return (
      <div
        className={cn(
          'py-12 text-center text-sm',
          tone === 'error' ? 'text-status-error' : 'text-text-tertiary',
        )}
      >
        {title}
      </div>
    )
  }
  return (
    <div className="flex flex-col items-center justify-center py-20 text-center">
      <div className="w-[52px] h-[52px] rounded-full border-[1.5px] border-dashed border-border-strong flex items-center justify-center text-text-tertiary mb-4">
        {icon(22)}
      </div>
      <div className="text-lg font-semibold text-text-primary mb-1.5">{title}</div>
      {description ? (
        <div className="text-sm text-text-secondary max-w-[340px]">{description}</div>
      ) : null}
      {action ? <div className="mt-[18px]">{action}</div> : null}
    </div>
  )
}
