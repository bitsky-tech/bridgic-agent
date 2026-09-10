export type DebugRecordStatus = 'success' | 'error' | 'running' | 'cancelled' | 'waiting' | 'example'
export type DebugRecordSource = 'fixture' | 'simulation'

export interface DebugPromptMessage {
  id: string
  label: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  fidelity: 'illustrative' | 'recorded'
}

export interface DebugToolDefinition {
  name: string
  description: string
  schema: Record<string, unknown> | null
}

export interface DebugToolCall {
  id: string
  sourceCallId: string
  roundId: string
  sourceRoundId: string
  turnId: string
  turnOrdinal: number
  roundLabel: string
  stageId: string
  stageLabel: string
  name: string
  summary: string
  status: DebugRecordStatus
  arguments: Record<string, unknown>
  result: unknown
  error: string | null
  durationMs: number | null
  startedAt: number | null
  source: DebugRecordSource
}

export interface DebugRound {
  id: string
  sourceRoundId: string
  turnId: string
  turnOrdinal: number
  label: string
  stageId: string
  stageLabel: string
  title: string
  summary: string
  status: DebugRecordStatus
  source: DebugRecordSource
  promptMessages: DebugPromptMessage[]
  toolDefinitions: DebugToolDefinition[]
  model: string | null
  modelOptions: Record<string, unknown> | null
  output: string | null
  decision: string
  evidence: string[]
  beforeState: Record<string, unknown> | null
  afterState: Record<string, unknown> | null
  durationMs: number | null
  calls: DebugToolCall[]
}

export interface DebugRecords { rounds: DebugRound[]; calls: DebugToolCall[] }
export interface DebugOpenRequest { kind: 'tool' | 'round'; id: string; nonce: number }

export function debugRoundId(turnId: string, sourceRoundId: string): string {
  return JSON.stringify([turnId, sourceRoundId])
}

export function debugCallId(turnId: string, sourceRoundId: string, sourceCallId: string): string {
  return JSON.stringify([turnId, sourceRoundId, sourceCallId])
}
