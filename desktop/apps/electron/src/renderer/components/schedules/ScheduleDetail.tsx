/**
 * Scheduled-task detail page — config summary + run history (wired to real data from the daemon).
 *
 * Rendered by CenterView, which passes in the matched schedule, when activeNav===Schedules and scheduleDetailId is set.
 * Actions (run now / edit / pause-resume / delete) are triggered through atoms; clicking a run opens the run detail drawer on the right
 * (openRunDrawerAtom → RunLogDrawer): it reuses the session message rendering, and its interaction is independent of chat (it does not jump to Home),
 * with AWAITING answered inline inside the drawer. The dashboard stats were removed as the backend has no aggregation yet (real aggregation is deferred to Phase 6).
 */
import { useEffect } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { describeCron } from '@/lib/cron'
import { getPendingRun, getScheduleStatus, RunStatus, ScheduleStatus, type Schedule } from '@/lib/schedule'
import { Btn, Card, Icons, Tooltip } from '@/components/amphi'
import {
  deleteScheduleAtom,
  killScheduleAtom,
  openRunDrawerAtom,
  openScheduleDetailAtom,
  runScheduleNowAtom,
  closeScheduleDetailAtom,
  stopScheduleRunAtom,
  toggleScheduleAtom,
} from '@/atoms/schedules'
import { continueFromRunAtom, openScheduleSessionAtom } from '@/atoms/schedule-session'
import { ScheduleTemplateMode } from '@/lib/scheduleTemplate'
import { SchedStatusPill } from './SchedStatusPill'
import { SchedTime } from './SchedTime'
import { ConfigRow, RunHistoryRow } from './ScheduleDetailParts'

export interface ScheduleDetailProps {
  s: Schedule
}

