import { useAtomValue } from 'jotai'
import { useLayoutEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  currentAgentRunningAtom,
  hasPendingPermissionAtom,
} from '@/atoms/agent'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { currentHumanRequestAtom } from '@/atoms/human-request'
import { cn } from '@/lib/cn'
import { SessionStatusBar } from './SessionStatusBar'
import { StageRail } from './StageRail'
import { useWorkflowRunProjection } from './useWorkflowRunProjection'

/** Container-width thresholds for the two-phase Workflow rail, with hysteresis. */
export const WORKFLOW_RUN_COMPACT_HEADER_WIDTH = 680
export const WORKFLOW_RUN_EXPANDED_HEADER_WIDTH = 704
export const WORKFLOW_RUN_NARROW_HEADER_WIDTH = 520
export const WORKFLOW_RUN_NARROW_RESTORE_WIDTH = 544

type WorkflowHeaderDensity = 'full' | 'compact' | 'narrow'

function WorkflowPhaseRail({
  phase,
  running,
  compact,
  narrow,
  progress,
  hasValidation,
}: {
  phase: 'execute' | 'validate'
  running: boolean
  compact: boolean
  narrow: boolean
  progress: string
  hasValidation: boolean
}) {
  const { t } = useTranslation()
  const items = [
    { id: 'execute', label: t('workflowRunHeader.phase.execute'), description: t('workflowRunHeader.phase.executeDescription') },
    ...(hasValidation
      ? [{ id: 'validate', label: t('workflowRunHeader.phase.validate'), description: t('workflowRunHeader.phase.validateDescription') }]
      : []),
  ]
  const current = phase === 'validate' && hasValidation ? 1 : 0
  if (compact) {
    const currentLabel = items[current]?.label
    return (
      <div
        data-testid="workflow-compact-phase-rail"
        data-density={narrow ? 'narrow' : 'compact'}
        className={cn('flex items-center gap-2 overflow-hidden', narrow ? 'w-28' : 'w-32')}
      >
        <div className="flex min-w-0 flex-1 gap-1">
          {items.map((item, index) => (
            <span
              key={item.id}
              className={cn(
                'h-1.5 min-w-0 flex-1 rounded-full',
                index < current && 'bg-brand-blue/50',
                index === current && 'bg-brand-blue',
                index > current && 'bg-stage-track',
                index === current && running && 'animate-pulse',
              )}
            />
          ))}
        </div>
        <span className="min-w-0 truncate whitespace-nowrap text-xs font-medium text-text-secondary">
          {currentLabel}{narrow ? ` · ${progress}` : ''}
        </span>
      </div>
    )
  }
  return (
    <StageRail
      items={items}
      current={current}
      isRunning={running}
    />
  )
}

/** Session-level status bar for one active saved Workflow run. */
export function WorkflowRunHeader({ sessionId }: { sessionId?: string }) {
  const { t } = useTranslation()
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const projection = useWorkflowRunProjection()
  const agentRunning = useAtomValue(currentAgentRunningAtom)
  const pendingPermission = useAtomValue(hasPendingPermissionAtom)
  const pendingHuman = useAtomValue(currentHumanRequestAtom) !== null
  const statusBarRef = useRef<HTMLDivElement>(null)
  const [density, setDensity] = useState<WorkflowHeaderDensity>('full')

  useLayoutEffect(() => {
    const statusBar = statusBarRef.current
    if (!statusBar || typeof ResizeObserver === 'undefined') return

    const update = (width: number) => {
      if (width <= 0) return
      setDensity((current) => {
        if (current === 'narrow') {
          if (width < WORKFLOW_RUN_NARROW_RESTORE_WIDTH) return 'narrow'
          return width < WORKFLOW_RUN_EXPANDED_HEADER_WIDTH ? 'compact' : 'full'
        }
        if (current === 'compact') {
          if (width < WORKFLOW_RUN_NARROW_HEADER_WIDTH) return 'narrow'
          return width < WORKFLOW_RUN_EXPANDED_HEADER_WIDTH ? 'compact' : 'full'
        }
        if (width < WORKFLOW_RUN_NARROW_HEADER_WIDTH) return 'narrow'
        return width < WORKFLOW_RUN_COMPACT_HEADER_WIDTH ? 'compact' : 'full'
      })
    }
    update(statusBar.getBoundingClientRect().width)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      const width = entry?.borderBoxSize?.[0]?.inlineSize
        ?? entry?.target.getBoundingClientRect().width
      if (width !== undefined) update(width)
    })
    observer.observe(statusBar, { box: 'border-box' })
    return () => observer.disconnect()
  }, [])

  let status = t('workflowRunHeader.status.stopped')
  if (pendingPermission || pendingHuman) {
    status = t('workflowRunHeader.status.awaitingConfirmation')
  } else if (agentRunning) {
    status = t('workflowRunHeader.status.running')
  }

  const phaseLabel = projection.phase === 'execute'
    ? t('workflowRunHeader.phase.execute')
    : t('workflowRunHeader.phase.validate')
  const phaseSteps = projection.phase === 'execute'
    ? projection.executionSteps
    : projection.validationSteps
  const hasValidation = projection.validationSteps.length > 0 || projection.phase === 'validate'
  const phasePosition = projection.stageComplete
    ? phaseSteps.length
    : projection.stepIndex + 1
  const phaseProgress = `${phasePosition}/${Math.max(phaseSteps.length, phasePosition)}`
  const compact = density !== 'full'
  const narrow = density === 'narrow'

  if (sessionId !== undefined && sessionId !== activeSessionId) return null

  return (
    <SessionStatusBar
      rootRef={statusBarRef}
      testId="workflow-run-status-bar"
      isCompact={compact}
      isNarrow={narrow}
      title={t('workflowRunHeader.title')}
      badge={
        <span className="shrink-0 whitespace-nowrap rounded-full bg-accent-blue-subtle px-2 py-0.5 text-2xs font-semibold text-text-accent">
          {phaseLabel} · {phaseProgress}
        </span>
      }
      description={`${projection.workflowName} · ${projection.currentTitle}`}
      rail={
        <div data-testid={compact ? undefined : 'workflow-phase-rail'}>
          <WorkflowPhaseRail
            phase={projection.phase}
            running={agentRunning && !projection.stageComplete}
            compact={compact}
            narrow={narrow}
            progress={phaseProgress}
            hasValidation={hasValidation}
          />
        </div>
      }
      status={
        <span className={cn(
          'hidden items-center gap-1.5 text-xs font-medium text-text-secondary',
          !compact && 'sm:flex',
        )}>
          <span className={cn(
            'h-1.5 w-1.5 rounded-full',
            agentRunning ? 'animate-pulse bg-brand-blue' : 'bg-text-tertiary',
          )} />
          {status}
        </span>
      }
    />
  )
}
