import { useMemo } from 'react'
import { useAtomValue } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  currentMessagesAtom,
  currentStreamingAtom,
  currentWorkflowRunAtom,
} from '@/atoms/agent'
import type { MessageBlock } from '@shared/types'

type WorkflowStepBlock = Extract<MessageBlock, { type: 'workflow_step' }>

export interface WorkflowRunProjection {
  workflowId: string | undefined
  generation: string | undefined
  workflowName: string
  phase: 'execute'
  stepIndex: number
  stageComplete: boolean
  executionSteps: string[]
  currentTitle: string
  toolCalls: number
  workflowBlocks: WorkflowStepBlock[]
}

/** Build the shared live Run view used by the status bar and right-column pane. */
export function useWorkflowRunProjection(): WorkflowRunProjection {
  const { t } = useTranslation()
  const run = useAtomValue(currentWorkflowRunAtom)
  const messages = useAtomValue(currentMessagesAtom)
  const streaming = useAtomValue(currentStreamingAtom)

  return useMemo(() => {
    const rows = streaming ? [...messages, streaming] : messages
    const allWorkflowBlocks = rows.flatMap((message) =>
      (message.blocks ?? []).filter(
        (block): block is WorkflowStepBlock => block.type === 'workflow_step',
      ),
    )
    const latestLive = streaming?.blocks
      .filter((block): block is WorkflowStepBlock => block.type === 'workflow_step')
      .at(-1)
    const generation = run?.generation ?? latestLive?.generation
    const workflowId = run?.workflowId ?? latestLive?.workflowId
    const workflowBlocks = allWorkflowBlocks.filter(
      (block) => block.generation === generation,
    )
    const latest = workflowBlocks.at(-1)
    const runRows = rows.filter((message) =>
      (message.blocks ?? []).some(
        (block) => block.type === 'workflow_step' && block.generation === generation,
      ),
    )
    const toolCalls = runRows.reduce(
      (count, message) =>
        count + (message.blocks ?? []).filter((block) => block.type === 'tool').length,
      0,
    )
    const phase = 'execute' as const
    const stepIndex = run?.stepIndex ?? latest?.stepIndex ?? 0
    const executionSteps = [...(run?.executionSteps ?? latest?.executionSteps ?? [])]

    if (executionSteps.length === 0) {
      const count = latest?.stepCount ?? stepIndex + 1
      for (let index = 0; index < count; index += 1) {
        const known = workflowBlocks.find(
          (block) => block.phase === 'execute' && block.stepIndex === index,
        )
        executionSteps.push(
          known?.title || t('workflowRunDetails.fallbackExecutionStep', { index: index + 1 }),
        )
      }
    }
    const stageComplete = executionSteps.length > 0 && stepIndex >= executionSteps.length
    const currentStepIndex = stageComplete
      ? Math.max(0, executionSteps.length - 1)
      : stepIndex
    const currentBlock = [...workflowBlocks].reverse().find(
      (block) => block.phase === phase && block.stepIndex === currentStepIndex,
    )
    let currentTitle = currentBlock?.title
      ?? executionSteps[currentStepIndex]
      ?? t('workflowRunDetails.initializing')
    if (stageComplete) {
      currentTitle = t('workflowRunDetails.executionCompleteAwaitingEnd')
    }

    return {
      workflowId,
      generation,
      workflowName: run?.workflowName ?? latest?.workflowName ?? t('workflowRunDetails.title'),
      phase,
      stepIndex,
      stageComplete,
      executionSteps,
      currentTitle,
      toolCalls,
      workflowBlocks,
    }
  }, [messages, run, streaming, t])
}
