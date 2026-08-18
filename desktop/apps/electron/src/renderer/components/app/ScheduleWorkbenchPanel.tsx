import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  insertScheduleTemplateInCurrentSessionAtom,
  openScheduleSessionAtom,
} from '@/atoms/schedule-session'
import {
  deleteScheduleAtom,
  hydrateSchedulesAtom,
  runScheduleNowAtom,
  schedulesAtom,
  toggleScheduleAtom,
} from '@/atoms/schedules'
import { activeSessionIdAtom, sessionCompletionSeqByIdAtom } from '@/atoms/sessions'
import { Icons } from '@/components/amphi/Icons'
import { describeCron } from '@/lib/cron'
import { cn } from '@/lib/cn'
import { ScheduleStatus, type Schedule } from '@/lib/schedule'
import { ScheduleTemplateMode } from '@/lib/scheduleTemplate'
import {
  WorkbenchScopeButtons,
  WorkbenchSearchField,
  WorkbenchToolHeader,
  WorkbenchToolScrollArea,
  WorkbenchToolSurface,
} from './WorkbenchToolPrimitives'

type ScheduleFilter = 'all' | 'active' | 'paused'

/** Independent schedule manager embedded in the Session workbench. */
export function ScheduleWorkbenchPanel({ active = true }: { active?: boolean }) {
  const { t } = useTranslation()
  const schedules = useAtomValue(schedulesAtom)
  const sessionId = useAtomValue(activeSessionIdAtom)
  const completionSeqById = useAtomValue(sessionCompletionSeqByIdAtom)
  const hydrateSchedules = useSetAtom(hydrateSchedulesAtom)
  const openScheduleSession = useSetAtom(openScheduleSessionAtom)
  const insertScheduleTemplate = useSetAtom(insertScheduleTemplateInCurrentSessionAtom)
  const [filter, setFilter] = useState<ScheduleFilter>('all')
  const [query, setQuery] = useState('')
  const [hydrated, setHydrated] = useState(false)
  const completionSeq = sessionId ? completionSeqById[sessionId] ?? 0 : 0

  useEffect(() => {
    if (!active) return
    let current = true
    void hydrateSchedules().then(() => {
      if (current) setHydrated(true)
    })
    return () => {
      current = false
    }
  }, [active, completionSeq, hydrateSchedules])

  const activeCount = schedules.filter((schedule) => !schedule.paused).length
  const pausedCount = schedules.length - activeCount
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const visibleSchedules = useMemo(() => schedules
    .filter((schedule) => {
      if (filter === 'active') return !schedule.paused
      if (filter === 'paused') return schedule.paused
      return true
    })
    .filter((schedule) => !normalizedQuery || [schedule.name, schedule.desc]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))), [
    filter,
    normalizedQuery,
    schedules,
  ])

  const editScheduleTemplate = (schedule: Schedule) => {
    // The destination draft gets its rail-only default from
    // useCollapseNewSessionWorkbench; collapsing here would overwrite the
    // source Session's remembered open state before the switch.
    openScheduleSession({ mode: ScheduleTemplateMode.Edit, schedule })
  }

  let content: ReactNode
  if (active && !hydrated && schedules.length === 0) {
    content = <PanelState kind="loading" text={t('asset.common.loading')} />
  } else if (visibleSchedules.length === 0) {
    content = normalizedQuery
      ? <PanelState kind="no-match" text={t('session.workbench.schedules.noMatch', { query: query.trim() })} />
      : <PanelState kind="empty" text={t('schedule.empty.title')} detail={t('schedule.empty.desc')} />
  } else {
    content = (
      <div className="flex flex-col gap-2" data-testid="schedule-workbench-list">
        {visibleSchedules.map((schedule) => (
          <ScheduleWorkbenchCard
            key={schedule.id}
            schedule={schedule}
            onEdit={editScheduleTemplate}
          />
        ))}
      </div>
    )
  }

  return (
    <WorkbenchToolSurface testId="schedule-workbench-tool">
      <WorkbenchToolHeader
        actions={(
          <button
            aria-label={t('schedule.action.create')}
            className="inline-flex h-8 w-8 items-center justify-center rounded-md text-entity-schedule hover:bg-entity-schedule-bg"
            data-testid="schedule-workbench-create"
            onClick={() => insertScheduleTemplate()}
            title={t('schedule.action.create')}
            type="button"
          >
            {Icons.plus(15)}
          </button>
        )}
        icon={Icons.clock(17)}
        iconClassName="bg-entity-schedule-bg text-entity-schedule"
        testId="workbench-schedules-header"
        title={t('session.workbench.schedules.title')}
      />
      <div className="shrink-0 px-3 pt-3">
        <WorkbenchSearchField
          clearLabel={t('rightPanel.clearSearchAria')}
          query={query}
          onQueryChange={setQuery}
          searchPlaceholder={t('session.workbench.schedules.searchPlaceholder')}
        />
      </div>
      <div className="shrink-0 px-3 pt-2">
        <WorkbenchScopeButtons
          ariaLabel={t('session.workbench.schedules.filterAria')}
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: t('schedule.filter.all'), count: schedules.length },
            { value: 'active', label: t('schedule.filter.active'), count: activeCount },
            { value: 'paused', label: t('schedule.filter.paused'), count: pausedCount },
          ]}
        />
      </div>
      <WorkbenchToolScrollArea>{content}</WorkbenchToolScrollArea>
    </WorkbenchToolSurface>
  )
}

