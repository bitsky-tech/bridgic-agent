/** Dedicated Agent-owned progress surface for the presentation-making pipeline. */
import { useRef } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  currentAgentRunningAtom,
  currentThinkingModeAtom,
} from '@/atoms/agent'
import { currentHumanRequestAtom } from '@/atoms/human-request'
import { Icons } from '@/components/amphi/Icons'
import { useAutoHideScrollbar } from '@/hooks/useAutoHideScrollbar'
import { cn } from '@/lib/cn'

const PRESENTATION_STAGES = [
  'ppt_brief',
  'ppt_plan',
  'ppt_compose',
  'ppt_review',
] as const

/** Show the current stage without introducing a separate top-level mode toolbar. */
export function PresentationModePane() {
  const { t } = useTranslation()
  const position = useAtomValue(currentThinkingModeAtom)
  const agentRunning = useAtomValue(currentAgentRunningAtom)
  const pendingHuman = useAtomValue(currentHumanRequestAtom) !== null
  const scrollRef = useRef<HTMLDivElement | null>(null)
  useAutoHideScrollbar(scrollRef)

  const activeIndex = Math.max(0, PRESENTATION_STAGES.indexOf(
    position?.mode === 'presentation'
      ? position.stage as (typeof PRESENTATION_STAGES)[number]
      : 'ppt_brief',
  ))

  let status = t('presentationMode.status.paused')
  let statusTone = 'bg-bg-hover text-text-secondary'
  if (pendingHuman) {
    status = t('presentationMode.status.needsInput')
    statusTone = 'bg-status-warning-bg text-status-warning'
  } else if (agentRunning) {
    status = t('presentationMode.status.running')
    statusTone = 'bg-status-info-bg text-status-info'
  }

  return (
    <div
      className="flex h-full min-h-0 flex-col bg-bg-surface animate-fade"
      data-testid="presentation-mode-pane"
    >
      <div className="shrink-0 border-b border-border-subtle px-4 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent-primary/10 text-accent-primary">
              {Icons.presentation(17)}
            </span>
            <div className="min-w-0">
              <h2 className="truncate text-sm font-semibold text-text-primary">
                {t('presentationMode.title')}
              </h2>
              <p className="mt-0.5 text-2xs text-text-tertiary">
                {t('presentationMode.progress', { current: activeIndex + 1, total: PRESENTATION_STAGES.length })}
              </p>
            </div>
          </div>
          <span className={cn('shrink-0 rounded-full px-2 py-1 text-2xs font-medium', statusTone)}>
            {status}
          </span>
        </div>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
        <ol className="space-y-2" aria-label={t('presentationMode.stageAria')}>
          {PRESENTATION_STAGES.map((stage, index) => {
            const complete = index < activeIndex
            const current = index === activeIndex
            let stageState = 'pending'
            if (complete) stageState = 'complete'
            else if (current) stageState = 'current'
            return (
              <li
                key={stage}
                className={cn(
                  'rounded-xl border px-3.5 py-3 transition-colors',
                  current && 'border-accent-primary/35 bg-accent-primary/5',
                  complete && 'border-border-subtle bg-bg-subtle',
                  !complete && !current && 'border-border-subtle bg-bg-surface',
                )}
                data-stage={stage}
                data-state={stageState}
              >
                <div className="flex items-start gap-3">
                  <span className={cn(
                    'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-semibold',
                    complete && 'bg-status-success text-white',
                    current && 'bg-accent-primary text-white',
                    !complete && !current && 'border border-border-default text-text-tertiary',
                  )}>
                    {complete ? Icons.check(11) : index + 1}
                  </span>
                  <div className="min-w-0">
                    <h3 className={cn(
                      'text-xs font-semibold',
                      current ? 'text-text-primary' : 'text-text-secondary',
                    )}>
                      {t(`presentationMode.stages.${stage}.title`)}
                    </h3>
                    <p className="mt-1 text-2xs leading-5 text-text-tertiary">
                      {t(`presentationMode.stages.${stage}.description`)}
                    </p>
                  </div>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
    </div>
  )
}
