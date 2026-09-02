/** Dedicated Agent-owned progress surface for the presentation-making pipeline. */
import { useRef } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  currentAgentRunningAtom,
  currentMessagesAtom,
  currentThinkingModeAtom,
} from '@/atoms/agent'
import { currentHumanRequestAtom } from '@/atoms/human-request'
import { Icons } from '@/components/amphi/Icons'
import { useAutoHideScrollbar } from '@/hooks/useAutoHideScrollbar'
import { cn } from '@/lib/cn'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

const PRESENTATION_STAGES = [
  {
    id: 'ppt_brief',
    steps: [],
  },
  {
    id: 'ppt_plan',
    steps: ['design_visual_direction', 'collect_evidence', 'shape_chapters', 'map_slides'],
  },
  {
    id: 'ppt_compose',
    steps: ['build_slide_shells', 'fill_slide_content', 'create_visuals', 'polish_deck'],
  },
  {
    id: 'ppt_review',
    steps: ['audit_narrative', 'audit_evidence', 'inspect_visual_quality', 'confirm_delivery'],
  },
] as const

type PresentationStage = (typeof PRESENTATION_STAGES)[number]
type PresentationStageId = PresentationStage['id']

function stageUnitCount(stage: PresentationStage): number {
  return Math.max(1, stage.steps.length)
}