function PanelState({ detail, kind, text }: {
  detail?: string
  kind: 'empty' | 'loading' | 'no-match'
  text: string
}) {
  return (
    <div
      className="flex min-h-40 flex-col items-center justify-center px-4 text-center"
      data-kind={kind}
      data-testid="schedule-workbench-state"
      role="status"
    >
      <p className="text-xs font-medium leading-5 text-text-secondary">{text}</p>
      {detail ? <p className="mt-1 max-w-64 text-xs leading-5 text-text-tertiary">{detail}</p> : null}
    </div>
  )
}

function ScheduleWorkbenchCard({
  onEdit,
  schedule,
}: {
  onEdit: (schedule: Schedule) => void
  schedule: Schedule
}) {
  const { t } = useTranslation()
  const runNow = useSetAtom(runScheduleNowAtom)
  const toggle = useSetAtom(toggleScheduleAtom)
  const deleteSchedule = useSetAtom(deleteScheduleAtom)
  // The workbench is an inventory of schedules, not an approval inbox. Keep the
  // compact status focused on whether the schedule is active, running or paused.
  let status: ScheduleStatus = ScheduleStatus.Active
  if (schedule.running) status = ScheduleStatus.Running
  else if (schedule.paused) status = ScheduleStatus.Paused
  const cronText = useMemo(() => describeCron(schedule.cron, t), [schedule.cron, t])

  return (
    <article
      className="min-w-0 rounded-lg border border-border-subtle bg-bg-elevated p-3"
      data-testid={`schedule-workbench-${schedule.id}`}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          aria-hidden="true"
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-entity-schedule-bg text-entity-schedule"
        >
          {Icons.clock(16)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <h3 className="min-w-0 break-words text-sm font-semibold leading-5 text-text-primary">
              {schedule.name}
            </h3>
            <ScheduleStatusBadge status={status} />
          </div>
          {schedule.desc ? (
            <p className="mt-0.5 line-clamp-2 break-words text-xs leading-5 text-text-secondary">
              {schedule.desc}
            </p>
          ) : null}
        </div>
      </div>
      <div className="mt-2 flex min-w-0 items-center gap-1.5 text-xs text-text-tertiary">
        <span aria-hidden="true" className="shrink-0">{Icons.refresh(12)}</span>
        <span className="min-w-0 truncate text-text-secondary" title={cronText}>{cronText}</span>
      </div>
      <div className="mt-1 grid min-w-0 grid-cols-1 gap-0.5 text-xs leading-4 text-text-tertiary min-[440px]:grid-cols-2 min-[440px]:gap-2">
        <span className="min-w-0 truncate" title={schedule.lastRun}>
          {t('schedule.row.lastRun')}<span className="font-mono">{schedule.lastRun}</span>
        </span>
        <span className="min-w-0 truncate" title={schedule.nextRun}>
          {t('schedule.row.nextRun')}<span className="font-mono">{schedule.nextRun}</span>
        </span>
      </div>
      <div className="mt-2 flex min-w-0 flex-wrap items-center justify-end gap-1 border-t border-border-subtle pt-2">
        <button
          aria-label={t('schedule.action.runNow')}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md bg-brand-blue px-2 text-xs font-semibold text-white hover:opacity-90"
          data-testid={`schedule-workbench-run-${schedule.id}`}
          onClick={() => void runNow(schedule.id)}
          type="button"
        >
          {Icons.play(11)}
          <span>{t('schedule.action.runNow')}</span>
        </button>
        <ScheduleIconButton
          label={t('schedule.action.edit')}
          testId={`schedule-workbench-edit-${schedule.id}`}
          onClick={() => onEdit(schedule)}
        >
          {Icons.edit(13)}
        </ScheduleIconButton>
        <ScheduleIconButton
          label={schedule.paused ? t('schedule.action.resume') : t('schedule.action.pause')}
          testId={`schedule-workbench-toggle-${schedule.id}`}
          onClick={() => void toggle(schedule.id)}
        >
          {schedule.paused ? Icons.play(12) : Icons.stop(11)}
        </ScheduleIconButton>
        <ScheduleIconButton
          danger
          label={t('common.delete')}
          testId={`schedule-workbench-delete-${schedule.id}`}
          onClick={() => void deleteSchedule(schedule.id)}
        >
          {Icons.trash(13)}
        </ScheduleIconButton>
      </div>
    </article>
  )
}

function ScheduleStatusBadge({ status }: { status: ScheduleStatus }) {
  const { t } = useTranslation()
  const label = t(`schedule.status.${status}`)
  let dotClassName = 'bg-status-success'
  let className = 'bg-status-success-bg text-status-success'
  if (status === ScheduleStatus.Running) {
    dotClassName = 'animate-pulse bg-status-info'
    className = 'bg-status-info-bg text-status-info'
  } else if (status === ScheduleStatus.Paused) {
    dotClassName = 'bg-status-warning'
    className = 'bg-status-warning-bg text-status-warning'
  }
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-2xs font-semibold', className)}
      data-schedule-status={status}
    >
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', dotClassName)} />
      {label}
    </span>
  )
}

function ScheduleIconButton({
  children,
  danger = false,
  label,
  onClick,
  testId,
}: {
  children: ReactNode
  danger?: boolean
  label: string
  onClick: () => void
  testId: string
}) {
  return (
    <button
      aria-label={label}
      className={cn(
        'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-bg-hover',
        danger ? 'text-status-error hover:bg-status-error-bg' : 'text-text-secondary hover:text-text-primary',
      )}
      data-testid={testId}
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}
