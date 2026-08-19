import { type ReactNode, useRef, useState } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  currentAgentRunningAtom,
  hasPendingPermissionAtom,
} from '@/atoms/agent'
import { currentHumanRequestAtom } from '@/atoms/human-request'
import { workflowRunDetailsOpenAtom } from '@/atoms/workflow-run-details'
import { Icons } from '@/components/amphi/Icons'
import { cn } from '@/lib/cn'
import { useAutoHideScrollbar } from '@/hooks/useAutoHideScrollbar'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'
import { useWorkflowRunProjection } from './useWorkflowRunProjection'

type WorkflowPhase = 'execute' | 'validate'

/** Full-height right-column view of the active Workflow Run. */
export function WorkflowRunDetailsPane() {
  const { t } = useTranslation()
  const open = useAtomValue(workflowRunDetailsOpenAtom)
  const projection = useWorkflowRunProjection()
  const agentRunning = useAtomValue(currentAgentRunningAtom)
  const pendingPermission = useAtomValue(hasPendingPermissionAtom)
  const pendingHuman = useAtomValue(currentHumanRequestAtom) !== null
  const [phaseSelection, setPhaseSelection] = useState<{
    generation: string | undefined
    activePhase: WorkflowPhase
    activeStepIndex: number
    selectedPhase: WorkflowPhase
  } | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useAutoHideScrollbar(scrollRef)

  if (!open) return null

  const hasValidation = projection.validationSteps.length > 0 || projection.phase === 'validate'
  const rememberedPhase = phaseSelection !== null
    && phaseSelection.generation === projection.generation
    && phaseSelection.activePhase === projection.phase
    && phaseSelection.activeStepIndex === projection.stepIndex
    ? phaseSelection.selectedPhase
    : projection.phase
  const selectedPhase = rememberedPhase === 'validate' && !hasValidation
    ? 'execute'
    : rememberedPhase
  const executionDone = projection.phase === 'validate'
    ? projection.executionSteps.length
    : Math.min(projection.stepIndex, projection.executionSteps.length)
  const validationDone = projection.phase === 'validate'
    ? Math.min(projection.stepIndex, projection.validationSteps.length)
    : 0
  const completedSteps = executionDone + validationDone
  const totalSteps = projection.executionSteps.length + projection.validationSteps.length
  const overallPercent = totalSteps === 0
    ? 0
    : Math.min(100, Math.round((completedSteps / totalSteps) * 100))
  const selectedSteps = selectedPhase === 'execute'
    ? projection.executionSteps
    : projection.validationSteps
  const selectedUnit = selectedPhase === 'execute'
    ? t('workflowRunHeader.unit.step')
    : t('workflowRunHeader.unit.check')

  let status = t('workflowRunHeader.status.stopped')
  let statusTone = 'bg-bg-hover text-text-secondary'
  if (pendingPermission || pendingHuman) {
    status = t('workflowRunHeader.status.awaitingConfirmation')
    statusTone = 'bg-status-warning-bg text-status-warning'
  } else if (agentRunning) {
    status = t('workflowRunHeader.status.running')
    statusTone = 'bg-status-info-bg text-status-info'
  }

  const phaseTabs = [
    {
      phase: 'execute' as const,
      label: t('workflowRunHeader.executionWorkflow'),
      steps: projection.executionSteps,
      unit: t('workflowRunHeader.unit.step'),
      complete: projection.phase === 'validate'
        || (projection.phase === 'execute' && projection.stageComplete),
      current: projection.phase === 'execute' && !projection.stageComplete,
    },
    ...(hasValidation
      ? [{
          phase: 'validate' as const,
          label: t('workflowRunHeader.validationResults'),
          steps: projection.validationSteps,
          unit: t('workflowRunHeader.unit.check'),
          complete: projection.phase === 'validate' && projection.stageComplete,
          current: projection.phase === 'validate' && !projection.stageComplete,
        }]
      : []),
  ]

  return (
    <div
      id="workflow-run-details-pane"
      data-testid="workflow-run-details-pane"
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg-surface animate-fade"
    >
      <div
        data-testid="workflow-run-details-header"
        className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4"
        style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
      >
        <span className="flex shrink-0 text-text-accent">{Icons.workflow(16)}</span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
          {t('workflowRunHeader.detailsTitle')}
        </span>
        <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold', statusTone)}>
          {status}
        </span>
      </div>

      <div
        ref={scrollRef}
        data-testid="workflow-run-details-scroll"
        className="auto-hide-scrollbar min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain"
      >
        <div className="p-4 pb-3">
          <section
            data-testid="workflow-run-overview"
            className="overflow-hidden rounded-xl border border-border-default bg-bg-elevated shadow-sm"
          >
            <div className="px-4 py-3.5">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-text-tertiary">
                    {projection.phase === 'execute'
                      ? t('workflowRunHeader.phase.execute')
                      : t('workflowRunHeader.phase.validate')}
                  </div>
                  <div className="mt-0.5 line-clamp-2 text-sm font-semibold leading-snug text-text-primary">
                    {projection.currentTitle}
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="text-lg font-semibold tabular-nums text-text-primary">
                    {completedSteps}<span className="text-xs font-medium text-text-tertiary">/{totalSteps}</span>
                  </div>
                  <div className="text-2xs text-text-tertiary">
                    {t('workflowRunHeader.overallProgress')}
                  </div>
                </div>
              </div>
              <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-stage-track">
                <div
                  role="progressbar"
                  aria-label={t('workflowRunHeader.overallProgress')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={overallPercent}
                  className="h-full rounded-full bg-[image:var(--brand-gradient)] transition-[width] duration-300"
                  style={{ width: `${overallPercent}%` }}
                />
              </div>
            </div>
            <div className={cn(
              'grid divide-x divide-border-subtle border-t border-border-subtle bg-bg-app/60',
              hasValidation ? 'grid-cols-3' : 'grid-cols-2',
            )}>
              <RunMetric value={executionDone} label={t('workflowRunHeader.executionCompleted')} />
              {hasValidation && (
                <RunMetric value={validationDone} label={t('workflowRunHeader.validationCompleted')} />
              )}
              <RunMetric value={projection.toolCalls} label={t('workflowRunHeader.toolCalls')} />
            </div>
          </section>
        </div>

        <div
          role="tablist"
          aria-label={t('workflowRunHeader.phaseAria')}
          className={cn(
            'mx-4 grid rounded-lg bg-bg-hover p-1',
            hasValidation ? 'grid-cols-2' : 'grid-cols-1',
          )}
        >
          {phaseTabs.map((tab, tabIndex) => {
            let progress = t('workflowRunHeader.progress.awaiting', {
              total: tab.steps.length,
              unit: tab.unit,
            })
            if (tab.complete) {
              progress = t('workflowRunHeader.progress.complete', {
                total: tab.steps.length,
                unit: tab.unit,
              })
            }
            if (tab.current) {
              progress = t('workflowRunHeader.progress.current', {
                current: projection.stepIndex + 1,
                total: Math.max(tab.steps.length, projection.stepIndex + 1),
                unit: tab.unit,
              })
            }
            const selected = selectedPhase === tab.phase
            return (
              <button
                key={tab.phase}
                id={`workflow-${tab.phase}-details-tab`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="workflow-run-phase-panel"
                tabIndex={selected ? 0 : -1}
                onClick={() => setPhaseSelection({
                  generation: projection.generation,
                  activePhase: projection.phase,
                  activeStepIndex: projection.stepIndex,
                  selectedPhase: tab.phase,
                })}
                onKeyDown={(event) => {
                  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
                  event.preventDefault()
                  if (phaseTabs.length < 2) return
                  const offset = event.key === 'ArrowRight' ? 1 : -1
                  const nextTab = phaseTabs[(tabIndex + offset + phaseTabs.length) % phaseTabs.length]
                  if (!nextTab) return
                  const nextPhase: WorkflowPhase = nextTab.phase
                  setPhaseSelection({
                    generation: projection.generation,
                    activePhase: projection.phase,
                    activeStepIndex: projection.stepIndex,
                    selectedPhase: nextPhase,
                  })
                  document.getElementById(`workflow-${nextPhase}-details-tab`)?.focus()
                }}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors',
                  selected
                    ? 'bg-bg-surface text-text-primary shadow-sm'
                    : 'text-text-secondary hover:text-text-primary',
                )}
              >
                <span className={cn(
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold',
                  tab.complete && 'bg-status-success-bg text-status-success',
                  tab.current && 'border border-brand-blue bg-accent-blue-subtle text-text-accent',
                  !tab.complete && !tab.current && 'border border-border-default text-text-tertiary',
                )}>
                  {tab.complete ? Icons.check(11) : tabIndex + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold">{tab.label}</span>
                  <span className="block truncate text-2xs text-text-tertiary">{progress}</span>
                </span>
              </button>
            )
          })}
        </div>

        <div
          id="workflow-run-phase-panel"
          role="tabpanel"
          aria-labelledby={`workflow-${selectedPhase}-details-tab`}
          data-testid="workflow-run-steps"
          className="min-w-0 px-4 py-4"
        >
          {selectedSteps.map((title, index) => {
            const block = [...projection.workflowBlocks].reverse().find(
              (item) => item.phase === selectedPhase && item.stepIndex === index,
            )
            const phasePassed = selectedPhase === 'execute' && projection.phase === 'validate'
            const done = block?.status === 'success'
              || phasePassed
              || (selectedPhase === projection.phase && index < projection.stepIndex)
            const failed = block?.status === 'failure'
            const active = selectedPhase === projection.phase
              && index === projection.stepIndex
              && !projection.stageComplete
              && !done
              && !failed
            let detail = t('workflowRunHeader.detail.awaiting')
            if (done) detail = t('workflowRunHeader.detail.completed')
            if (active) detail = t('workflowRunHeader.detail.current', { unit: selectedUnit })
            if (failed) detail = t('workflowRunHeader.detail.failed')
            let marker: ReactNode = index + 1
            if (done) marker = Icons.check(12)
            else if (failed) marker = Icons.x(12)
            let state = 'pending'
            if (done) state = 'done'
            if (active) state = 'active'
            if (failed) state = 'failed'
            return (
              <div
                key={`${selectedPhase}:${index}:${title}`}
                data-step-state={state}
                className="relative flex min-w-0 gap-3 pb-3 last:pb-0"
              >
                {index < selectedSteps.length - 1 && (
                  <span className={cn(
                    'absolute left-[13px] top-7 h-[calc(100%-16px)] w-px',
                    done ? 'bg-status-success/30' : 'bg-border-default',
                  )} />
                )}
                <span className={cn(
                  'relative z-10 flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-2xs font-semibold',
                  done && 'bg-status-success-bg text-status-success ring-4 ring-bg-surface',
                  active && 'border border-brand-blue bg-accent-blue-subtle text-text-accent ring-4 ring-bg-surface',
                  failed && 'bg-status-error-bg text-status-error ring-4 ring-bg-surface',
                  !done && !active && !failed && 'border border-border-default bg-bg-surface text-text-tertiary ring-4 ring-bg-surface',
                )}>
                  {marker}
                </span>
                <div className={cn(
                  'min-w-0 flex-1 rounded-lg border px-3 py-2.5',
                  active && 'border-brand-blue/40 bg-accent-blue-subtle/60 shadow-sm',
                  failed && 'border-status-error/30 bg-status-error-bg/50',
                  done && 'border-border-subtle bg-bg-elevated',
                  !done && !active && !failed && 'border-border-subtle bg-bg-app/40',
                )}>
                  <div className="flex min-w-0 items-start justify-between gap-2">
                    <span
                      data-testid="workflow-run-step-title"
                      className={cn(
                      'min-w-0 flex-1 [overflow-wrap:anywhere] text-xs font-semibold leading-relaxed',
                      active || done ? 'text-text-primary' : 'text-text-secondary',
                      failed && 'text-status-error',
                    )}
                    >
                      {title}
                    </span>
                    {active && (
                      <span className={cn('shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium', statusTone)}>
                        {status}
                      </span>
                    )}
                  </div>
                  <div
                    data-testid="workflow-run-step-detail"
                    className={cn(
                      'mt-1 min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere] text-xs leading-relaxed text-text-tertiary',
                      failed && 'text-status-error',
                    )}
                  >
                    {block?.summary || detail}
                  </div>
                </div>
              </div>
            )
          })}
          {selectedSteps.length === 0 && (
            <div className="rounded-lg border border-dashed border-border-default px-4 py-8 text-center text-xs text-text-tertiary">
              {t('workflowRunHeader.noSteps')}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function RunMetric({ value, label }: { value: number; label: string }) {
  return (
    <div className="min-w-0 px-2 py-2.5 text-center">
      <div className="text-sm font-semibold tabular-nums text-text-primary">{value}</div>
      <div className="truncate text-2xs text-text-tertiary">{label}</div>
    </div>
  )
}