function normalizeEvidence(evidence: string[]): string[] {
  if (evidence.length === 0 || !evidence.every(item => item.length === 1)) return evidence
  const joined = evidence.join('').trim()
  if (!joined.startsWith('[') || !joined.endsWith(']')) return evidence
  const quoted = Array.from(joined.matchAll(/(['"])(.*?)\1/g), match => match[2]!.trim()).filter(Boolean)
  return quoted.length > 0 ? quoted : [joined]
}

/** Show live production progress without introducing a separate top-level mode toolbar. */
export function PresentationModePane() {
  const { t } = useTranslation()
  const position = useAtomValue(currentThinkingModeAtom)
  const agentRunning = useAtomValue(currentAgentRunningAtom)
  const messages = useAtomValue(currentMessagesAtom)
  const pendingHuman = useAtomValue(currentHumanRequestAtom) !== null
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useAutoHideScrollbar(scrollRef)

  const activeStageId: PresentationStageId = position?.mode === 'presentation'
    && PRESENTATION_STAGES.some(stage => stage.id === position.stage)
    ? position.stage as PresentationStageId
    : 'ppt_brief'
  const activeIndex = PRESENTATION_STAGES.findIndex(stage => stage.id === activeStageId)
  const activeStage = PRESENTATION_STAGES[activeIndex]!
  const activeStepIndex = Math.min(
    Math.max(0, position?.mode === 'presentation' ? position.presentationStepIndex ?? 0 : 0),
    activeStage.steps.length,
  )
  const completedStepCount = PRESENTATION_STAGES
    .slice(0, activeIndex)
    .reduce((total, stage) => total + stageUnitCount(stage), 0) + activeStepIndex
  const totalStepCount = PRESENTATION_STAGES.reduce((total, stage) => total + stageUnitCount(stage), 0)
  const reports = new Map(
    (position?.mode === 'presentation' ? position.presentationReports ?? [] : [])
      .map(report => [
        `${report.stage}/${report.stepId}`,
        { ...report, evidence: normalizeEvidence(report.evidence) },
      ] as const),
  )
  const latestAssistant = messages.findLast(message => message.role === 'assistant')
  const failed = Boolean(latestAssistant?.error)
  const overallPercent = totalStepCount === 0
    ? 0
    : Math.round((completedStepCount / totalStepCount) * 100)

  let status = t('presentationMode.status.paused')
  let statusTone = 'bg-bg-hover text-text-secondary'
  if (pendingHuman) {
    status = t('presentationMode.status.needsInput')
    statusTone = 'bg-status-warning-bg text-status-warning'
  } else if (agentRunning) {
    status = t('presentationMode.status.running')
    statusTone = 'bg-status-info-bg text-status-info'
  } else if (failed) {
    status = t('presentationMode.status.failed')
    statusTone = 'bg-status-error-bg text-status-error'
  }

  return (
    <div
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg-surface animate-fade"
      data-testid="presentation-mode-pane"
    >
      <div
        className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4"
        style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
      >
        <span className="flex shrink-0 text-text-accent">{Icons.presentation(16)}</span>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
          {t('presentationMode.title')}
        </h2>
        <span className="shrink-0 text-2xs tabular-nums text-text-tertiary">
          {completedStepCount}/{totalStepCount}
        </span>
        <span
          className={cn('shrink-0 rounded-full px-2 py-0.5 text-2xs font-medium', statusTone)}
          data-testid="presentation-status"
        >
          {status}
        </span>
      </div>

      <div ref={scrollRef} className="auto-hide-scrollbar min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="px-4 pb-3 pt-4">
          <section className="rounded-xl bg-bg-subtle px-3.5 py-3" data-testid="presentation-overview">
            <div className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-xs font-semibold text-text-primary">
                {t(`presentationMode.stages.${activeStage.id}.title`)}
              </span>
              <span className="shrink-0 text-2xs text-text-tertiary">
                {t('presentationMode.progress', { current: activeIndex + 1, total: PRESENTATION_STAGES.length })}
              </span>
            </div>
            {position?.mode === 'presentation' && position.presentationGoal && (
              <p
                className="mt-1.5 line-clamp-3 text-xs leading-5 text-text-secondary"
                data-testid="presentation-goal"
              >
                {position.presentationGoal}
              </p>
            )}
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-stage-track">
              <div
                role="progressbar"
                aria-label={t('presentationMode.stepProgress', { current: completedStepCount, total: totalStepCount })}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={overallPercent}
                className="h-full rounded-full bg-[image:var(--brand-gradient)] transition-[width] duration-300"
                style={{ width: `${overallPercent}%` }}
              />
            </div>
          </section>
        </div>

        <ol className="px-4 pb-5 pt-1" aria-label={t('presentationMode.stageAria')}>
          {PRESENTATION_STAGES.map((stage, stageIndex) => {
            const complete = stageIndex < activeIndex
            const current = stageIndex === activeIndex
            let stageStepIndex = 0
            let stageState = 'pending'
            if (complete) {
              stageStepIndex = stage.steps.length
              stageState = 'complete'
            } else if (current) {
              stageStepIndex = activeStepIndex
              stageState = 'current'
            }
            const stepList = (
              <ol className="mt-3 space-y-2.5 border-l border-border-subtle pl-3">
                {stage.steps.map((stepId, stepIndex) => {
                  const stepComplete = stepIndex < stageStepIndex
                  const stepCurrent = current
                    && stepIndex === stageStepIndex
                    && stageStepIndex < stage.steps.length
                  const report = reports.get(`${stage.id}/${stepId}`)
                  let stepState = 'pending'
                  if (stepComplete) stepState = 'complete'
                  else if (stepCurrent) stepState = 'current'
                  return (
                    <li
                      key={stepId}
                      className={cn(
                        'relative',
                        stepCurrent && 'animate-stage-activate motion-reduce:animate-none',
                      )}
                      data-step={stepId}
                      data-state={stepState}
                    >
                      {stepCurrent && agentRunning ? (
                        <span
                          className="absolute -left-[19px] top-1 flex size-3 items-center justify-center rounded-full bg-bg-surface"
                          data-testid="presentation-step-spinner"
                          role="status"
                          aria-label={t('presentationMode.status.running')}
                        >
                          <span className="size-3 animate-spin rounded-full border-2 border-accent-primary/25 border-t-accent-primary motion-reduce:animate-none" />
                        </span>
                      ) : (
                        <span className={cn(
                          'absolute -left-[17px] top-1.5 size-2 rounded-full ring-2 ring-bg-surface',
                          stepComplete && 'bg-status-success',
                          stepCurrent && 'bg-accent-primary',
                          !stepComplete && !stepCurrent && 'bg-border-default',
                        )} />
                      )}
                      <p className={cn(
                        'text-2xs font-medium leading-5',
                        stepCurrent ? 'text-text-primary' : 'text-text-secondary',
                      )}>
                        {t(`presentationMode.steps.${stepId}`)}
                      </p>
                      {report && (
                        <div
                          className="mt-1 animate-enter motion-reduce:animate-none"
                          data-testid={`presentation-report-${stepId}`}
                        >
                          <p className="text-2xs leading-5 text-text-tertiary">{report.summary}</p>
                          {report.evidence.length > 0 && (
                            <div className="mt-1 flex flex-wrap gap-1">
                              {report.evidence.slice(0, 3).map(item => (
                                <span
                                  key={item}
                                  className="max-w-full truncate rounded bg-bg-hover px-1.5 py-0.5 text-[10px] text-text-tertiary"
                                  title={item}
                                >
                                  {item}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
                {current && stage.steps.length > 0 && stageStepIndex === stage.steps.length && (
                  <li className="text-2xs font-medium text-status-success" data-testid="presentation-stage-ready">
                    {t('presentationMode.stageReady')}
                  </li>
                )}
              </ol>
            )
            return (
              <li
                key={stage.id}
                className="relative pb-5 pl-9 last:pb-0"
                data-stage={stage.id}
                data-state={stageState}
              >
                {stageIndex < PRESENTATION_STAGES.length - 1 && (
                  <span className="absolute bottom-0 left-[11px] top-6 w-px bg-border-subtle" aria-hidden="true" />
                )}
                <span className={cn(
                  'absolute left-0 top-0.5 flex size-6 items-center justify-center rounded-full text-2xs font-semibold',
                  complete && 'bg-status-success-bg text-status-success',
                  current && 'bg-accent-primary text-white shadow-sm',
                  !complete && !current && 'border border-border-default bg-bg-surface text-text-tertiary',
                )}>
                  {current && stage.steps.length === 0 && agentRunning ? (
                    <span
                      className="flex size-4 items-center justify-center"
                      data-testid="presentation-stage-spinner"
                      role="status"
                      aria-label={t('presentationMode.status.running')}
                    >
                      <span className="size-3 animate-spin rounded-full border-2 border-white/30 border-t-white motion-reduce:animate-none" />
                    </span>
                  ) : (
                    <span className="relative">{complete ? Icons.check(11) : stageIndex + 1}</span>
                  )}
                </span>
                <div className={cn(
                  'min-w-0 transition-colors',
                  current && 'animate-stage-activate motion-reduce:animate-none',
                )}>
                    <div className="flex items-center justify-between gap-2">
                      <h3 className={cn(
                        'text-xs font-semibold',
                        current ? 'text-text-primary' : 'text-text-secondary',
                      )}>
                        {t(`presentationMode.stages.${stage.id}.title`)}
                      </h3>
                      {(complete || current) && stage.steps.length > 0 && (
                        <span className="shrink-0 text-2xs text-text-tertiary">
                          {stageStepIndex}/{stage.steps.length}
                        </span>
                      )}
                    </div>
                    <p className="mt-1 text-2xs leading-5 text-text-tertiary">
                      {t(`presentationMode.stages.${stage.id}.description`)}
                    </p>
                    {current && stage.steps.length > 0 && stepList}
                    {complete && stage.steps.length > 0 && (
                      <details className="group mt-2">
                        <summary className="cursor-pointer select-none text-2xs font-medium text-text-tertiary hover:text-text-secondary">
                          {t('presentationMode.completedDetails')}
                        </summary>
                        {stepList}
                      </details>
                    )}
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
