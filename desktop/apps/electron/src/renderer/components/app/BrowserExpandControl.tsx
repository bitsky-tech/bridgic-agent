/**
 * Browser expansion control with an optional horizontal-overflow reminder.
 */
import { useEffect, useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Tooltip } from '@/components/amphi/Tooltip'
import { cn } from '@/lib/cn'

/** Inputs for the Browser expansion action and its optional coachmark. */
export interface BrowserExpandControlProps {
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onReminderDismiss: () => void
  reminderId: string | null
}

const OVERFLOW_COACHMARK_DURATION_MS = 6_000

/** Render the Browser expansion action and its nearby one-shot reminder. */
export function BrowserExpandControl({
  expanded,
  onExpandedChange,
  onReminderDismiss,
  reminderId,
}: BrowserExpandControlProps) {
  const { t } = useTranslation()
  const reminder = t('session.browser.overflowReminder')
  const reminderAction = t('session.browser.overflowReminderAction')
  const reminderAnnouncement = t('session.browser.overflowReminderAnnouncement')
  const reminderDismiss = t('session.browser.overflowReminderDismiss')
  const label = t(expanded ? 'session.browser.restoreSidebar' : 'session.browser.expand')
  const tooltip = reminderId
    ? t('session.browser.overflowReminderTooltip')
    : label
  const reminderDescriptionId = useId()
  const [collapsedReminderId, setCollapsedReminderId] = useState<string | null>(null)
  const coachmarkVisible = reminderId !== null && collapsedReminderId !== reminderId

  useEffect(() => {
    if (!coachmarkVisible || !reminderId) return
    const timer = window.setTimeout(() => {
      setCollapsedReminderId(reminderId)
    }, OVERFLOW_COACHMARK_DURATION_MS)
    return () => window.clearTimeout(timer)
  }, [coachmarkVisible, reminderId])

  return (
    <div className="relative flex h-7 w-7 shrink-0 items-center justify-center">
      {coachmarkVisible ? (
        <div
          data-testid="browser-overflow-reminder"
          className="absolute right-[calc(100%+8px)] top-1/2 z-20 flex h-8 -translate-y-1/2 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border-default bg-bg-elevated px-2.5 shadow-md animate-fade motion-reduce:animate-none"
        >
          <span aria-hidden="true" className="size-1.5 rounded-full bg-brand-blue" />
          <span
            id={reminderDescriptionId}
            className="text-xs font-normal text-text-secondary"
          >
            {reminder}
          </span>
          <button
            type="button"
            data-testid="browser-overflow-reminder-action"
            onClick={() => onExpandedChange(true)}
            className="rounded px-0.5 text-xs font-semibold text-text-accent hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40"
          >
            {reminderAction}
          </button>
          <button
            type="button"
            aria-label={reminderDismiss}
            data-testid="browser-overflow-reminder-dismiss"
            onClick={onReminderDismiss}
            className="flex size-5 items-center justify-center rounded text-text-tertiary hover:bg-bg-hover hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-blue/40"
          >
            <CloseIcon />
          </button>
          <span
            aria-hidden="true"
            className="absolute -right-1 top-1/2 size-2 -translate-y-1/2 rotate-45 border-r border-t border-border-default bg-bg-elevated"
          />
        </div>
      ) : null}
      {coachmarkVisible ? (
        <span className="sr-only" role="status" aria-live="polite">
          {reminderAnnouncement}
        </span>
      ) : null}
      <Tooltip content={tooltip}>
        <button
          type="button"
          aria-label={label}
          aria-describedby={coachmarkVisible ? reminderDescriptionId : undefined}
          aria-pressed={expanded}
          data-testid="browser-toggle-expanded"
          onClick={() => onExpandedChange(!expanded)}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary',
            reminderId && 'bg-accent-blue-subtle text-text-accent ring-1 ring-inset ring-brand-blue/20',
          )}
        >
          <ExpandIcon expanded={expanded} size={15} />
          {reminderId && !coachmarkVisible ? (
            <span
              aria-hidden="true"
              data-testid="browser-overflow-reminder-indicator"
              className="absolute -right-0.5 -top-0.5 size-1.5 rounded-full border border-bg-app bg-brand-blue"
            />
          ) : null}
        </button>
      </Tooltip>
    </div>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
      <path d="m3.25 3.25 5.5 5.5m0-5.5-5.5 5.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  )
}

function ExpandIcon({ expanded, size }: { expanded: boolean; size: number }) {
  return expanded ? (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M6.5 2.5v4h-4M9.5 13.5v-4h4M6.5 6.5L2.5 2.5M9.5 9.5l4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M2.5 6.5v-4h4M13.5 9.5v4h-4M6.5 2.5l-4 4M9.5 13.5l4-4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
