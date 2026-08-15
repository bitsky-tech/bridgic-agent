/**
 * Sub-parts of the schedule detail page — run-history rows + config-summary rows (wired to real data: a condensed view of the backend run summary).
 *
 * Split out of ScheduleDetail to respect §1.14. Pure presentation: data is passed in by the parent, and clicking a run is raised
 * through the onOpen callback (the parent opens that scheduled Session in the conversation view). The KpiCard dashboard was removed
 * along with stats (the backend has no aggregation yet; deferred to Phase 6).
 */
import { cn } from '@/lib/cn'
import { RunStatus, type ScheduleRun } from '@/lib/schedule'
import { Icons, Tooltip } from '@/components/amphi'
import { SchedTime } from './SchedTime'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

/* ─── Run-history row ─── */

/** Status dot icon (§1.24: return different JSX early per status). */
function RunStatusIcon({ status }: { status: RunStatus }) {
  const base = 'w-[22px] h-[22px] rounded-full flex items-center justify-center flex-shrink-0'
  if (status === RunStatus.Success) {
    return <span className={cn(base, 'bg-status-success-bg text-status-success')}>{Icons.check(12)}</span>
  }
  if (status === RunStatus.Failed) {
    return <span className={cn(base, 'bg-status-error-bg text-status-error')}>{Icons.x(12)}</span>
  }
  if (status === RunStatus.NeedsAction) {
    return <span className={cn(base, 'bg-status-warning-bg text-status-warning')}>{Icons.alert(12)}</span>
  }
  // Finished: ended, but success/failure is unknown (the backend has no such signal) — a neutral grey dot, not a check (which would read as "succeeded").
  if (status === RunStatus.Finished) {
    return (
      <span className={cn(base, 'bg-bg-hover text-text-tertiary')}>
        <span className="w-[7px] h-[7px] rounded-full bg-text-tertiary" />
      </span>
    )
  }
  return (
    <span className={cn(base, 'bg-status-info-bg text-status-info')}>
      <span className="w-[7px] h-[7px] rounded-full bg-status-info animate-pulse" />
    </span>
  )
}

/** Status label (§1.24: use a helper for value mapping). */
function getRunLabel(status: RunStatus, t: (key: string) => string): string {
  if (status === RunStatus.Success) return t('schedule.runStatus.success')
  if (status === RunStatus.Failed) return t('schedule.runStatus.failed')
  if (status === RunStatus.Finished) return t('schedule.runStatus.finished')
  if (status === RunStatus.NeedsAction) return t('schedule.runStatus.needsAction')
  return t('schedule.runStatus.running')
}

/** Status text color. */
function getRunColorClass(status: RunStatus): string {
  if (status === RunStatus.Success) return 'text-status-success'
  if (status === RunStatus.Failed) return 'text-status-error'
  if (status === RunStatus.Finished) return 'text-text-secondary'
  if (status === RunStatus.NeedsAction) return 'text-status-warning'
  return 'text-status-info'
}

/** Small icon actions on the right of a run row (§1.25: use Tooltip, not the native title attribute). */
function IconBtn({
  tooltip,
  tint,
  testId,
  onClick,
  children,
}: {
  tooltip: string
  tint?: string
  testId?: string
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip content={tooltip}>
      <button
        type="button"
        data-testid={testId}
        onClick={onClick}
        className={cn(
          'w-7 h-7 rounded-md flex items-center justify-center cursor-pointer border border-border-subtle hover:bg-bg-hover',
          tint ?? 'text-text-secondary',
        )}
      >
        {children}
      </button>
    </Tooltip>
  )
}

export interface RunHistoryRowProps {
  r: ScheduleRun
  /** Open the detail drawer for this run. */
  onOpen: () => void
  /** "Continue conversation": copy this session as a whole into the left-hand list. */
  onContinue: () => void
  /** Stop this run (the button only shows for runs that are "running"). **Run-scoped**: it stops only this one and does not touch other
   *  in-flight runs of the same schedule — the caller must pass that run's sessionId, not the schedule id. */
  onStop: () => void
}

/** One row in the run history: status icon + time/status/session id + inline shortcuts (running → stop / finished → continue conversation / view).
 *  Clicking the row opens the drawer; inline buttons stop propagation and fire their own action. */
export function RunHistoryRow({ r, onOpen, onContinue, onStop }: RunHistoryRowProps) {
  const { t } = useTranslation()
  return (
    <div
      data-testid={`run-row-${r.sessionId}`}
      onClick={onOpen}
      className="flex items-center gap-3.5 px-4 py-2.5 cursor-pointer rounded-md hover:bg-bg-hover"
    >
      <RunStatusIcon status={r.status} />
      <SchedTime value={r.time} className="text-sm text-text-primary w-44 flex-shrink-0" />
      <span className={cn('text-xs font-semibold w-14 flex-shrink-0', getRunColorClass(r.status))}>
        {getRunLabel(r.status, t)}
      </span>
      <Tooltip content={r.sessionId} onlyWhenTruncated>
        <span className="flex-1 min-w-0 text-xs text-text-tertiary truncate font-mono">{r.sessionId}</span>
      </Tooltip>
      <div className="flex items-center gap-1.5 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
        {/* "Stop" is only shown while that run is executing (it stops just this one). */}
        {r.status === RunStatus.Running && (
          <IconBtn tooltip={t('schedule.action.stopRun')} tint="text-status-error" onClick={onStop}>
            {Icons.stop(14)}
          </IconBtn>
        )}
        {r.status === RunStatus.Finished && r.canContinue && (
          <IconBtn tooltip={t('schedule.action.continue')} testId={`continue-run-${r.sessionId}`} onClick={onContinue}>
            {Icons.chat(14)}
          </IconBtn>
        )}
        <IconBtn tooltip={t('schedule.action.viewRun')} onClick={onOpen}>
          {Icons.eye(14)}
        </IconBtn>
      </div>
    </div>
  )
}

/* ─── Config-summary row ─── */

export interface ConfigRowProps {
  label: string
  children: ReactNode
}

/** One row of the config summary: label on the left + content on the right (children lay themselves out freely, e.g. a badge group). */
export function ConfigRow({ label, children }: ConfigRowProps) {
  return (
    <div className="flex gap-4 py-2.5 border-b border-border-subtle last:border-b-0">
      <span className="w-[88px] flex-shrink-0 text-sm text-text-tertiary">{label}</span>
      <div className="flex-1 text-sm text-text-primary">{children}</div>
    </div>
  )
}