/** Scheduled-task detail page: config summary + run history. */
export function ScheduleDetail({ s }: ScheduleDetailProps) {
  const { t } = useTranslation()
  const closeDetail = useSetAtom(closeScheduleDetailAtom)
  const openSession = useSetAtom(openScheduleSessionAtom)
  const openRun = useSetAtom(openRunDrawerAtom)
  const continueRun = useSetAtom(continueFromRunAtom)
  const toggle = useSetAtom(toggleScheduleAtom)
  const del = useSetAtom(deleteScheduleAtom)
  const runNow = useSetAtom(runScheduleNowAtom)
  const kill = useSetAtom(killScheduleAtom)
  const stopRun = useSetAtom(stopScheduleRunAtom)
  const refetchDetail = useSetAtom(openScheduleDetailAtom)

  const st = getScheduleStatus(s)

  // While a run is executing or waiting to be handled, poll and re-fetch the detail (~3s) so that "running → finished" and "needs action → finished"
  // update automatically (an approximation of real time in the absence of a schedule WS). Tier1 W3: the threshold includes NeedsAction — after the user
  // answers elsewhere / in the drawer, an awaiting run leaves that state and the poll refreshes the detail rows + status pill (previously only Running was
  // watched, which happened to miss awaiting→handled, the very transition that most needed refreshing). No active run → stop polling. External sync (§1.17).
  const hasActiveRun = s.runs.some(
    (r) => r.status === RunStatus.Running || r.status === RunStatus.NeedsAction,
  )
  useEffect(() => {
    if (!hasActiveRun) return
    const timer = setInterval(() => void refetchDetail(s.id), 3000)
    return () => clearInterval(timer)
  }, [hasActiveRun, s.id, refetchDetail])

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* header */}
      <div className="px-8 pt-[18px] pb-4 border-b border-border-subtle">
        <button
          type="button"
          onClick={() => closeDetail()}
          className="inline-flex items-center gap-1.5 text-sm text-text-secondary cursor-pointer mb-3.5 hover:text-text-primary"
        >
          <span className="flex rotate-180">{Icons.chevronRight(14)}</span> {t('schedule.detail.back')}
        </button>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3.5 min-w-0">
            <div className="w-11 h-11 rounded-md flex-shrink-0 flex items-center justify-center bg-accent-purple-subtle text-text-accent-purple">
              {Icons.clock(20)}
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2.5">
                <h2 className="text-2xl font-bold text-text-primary m-0">{s.name}</h2>
                <SchedStatusPill status={st} count={s.needsAction} />
                {/* The paused notice became a hint icon next to the status plus a hover tooltip, so it takes no vertical space (#3). */}
                {s.paused && (
                  <Tooltip content={t('schedule.detail.pausedHint')}>
                    <span className="flex text-text-tertiary cursor-help hover:text-text-secondary">
                      {Icons.help(15)}
                    </span>
                  </Tooltip>
                )}
              </div>
              <div className="inline-flex items-center gap-1.5 mt-1.5 text-sm text-text-secondary">
                {Icons.refresh(12)} {describeCron(s.cron, t)}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {/* Under the overlap policy several runs may be in flight at once, so there is a schedule-level "stop all" entry point;
                stopping a single run lives in its run-history row (run-scoped, they do not affect each other). */}
            {s.running && (
              <Btn variant="danger" size="md" onClick={() => kill(s.id)}>
                {Icons.stop(11)} {t('schedule.action.stopAll')}
              </Btn>
            )}
            <Btn variant="primary" size="md" onClick={() => runNow(s.id)}>
              {Icons.play(12)} {t('schedule.action.runNow')}
            </Btn>
            <Btn
              variant="default"
              size="md"
              onClick={() => openSession({ mode: ScheduleTemplateMode.Edit, schedule: s })}
            >
              {Icons.edit(13)} {t('schedule.action.edit')}
            </Btn>
            <Btn variant="default" size="md" onClick={() => toggle(s.id)}>
              {s.paused ? (
                <>
                  {Icons.play(11)} {t('schedule.action.resume')}
                </>
              ) : (
                <>
                  {Icons.stop(11)} {t('schedule.action.pause')}
                </>
              )}
            </Btn>
            <Tooltip content={t('common.delete')}>
              <button
                type="button"
                onClick={() => void del(s.id)}
                className="w-9 h-9 rounded-md flex items-center justify-center text-status-error cursor-pointer border border-border-default hover:bg-status-error-bg"
              >
                {Icons.trash(15)}
              </button>
            </Tooltip>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto px-8 pt-6 pb-10">
        {st === ScheduleStatus.NeedsAction && (
          <div className="flex items-center gap-3 px-4 py-3 rounded-md bg-status-warning-bg border border-status-warning mb-5">
            <span className="text-status-warning flex flex-shrink-0">{Icons.alert(16)}</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-text-primary">{t('schedule.detail.needsAction.title')}</div>
              <div className="text-xs text-text-secondary mt-0.5">{t('schedule.detail.needsAction.description')}</div>
            </div>
            {getPendingRun(s) && (
              <Btn
                variant="default"
                size="sm"
                className="text-status-warning border-status-warning flex-shrink-0"
                onClick={() => openRun({ scheduleId: s.id, run: getPendingRun(s)! })}
              >
                {Icons.alert(12)} {t('schedule.detail.needsAction.handle')}
              </Btn>
            )}
          </div>
        )}

        {/* Config summary */}
        <div className="text-md font-bold text-text-primary mb-3">{t('schedule.detail.config.title')}</div>
        <Card className="px-[18px] mb-7">
          <ConfigRow label={t('schedule.detail.config.trigger')}>
            <span>{describeCron(s.cron, t)}</span>
            <span className="ml-2.5 text-xs text-text-tertiary font-mono bg-bg-hover px-2 py-0.5 rounded-md">
              {s.cron}
            </span>
          </ConfigRow>
          <ConfigRow label={t('schedule.detail.config.description')}>
            <span className="text-text-secondary leading-relaxed">{s.desc}</span>
          </ConfigRow>
          <ConfigRow label={t('schedule.detail.config.skills')}>
            <div className="flex flex-wrap gap-1.5">
              {s.skills.length ? (
                s.skills.map((n) => (
                  <span
                    key={n}
                    className="inline-flex items-center gap-1.5 text-xs font-mono text-text-accent-purple bg-accent-purple-subtle px-2.5 py-0.5 rounded-full"
                  >
                    {Icons.terminal(11)} {n}
                  </span>
                ))
              ) : (
                <span className="text-text-tertiary">{t('common.none')}</span>
              )}
            </div>
          </ConfigRow>
          <ConfigRow label={t('schedule.detail.config.nextRun')}>
            <SchedTime
              value={s.nextRun}
              className={cn(st === ScheduleStatus.Active ? 'text-text-accent' : 'text-text-secondary')}
            />
          </ConfigRow>
          <ConfigRow label={t('schedule.detail.config.lastRun')}>
            <SchedTime value={s.lastRun} />
          </ConfigRow>
          <ConfigRow label={t('schedule.detail.config.createdAt')}>
            <SchedTime value={s.created} />
          </ConfigRow>
        </Card>

        {/* Run history */}
        <div className="flex items-center justify-between mb-3">
          <span className="text-md font-bold text-text-primary">{t('schedule.detail.history.title')}</span>
          <span className="text-xs text-text-tertiary">{t('schedule.detail.history.description')}</span>
        </div>
        <Card className="p-1.5">
          {s.runs.length ? (
            s.runs.map((r) => (
              <RunHistoryRow
                key={r.sessionId}
                r={r}
                onOpen={() => openRun({ scheduleId: s.id, run: r })}
                onContinue={() => continueRun(r.sessionId)}
                onStop={() => stopRun(r.sessionId)}
              />
            ))
          ) : (
            <div className="py-7 text-center text-sm text-text-tertiary">{t('schedule.detail.history.empty')}</div>
          )}
        </Card>
      </div>
    </div>
  )
}
