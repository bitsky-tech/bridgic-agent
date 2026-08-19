import type { CognitiveModeDescriptor } from './cognitive-mode'

export type LabModuleId = 'agent-loop' | 'file-import' | 'memory'

export type RunStatus = 'completed' | 'running' | 'attention'

export type PhaseKind = 'observe' | 'think' | 'permission' | 'act' | 'state'

export interface Phase {
  kind: PhaseKind
  label: string
  detail: string
  tone?: 'accent' | 'success' | 'warning'
}

export interface ToolCall {
  name: string
  status: 'success' | 'error'
  duration: string
  permission: string
  arguments: Record<string, unknown>
  result: string
}

export interface PromptSnapshot {
  fidelity: 'captured' | 'reconstructed'
  hash: string
  components: Array<{ label: string; percent: number }>
  messages: string
}

export interface RoundTrace {
  id: string
  ordinal: number
  cognitiveMode: CognitiveModeDescriptor
  summary: string
  reasoning: string
  observation: string
  phases: Phase[]
  inputTokens: number | null
  outputTokens: number | null
  duration: string
  prompt: PromptSnapshot
  tools: ToolCall[]
  stateBefore: string
  stateAfter: string
  logs: string[]
}

export interface SessionTrace {
  id: string
  parentId?: string
  title: string
  task: string
  status: RunStatus
  mode: string
  model: string
  duration: string
  inputTokens: number
  outputTokens: number
  updatedAt: string
  rounds: RoundTrace[]
  turnId?: string
  turnOrdinal?: number
  turnCount?: number
  executionMode?: string | null
  maxRounds?: number | null
  finalAnswer?: string | null
  error?: string | null
}
