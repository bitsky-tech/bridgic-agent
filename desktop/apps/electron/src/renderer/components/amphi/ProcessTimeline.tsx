/**
 * Execution-process container — the core of QA version H (aligned with the QA_ExecProcess2 design): it collects the
 * "process" blocks of one assistant reply (thinking / intermediate prose / tools) into a collapsible container; the final
 * answer is rendered outside the container by the layer above (MessageContent) and is always visible.
 *
 * Interaction:
 *  - Follows state by default: expanded while `streaming` (visible in real time), collapsed otherwise; finishing an answer /
 *    switching sessions / refreshing produces a new instance → back to the collapsed default, keeping the final answer
 *    prominent. Clicking the title lets the user override the default at any time — including deliberately collapsing it
 *    mid-stream (only within the current view; navigating away and back is a new instance).
 *  - The title summarizes the number of tool calls, process messages and human confirmations; click to toggle.
 *
 * Visuals: stacked blocks, **no vertical line running across stages** (aligned with the QATLItem design note "no through-line"),
 * gap 14 between entries. Workflow steps and Build stages are stable sub-headings; every process entry from one heading to the
 * next belongs under it and can be collapsed on its own; thinking is emphasized (MessageThinking), intermediate prose is
 * de-emphasized (text-sm/text-tertiary), and tools are single-line (ToolCallRow).
 */
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'
import { Collapse } from './Collapse'
import { StickyScroll } from './StickyScroll'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { MessageThinking } from './MessageThinking'
import { ToolCallRow } from './ToolCallRow'
import { SubagentCard } from './SubagentCard'
import { countConfirmations, countMessages, countToolCalls, countWorkflowSteps } from '@/lib/qaSegments'
import type { MessageBlock } from '@/atoms/agent'
import {
  BUILD_STAGES,
  isBuildStage,
  type BuildStage,
} from '@/atoms/build'
import {
  CompletedInteractionCard,
  humanizeAcceptanceRuleText,
  type CompletedInteractionBlock,
} from './CompletedInteractionCard'
import { TimelineStageSection } from './TimelineStageSection'

export interface ProcessTimelineProps {
  /** Execution-process blocks (the final answer has already been split off by splitProcessAndAnswer). */
  blocks: MessageBlock[]
  /** Streaming in progress → expanded by default (the user can click the title to collapse and override). */
  streaming?: boolean
  /** Extra condition for defaulting to expanded (alongside streaming): set to true when this message contains a pending
   *  approval card, so the user sees the execution context before deciding — this fixes "when an approval is parked (the turn
   *  has ended, streaming=false) the execution flow happens to fall back to collapsed". Clicking the title can still override it. */
  defaultOpen?: boolean
  /** Session receiving interaction responses from timeline cards. */
  sessionId?: string
}

type WorkflowStepBlock = Extract<MessageBlock, { type: 'workflow_step' }>
type TimelineSection =
  | { type: 'blocks'; key: string; blocks: MessageBlock[] }
  | { type: 'workflow'; key: string; step: WorkflowStepBlock; blocks: MessageBlock[] }
  | { type: 'build'; key: string; stage: BuildStage; blocks: MessageBlock[] }
type StageTimelineSection = Exclude<TimelineSection, { type: 'blocks' }>

