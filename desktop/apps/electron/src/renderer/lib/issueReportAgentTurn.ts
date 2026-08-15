import type { IssueReportAgentTurnSnapshot } from '@/atoms/issue-report'
import type { MessageBlock } from '@/atoms/agent'
import { splitProcessAndAnswer } from './qaSegments'

export interface IssueReportAgentTurnLabels {
  displayedReasoning: string
  duration: string
  empty: string
  error: string
  event: string
  finalReply: string
  processMessage: string
  status: string
  stopped: string
  toolCall: string
  toolFailure: string
  toolInput: string
  toolPending: string
  toolResult: string
  toolSuccess: string
}

const DEFAULT_LABELS: IssueReportAgentTurnLabels = {
  displayedReasoning: 'Displayed reasoning',
  duration: 'Duration',
  empty: '(none)',
  error: 'Error',
  event: 'Event',
  finalReply: 'Agent final reply',
  processMessage: 'Agent process message',
  status: 'Status',
  stopped: 'Stopped',
  toolCall: 'Tool call',
  toolFailure: 'Failed',
  toolInput: 'Input',
  toolPending: 'Pending',
  toolResult: 'Result',
  toolSuccess: 'Succeeded',
}

/** Serialize the visible parts of one Agent turn for an opt-in issue report. */
export function serializeIssueReportAgentTurn(
  snapshot: IssueReportAgentTurnSnapshot,
  labels: IssueReportAgentTurnLabels = DEFAULT_LABELS,
): string {
  const blocks = [...(snapshot.blocks ?? [])]
  const { answer } = splitProcessAndAnswer(blocks, snapshot.finalAnswer)
  const chunks: string[] = []

  const renderValue = (value: unknown): string => {
    if (typeof value === 'string') return value || labels.empty
    if (value === undefined) return labels.empty
    try {
      return JSON.stringify(value, null, 2) ?? String(value)
    } catch {
      return String(value)
    }
  }

  const addChunk = (heading: string, content: unknown) => {
    const body = renderValue(content).trim()
    if (body) chunks.push(`[${heading}]\n${body}`)
  }

  const answerFromBlocks = answer
    .filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
  const authoritativeAnswer = snapshot.finalAnswer?.trim() ?? ''
  const legacyAnswer = blocks.length === 0 ? snapshot.fallbackText?.trim() ?? '' : ''
  const finalAnswer = snapshot.finalAnswer !== undefined
    ? authoritativeAnswer
    : answerFromBlocks || legacyAnswer
  const answerTextBlocks = new Set<MessageBlock>(finalAnswer
    ? answer.filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
    : [])
  if (finalAnswer) addChunk(labels.finalReply, finalAnswer)

  const addTool = (
    tool: Extract<MessageBlock, { type: 'tool' }> | NonNullable<IssueReportAgentTurnSnapshot['toolCalls']>[number],
  ) => {
    const result = tool.result
    let status = labels.toolPending
    if (result) status = result.isError ? labels.toolFailure : labels.toolSuccess
    const lines = [
      `${labels.toolInput}:`,
      renderValue(tool.input),
      `${labels.status}: ${status}`,
    ]
    if (result && Number.isFinite(result.durationMs)) {
      lines.push(`${labels.duration}: ${result.durationMs} ms`)
    }
    lines.push(`${labels.toolResult}:`, result ? renderValue(result.output) : labels.empty)
    addChunk(`${labels.toolCall}: ${tool.name || labels.empty}`, lines.join('\n'))
    if (tool.subagents?.length) addChunk(`${labels.event}: tool_subagents`, tool.subagents)
  }

  if (blocks.length > 0) {
    for (const block of blocks) {
      if (answerTextBlocks.has(block)) continue
      if (block.type === 'thinking') {
        if (block.text.trim()) addChunk(labels.displayedReasoning, block.text)
      } else if (block.type === 'text') {
        if (block.text.trim()) addChunk(labels.processMessage, block.text)
      } else if (block.type === 'tool') {
        addTool(block)
      } else {
        addChunk(`${labels.event}: ${block.type}`, block)
      }
    }
  } else {
    if (snapshot.thinking?.trim()) addChunk(labels.displayedReasoning, snapshot.thinking)
    for (const tool of snapshot.toolCalls ?? []) addTool(tool)
  }

  if (snapshot.error?.trim()) addChunk(labels.error, snapshot.error)
  if (snapshot.stopped) addChunk(labels.status, labels.stopped)
  return chunks.join('\n\n---\n\n')
}
