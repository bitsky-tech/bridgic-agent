/**
 * The shared skeleton of a center-column page (Workflows, Skills, Schedules,
 * My Assets): title block on the left, actions on the right, an optional filter
 * row, then the scrolling body.
 *
 * Written because the four pages had drifted on every measurement, and the drift
 * was visible: switching between them moved the content baseline. The body's top
 * padding alone had three values (20px / 16px / an 18px one-off that bypassed
 * the scale), and Schedules aligned its header with items-start while the other
 * three used items-center.
 *
 * The one rule with a condition in it: the body sits 20px below the header when
 * there is no filter row, and 16px when there is. Not a compromise — a single
 * fixed number would make the filtered pages push their content noticeably
 * lower, since the filter row and its own gap come first. Equal *total* space
 * from title to content is what makes the pages feel identical while switching.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export function CenterPageLayout({
  title,
  subtitle,
  actions,
  filters,
  children,
}: {
  title: ReactNode
  subtitle?: ReactNode
  actions?: ReactNode
  filters?: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-8 pt-5 flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-text-primary m-0">{title}</h2>
          {subtitle ? <p className="text-sm text-text-secondary mt-1">{subtitle}</p> : null}
        </div>
        {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
      </div>

      {filters ? <div className="px-8 pt-4">{filters}</div> : null}

      <div className={cn('flex-1 overflow-auto px-8 pb-8', filters ? 'pt-4' : 'pt-5')}>
        {children}
      </div>
    </div>
  )
}