export function ProcessTimeline({ blocks, streaming = false, defaultOpen = false, sessionId }: ProcessTimelineProps) {
  const { t } = useTranslation()
  // userOpen=null → follow the default (expanded while streaming / defaultOpen, collapsed otherwise); once the user clicks the
  // title it is pinned to an explicit true/false — which is what lets the user actively collapse it (overriding the expanded
  // default). A streaming bubble being committed to history / switching sessions / refreshing are all new instances → userOpen
  // resets to null → back to the default (where defaultOpen can still expand it for a pending card).
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const open = userOpen ?? (streaming || defaultOpen)
  const confirmations = countConfirmations(blocks)
  const workflowSteps = countWorkflowSteps(blocks)

  const sections: TimelineSection[] = []
  let looseBlocks: MessageBlock[] = []
  let activeSection: StageTimelineSection | null = null
  let buildSectionOrdinal = 0
  const flushLooseBlocks = () => {
    if (!looseBlocks.length) return
    sections.push({ type: 'blocks', key: `blocks-${sections.length}`, blocks: looseBlocks })
    looseBlocks = []
  }
  for (const block of blocks) {
    if (block.type === 'workflow_step') {
      flushLooseBlocks()
      activeSection = {
        type: 'workflow',
        key: `${block.workflowId}:${block.generation}:${block.phase}:${block.stepIndex}`,
        step: block,
        blocks: [],
      }
      sections.push(activeSection)
    } else if (block.type === 'build_stage') {
      flushLooseBlocks()
      activeSection = null
      if (isBuildStage(block.stage)) {
        activeSection = {
          type: 'build',
          key: `build-${buildSectionOrdinal}`,
          stage: block.stage,
          blocks: [],
        }
        buildSectionOrdinal += 1
        sections.push(activeSection)
      }
    } else if (activeSection) {
      activeSection.blocks.push(block)
    } else {
      looseBlocks.push(block)
    }
  }
  flushLooseBlocks()
  const activeBuildKey = activeSection?.type === 'build' ? activeSection.key : null

  return (
    <div>
      <div
        onClick={() => setUserOpen(!open)}
        className="inline-flex max-w-full cursor-pointer flex-wrap items-center gap-x-2 gap-y-1 py-1 select-none"
      >
        <span
          className={cn(
            'flex shrink-0 text-text-tertiary transition-transform duration-300 ease-out',
            open && 'rotate-90',
          )}
        >
          {Icons.chevronRight(13)}
        </span>
        <span className="whitespace-nowrap text-xs font-medium text-text-secondary">{t('session.timeline.title')}</span>
        <span className="whitespace-nowrap text-[11px] text-text-tertiary">
          {t('session.timeline.summary.calls', { n: countToolCalls(blocks) })} · {t('session.timeline.summary.messages', { n: countMessages(blocks) })}
          {workflowSteps > 0 ? ` · ${t('session.timeline.summary.steps', { n: workflowSteps })}` : null}
          {confirmations > 0 ? ` · ${t('session.timeline.summary.confirmations', { n: confirmations })}` : null}
        </span>
      </div>
      <Collapse open={open}>
        <div className="flex flex-col gap-3.5 pt-3">
          {sections.map((section) => {
            if (section.type === 'workflow') {
              return (
                <WorkflowStageSection
                  key={section.key}
                  step={section.step}
                  blocks={section.blocks}
                  streaming={streaming}
                  sessionId={sessionId}
                />
              )
            }
            if (section.type === 'build') {
              return (
                <BuildStageSection
                  key={section.key}
                  stage={section.stage}
                  blocks={section.blocks}
                  active={section.key === activeBuildKey && (streaming || defaultOpen)}
                  streaming={streaming}
                  sessionId={sessionId}
                />
              )
            }
            return (
              <div key={section.key} className="flex flex-col gap-3.5">
                {section.blocks.map((block, i) => (
                  <TimelineBlock
                    key={timelineKey(block, i)}
                    block={block}
                    streaming={streaming}
                    sessionId={sessionId}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </Collapse>
    </div>
  )
}

/** Tool blocks are keyed by toolUseId (stable); everything else by index. */
function timelineKey(block: MessageBlock, i: number): string {
  if (block.type === 'tool') return block.toolUseId
  if (block.type === 'subagent') return block.invocationId
  if (block.type === 'workflow_step') {
    return `${block.workflowId}:${block.phase}:${block.stepIndex}`
  }
  return `b-${i}`
}

/** Block content dispatch (§1.24): emphasized thinking / single-line tools / approval cards / de-emphasized intermediate prose. While streaming, height-capped blocks stick to their own bottom. */
function TimelineBlock({ block, streaming, sessionId }: { block: MessageBlock; streaming: boolean; sessionId?: string }) {
  if (block.type === 'thinking') return <MessageThinking thinking={block.text} streaming={streaming} />
  if (block.type === 'tool') return <ToolCallRow call={block} />
  if (block.type === 'subagent') return <SubagentCard block={block} />
  // Approval cards are ordered entries inside the execution process, placed BEFORE the tool they gate (approval precedes execution).
  if (block.type === 'permission') {
    if (block.decided) return <CompletedInteractionRow block={block} sessionId={sessionId} />
    return null
  }
  if (block.type === 'text') {
    return (
      <StickyScroll active={streaming} dep={block.text} className="max-h-60 overflow-auto">
        <MarkdownMessage content={block.text} className="text-sm leading-[1.65] text-text-tertiary" streaming={streaming} />
      </StickyScroll>
    )
  }
  if (
    block.type === 'confirmation' ||
    block.type === 'build_confirm' ||
    block.type === 'task_confirm' ||
    block.type === 'workflow_confirm'
  ) {
    if ('status' in block && (block.status ?? 'pending') === 'pending') return null
    return <CompletedInteractionRow block={block} sessionId={sessionId} />
  }
  return null
}

/** Workflow-specific adapter for the shared process-section heading. */
function WorkflowStageSection({
  step,
  blocks,
  streaming,
  sessionId,
}: {
  step: Extract<MessageBlock, { type: 'workflow_step' }>
  blocks: MessageBlock[]
  streaming: boolean
  sessionId?: string
}) {
  const { t } = useTranslation()
  const phase = step.phase === 'execute'
    ? t('session.timeline.phase.execute')
    : t('session.timeline.phase.verify')
  return (
    <TimelineStageSection
      testIdPrefix="workflow-stage"
      eyebrow={t('session.timeline.eyebrow.workflow', {
        phase,
        index: step.stepIndex + 1,
        count: step.stepCount,
      })}
      title={step.title}
      status={step.status}
      summary={step.summary}
    >
      {blocks.map((block, index) => (
        <TimelineBlock
          key={timelineKey(block, index)}
          block={block}
          streaming={streaming}
          sessionId={sessionId}
        />
      ))}
    </TimelineStageSection>
  )
}

/** Build-specific adapter: only the currently open section pulses as running. */
function BuildStageSection({
  stage,
  blocks,
  active,
  streaming,
  sessionId,
}: {
  stage: BuildStage
  blocks: MessageBlock[]
  active: boolean
  streaming: boolean
  sessionId?: string
}) {
  const { t } = useTranslation()
  const index = BUILD_STAGES.indexOf(stage)
  return (
    <TimelineStageSection
      testIdPrefix="build-stage"
      eyebrow={t('session.timeline.eyebrow.build', { index: index + 1, count: BUILD_STAGES.length })}
      title={t(`focusMode.stages.${stage}`)}
      status={active ? 'running' : 'neutral'}
    >
      {blocks.map((block, blockIndex) => (
        <TimelineBlock
          key={timelineKey(block, blockIndex)}
          block={block}
          streaming={streaming}
          sessionId={sessionId}
        />
      ))}
    </TimelineStageSection>
  )
}

/** Completed interaction summary with an expandable read-only detail card. */
function CompletedInteractionRow({ block, sessionId }: { block: CompletedInteractionBlock; sessionId?: string }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  let label = t('session.interaction.label.confirmed')
  let detail = ''
  let icon = Icons.check(13)
  let tone = 'bg-status-success-bg text-status-success'

  if (block.type === 'confirmation') {
    detail = [block.question, block.response].filter(Boolean).join(' · ')
    if (block.kind === 'accept_rule_message') {
      label = t('session.interaction.label.acceptRuleDeferred')
      detail = block.response
      icon = Icons.chat(13)
      tone = 'bg-status-warning-bg text-status-warning'
    } else if (block.kind === 'confirmation_message') {
      label = t('session.interaction.label.replied', { question: block.question })
      detail = block.response
      icon = Icons.chat(13)
      tone = 'bg-status-warning-bg text-status-warning'
    } else if (block.kind === 'accept_rule') {
      label = block.acceptanceMode === 'execution_only'
        ? t('session.interaction.label.noAcceptanceRule')
        : t('session.interaction.label.acceptanceAligned', { n: block.rules?.length ?? 0 })
      detail = block.rules
        ?.map((rule, index) => t('session.interaction.ruleItem', {
          index: index + 1,
          text: humanizeAcceptanceRuleText(rule.text),
        }))
        .join(' · ') ?? humanizeAcceptanceRuleText(block.response)
      icon = Icons.workflowResult(13)
    }
  } else if (block.type === 'build_confirm') {
    detail = block.goal
    icon = Icons.workflow(13)
    if (block.status === 'cancelled') {
      label = t('session.interaction.label.buildOnce')
      icon = Icons.x(13)
      tone = 'bg-bg-hover text-text-tertiary'
    } else {
      label = t('session.interaction.label.buildConfirmed')
    }
  } else if (block.type === 'task_confirm') {
    if (block.status === 'revision_requested') {
      label = t('session.interaction.label.taskRevision')
      detail = block.feedback ?? ''
      icon = Icons.edit(13)
      tone = 'bg-status-warning-bg text-status-warning'
    } else {
      label = t('session.interaction.label.taskConfirmed')
      detail = 'task.md'
      icon = Icons.file(13)
    }
  } else if (block.type === 'workflow_confirm') {
    const name = block.name || block.defaultName
    if (block.status === 'cancelled') {
      label = t('session.interaction.label.workflowSaveCancelled')
      icon = Icons.x(13)
      tone = 'bg-bg-hover text-text-tertiary'
    } else {
      label = t('session.interaction.label.workflowSaved')
      detail = name
      icon = Icons.workflow(13)
    }
  } else {
    const allowed = block.items.filter((item) => item.decision === 'allow').length
    const denied = block.items.filter((item) => item.decision === 'deny').length
    label = t('session.interaction.label.permissionDone')
    detail = t('session.interaction.permissionDetail', { allowed, denied })
  }

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="group flex w-full min-w-0 items-center gap-2 text-left text-xs leading-5 text-text-secondary"
      >
        <span className={cn('flex h-5 w-5 shrink-0 items-center justify-center rounded-full', tone)}>
          {icon}
        </span>
        <span className="shrink-0 font-medium text-text-secondary">{label}</span>
        {detail && <span className="min-w-0 flex-1 truncate text-text-tertiary">{detail}</span>}
        <span className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-text-tertiary group-hover:text-text-secondary">
          {open ? t('session.interaction.hideRecord') : t('session.interaction.showRecord')}
          <span className={cn('transition-transform duration-200', open && 'rotate-90')}>
            {Icons.chevronRight(11)}
          </span>
        </span>
      </button>
      <Collapse open={open}>
        <div className="pl-7 pt-2">
          <CompletedInteractionCard block={block} sessionId={sessionId} />
        </div>
      </Collapse>
    </div>
  )
}
