/**
 * One row of the schedule list — icon + name/status + frequency/binding + last/next run + inline actions.
 *
 * A business component: clicking the row opens the detail; the inline actions (handle it / run now / edit / pause-resume / delete) are
 * triggered directly through atoms (useSetAtom) rather than prop-drilled from above. "Edit" goes through a real pre-filled new session
 * (openScheduleSessionAtom); "handle it" opens the run-record drawer.
 */
import { memo, useMemo } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { describeCron } from '@/lib/cron'
import { getScheduleStatus, ScheduleStatus, type Schedule } from '@/lib/schedule'
import { Btn, Card, Icons, Tooltip } from '@/components/amphi'
import {
  deleteScheduleAtom,
  runScheduleNowAtom,
  openScheduleDetailAtom,
  toggleScheduleAtom,
} from '@/atoms/schedules'
import { openScheduleSessionAtom } from '@/atoms/schedule-session'
import { ScheduleTemplateMode } from '@/lib/scheduleTemplate'
import { SchedStatusPill } from './SchedStatusPill'
import { SchedTime } from './SchedTime'

export interface ScheduleRowProps {
  s: Schedule
}

/** One row of the schedule list: the row opens the detail, and inline actions are triggered directly through atoms.
 *  memo: when the list re-renders as a whole (hydrate/filtering), a row only re-renders when its own `s` reference changes. */
export const ScheduleRow = memo(function ScheduleRow({ s }: ScheduleRowProps) {
  const { t } = useTranslation()
  const openDetail = useSetAtom(openScheduleDetailAtom)
  const openSession = useSetAtom(openScheduleSessionAtom)
  const toggle = useSetAtom(toggleScheduleAtom)
  const del = useSetAtom(deleteScheduleAtom)
  const runNow = useSetAtom(runScheduleNowAtom)

  // The list page does not show the "running" status (schedule-level running is unreliable, and the user does not need it) — a running
  // schedule is shown as active; the run detail then shows precisely, per session, whether each run is executing (#2).
  // cron → human-readable description is pure parsing, but re-running it on every re-render is pointless — cache it by the cron string.
  const cronText = useMemo(() => describeCron(s.cron, t), [s.cron, t])
  const rawStatus = getScheduleStatus(s)
  const st = rawStatus === ScheduleStatus.Running ? ScheduleStatus.Active : rawStatus
  const skillCount = s.skills.length
  const wfCount = s.nlWorkflows?.length ?? 0
  const bindingText = wfCount
    ? t('schedule.row.bindingsWithWorkflows', { skillCount, wfCount })
    : t('schedule.row.bindings', { skillCount })

  return (
    <Card
      data-testid={`schedule-row-${s.id}`}
      onClick={() => openDetail(s.id)}
      className="px-[18px] py-3.5 flex items-center gap-3.5 cursor-pointer hover:bg-bg-hover transition-colors"
    >
      <div className="w-10 h-10 rounded-md flex-shrink-0 flex items-center justify-center bg-accent-purple-subtle text-text-accent-purple">
        {Icons.clock(18)}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-md font-semibold text-text-primary">{s.name}</span>
          <SchedStatusPill status={st} count={s.needsAction} />
        </div>
        <div className="flex items-center gap-2 mt-1.5">
          <span className="inline-flex items-center gap-1.5 text-sm text-text-secondary">
            {Icons.refresh(12)} {cronText}
          </span>
          <span className="w-[3px] h-[3px] rounded-full bg-text-tertiary" />
          <span className="text-xs text-text-tertiary">{bindingText}</span>
        </div>
        <div className="flex items-center gap-4 mt-1.5">
          <span className="text-xs text-text-tertiary">
            {t('schedule.row.lastRun')}<SchedTime value={s.lastRun} />
          </span>
          <span
            className={cn('text-xs', st === ScheduleStatus.Active ? 'text-text-accent' : 'text-text-tertiary')}
          >
            {t('schedule.row.nextRun')}<SchedTime value={s.nextRun} />
          </span>
        </div>
      </div>

      {/* Inline actions: kept consistent with the buttons at the top of the detail page (#6). Propagation is stopped so the row does not also open the detail. */}
      <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
        <Btn variant="primary" size="xs" onClick={() => runNow(s.id)}>
          {Icons.play(11)} {t('schedule.action.runNow')}
        </Btn>
        <Btn variant="default" size="xs" onClick={() => openSession({ mode: ScheduleTemplateMode.Edit, schedule: s })}>
          {Icons.edit(12)} {t('schedule.action.edit')}
        </Btn>
        <Btn variant="default" size="xs" onClick={() => toggle(s.id)}>
          {s.paused ? (
            <>
              {Icons.play(11)} {t('schedule.action.resume')}
            </>
          ) : (
            <>
              {Icons.stop(10)} {t('schedule.action.pause')}
            </>
          )}
        </Btn>
        <Tooltip content={t('common.delete')}>
          <button
            type="button"
            onClick={() => void del(s.id)}
            className="w-7 h-7 rounded-md flex items-center justify-center text-status-error cursor-pointer hover:bg-status-error-bg"
          >
            {Icons.trash(15)}
          </button>
        </Tooltip>
      </div>
    </Card>
  )
})
