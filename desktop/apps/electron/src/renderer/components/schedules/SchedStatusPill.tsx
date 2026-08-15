/**
 * Scheduled-task status pill — needs action / running / paused / enabled.
 *
 * Driven by the status derived by lib/schedule.ts::getScheduleStatus; shared by the list row (ScheduleRow) and the detail header
 * (ScheduleDetail). §1.24: return different JSX early per status. §LS1: color only, no ring/glow.
 */
import { cn } from '@/lib/cn'
import { useTranslation } from 'react-i18next'
import { ScheduleStatus } from '@/lib/schedule'
import { Icons } from '@/components/amphi'

export interface SchedStatusPillProps {
  status: ScheduleStatus
  /** The number of pending needsAction items (when >1 the label is suffixed with · N). */
  count?: number
}

const PILL_BASE = 'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold'

/** Render the status pill in the color matching the schedule status. */
export function SchedStatusPill({ status, count = 0 }: SchedStatusPillProps) {
  const { t } = useTranslation()
  if (status === ScheduleStatus.NeedsAction) {
    return (
      <span className={cn(PILL_BASE, 'text-status-warning bg-status-warning-bg')}>
        {Icons.alert(11)} {count > 1
          ? t('schedule.status.needsActionWithCount', { n: count })
          : t('schedule.status.needsAction')}
      </span>
    )
  }
  if (status === ScheduleStatus.Running) {
    return (
      <span className={cn(PILL_BASE, 'text-status-info bg-status-info-bg')}>
        <span className="w-1.5 h-1.5 rounded-full bg-status-info animate-pulse" /> {t('schedule.status.running')}
      </span>
    )
  }
  if (status === ScheduleStatus.Paused) {
    return (
      <span className={cn(PILL_BASE, 'text-status-warning bg-status-warning-bg')}>
        {Icons.stop(9)} {t('schedule.status.paused')}
      </span>
    )
  }
  return (
    <span className={cn(PILL_BASE, 'text-status-success bg-status-success-bg')}>
      <span className="w-1.5 h-1.5 rounded-full bg-status-success" /> {t('schedule.status.active')}
    </span>
  )
}
