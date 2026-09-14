import { atom } from 'jotai'
import type { AgentMessageToolCall, MessageBlock } from '@shared/types'

export type IssueReportMessageRole = 'user' | 'assistant'

export interface IssueReportModelSnapshot {
  modelId: string
  providerId?: string
}

export interface IssueReportThinkingSnapshot {
  mode: 'normal' | 'build' | 'presentation' | 'run_workflow'
  stage: string | null
}

/** Complete source data for one Agent Turn, including legacy transcript fallbacks. */
export interface IssueReportAgentTurnSnapshot {
  blocks: MessageBlock[]
  finalAnswer?: string | null
  fallbackText?: string
  thinking?: string
  toolCalls?: AgentMessageToolCall[]
  error?: string
  stopped?: boolean
}

/**
 * Context frozen at the moment a report is opened.
 *
 * Keeping this independent of the active Session prevents a later Session switch
 * from silently changing the material shown in the report preview.
 */
export interface IssueReportSourceSnapshot {
  source: 'message' | 'gateway' | 'renderer'
  sessionId?: string
  messageId?: string
  turnId?: string
  sourceRole?: IssueReportMessageRole
  userText?: string
  assistantText?: string
  agentTurn?: IssueReportAgentTurnSnapshot
  model?: IssueReportModelSnapshot
  executionMode?: 'request' | 'auto' | 'full'
  thinking?: IssueReportThinkingSnapshot
  error?: string
  turnStatus?: string
  completedAt?: number | null
  durationMs?: number | null
}

export interface IssueReportRequestSnapshot extends IssueReportSourceSnapshot {
  openedAt: number
}

const _issueReportRequest = atom<IssueReportRequestSnapshot | null>(null)

/** Current singleton request; null means the report dialog is closed. */
export const issueReportRequestAtom = atom((get) => get(_issueReportRequest))

/** Open the singleton dialog with a defensive snapshot of its source context. */
export const openIssueReportAtom = atom(
  null,
  (_get, set, source: IssueReportSourceSnapshot) => {
    set(_issueReportRequest, {
      ...source,
      ...(source.model ? { model: { ...source.model } } : {}),
      ...(source.thinking ? { thinking: { ...source.thinking } } : {}),
      ...(source.agentTurn ? { agentTurn: structuredClone(source.agentTurn) } : {}),
      openedAt: Date.now(),
    })
  },
)

/** Close the dialog and discard its captured context. */
export const closeIssueReportAtom = atom(null, (_get, set) => {
  set(_issueReportRequest, null)
})
