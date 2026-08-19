/**
 * Shared independently collapsible heading for one ordered process section.
 * Workflow steps and Build stages keep their domain-specific grouping logic in
 * ProcessTimeline while sharing the same status, spacing, and collapse affordance.
 */
import { useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Collapse } from './Collapse'
import { Icons } from './Icons'

interface TimelineStageSectionProps {
  testIdPrefix: 'workflow-stage' | 'build-stage'
  eyebrow: string
  title: string
  status: 'neutral' | 'running' | 'success' | 'failure'
  summary?: string | null
  children: ReactNode
}

/** Render one stable process heading whose content can be folded independently. */
export function TimelineStageSection({
  testIdPrefix,
  eyebrow,
  title,
  status,
  summary,
  children,
}: TimelineStageSectionProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(true)
  const running = status === 'running'
  const failed = status === 'failure'
  let icon = Icons.workflow(12)
  let tone = 'bg-status-info-bg text-status-info'
  if (status === 'success') {
    icon = Icons.check(12)
    tone = 'bg-status-success-bg text-status-success'
  } else if (failed) {
    icon = Icons.x(12)
    tone = 'bg-status-error-bg text-status-error'
  }

  return (
    <section className="min-w-0" data-testid={`${testIdPrefix}-section`}>
      <button
        type="button"
        aria-expanded={open}
        data-testid={`${testIdPrefix}-header`}
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full min-w-0 items-center gap-2.5 py-0.5 text-left text-xs leading-5"
      >
        <span
          className={cn(
            'flex shrink-0 text-text-tertiary transition-transform duration-300 ease-out group-hover:text-text-secondary',
            open && 'rotate-90',
          )}
        >
          {Icons.chevronRight(12)}
        </span>
        <span
          className={cn(
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full',
            tone,
            running && 'animate-pulse',
          )}
        >
          {icon}
        </span>
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-medium text-text-secondary">{eyebrow}</span>
          <span className="truncate font-medium text-text-primary">{title}</span>
        </span>
        <span className="shrink-0 text-xs text-text-tertiary group-hover:text-text-secondary">
          {open ? t('timeline.collapse') : t('timeline.expand')}
        </span>
      </button>
      <Collapse open={open}>
        <div
          className="ml-[21px] mt-2.5 flex flex-col gap-3.5 border-l border-border-subtle pl-[21px] pb-1"
          data-testid={`${testIdPrefix}-content`}
        >
          {summary ? (
            <div className={cn('text-xs leading-5 text-text-tertiary', failed && 'text-status-error')}>
              {summary}
            </div>
          ) : null}
          {children}
        </div>
      </Collapse>
    </section>
  )
}
