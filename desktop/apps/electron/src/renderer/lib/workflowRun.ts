import type { WorkflowRunSummary } from './amphiClient'
import type { ChatBlock } from '@shared/types'

const TIMEZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/i

function workflowRunDate(value: string): Date {
  return new Date(TIMEZONE_SUFFIX.test(value) ? value : `${value}Z`)
}

/** Format one Workflow Run timestamp in the user's local time. */
export function formatWorkflowRunTimestamp(value: string): string {
  const date = workflowRunDate(value)
  if (Number.isNaN(date.getTime())) return value
  const pad = (part: number) => String(part).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Format one Workflow Run timestamp compactly in the user's local time. */
export function formatWorkflowRunShortTimestamp(value: string): string {
  const date = workflowRunDate(value)
  if (Number.isNaN(date.getTime())) return value
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

/** Human-readable label for a structured Workflow Run mention. */
export function workflowRunMentionLabel(run: Pick<WorkflowRunSummary, 'workflow_name' | 'created_at'>): string {
  const timestamp = formatWorkflowRunTimestamp(run.created_at)
  return timestamp ? `${run.workflow_name} · ${timestamp}` : run.workflow_name
}

/** Return the user input after removing the Workflow command itself. */
export function workflowRunCommandInput(
  run: Pick<WorkflowRunSummary, 'workflow_id' | 'workflow_name' | 'workflow_input'>,
): string {
  const blocks = run.workflow_input.blocks as ChatBlock[]
  const commandIndex = blocks.findIndex(
    (block) => block.type === 'slash' && (
      block.id === run.workflow_id
      || (block.label === run.workflow_name && block.resource === 'workflow')
    ),
  )
  if (commandIndex >= 0) {
    const blockText = (block: ChatBlock): string => {
      if (block.type === 'text') return block.value
      if (block.type === 'mention') return `@${block.label}`
      return `/${block.label}`
    }
    const structuredInput = blocks
      .filter((_block, index) => index !== commandIndex)
      .map(blockText)
      .join('')
      .trim()
    if (structuredInput) return structuredInput
  }

  const input = run.workflow_input.text.trim()
  const command = `/${run.workflow_name}`
  if (!input.startsWith(command)) return input
  const remainder = input.slice(command.length)
  return !remainder || /^\s/.test(remainder) ? remainder.trim() : input
}

/** Return display blocks for a Run input, rebuilding the Workflow token for legacy rows. */
export function workflowRunInputBlocks(
  run: Pick<WorkflowRunSummary, 'workflow_id' | 'workflow_name' | 'workflow_input'>,
): ChatBlock[] {
  const blocks = run.workflow_input.blocks as ChatBlock[]
  if (blocks.some((block) => block.type === 'slash')) return blocks

  const prefix = `/${run.workflow_name}`
  const remainder = run.workflow_input.text.startsWith(prefix)
    ? run.workflow_input.text.slice(prefix.length)
    : run.workflow_input.text
  return [
    { type: 'slash', id: run.workflow_id, label: run.workflow_name, resource: 'workflow' },
    ...(remainder ? [{ type: 'text' as const, value: remainder }] : []),
  ]
}
