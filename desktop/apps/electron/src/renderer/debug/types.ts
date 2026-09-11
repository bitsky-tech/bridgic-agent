import type { DesktopDebugTurn } from '../../shared/debug-types'

export type TraceTurnInput = Pick<DesktopDebugTurn,
  'id' | 'sessionId' | 'sessionOrdinal' | 'status' | 'model' | 'durationMs' | 'otaRecords' | 'otaContext'>

export type TraceStatus = 'success' | 'error' | 'unknown'
export type TraceUsageField = 'inputTokens' | 'outputTokens' | 'totalTokens' | 'cachedInputTokens' | 'cacheCreationInputTokens'
export type TraceUsageIssue = 'missing' | 'invalid' | 'conflict' | 'estimated' | null

export interface TraceToolCall {
  id: string
  roundId: string
  turnId: string
  turnOrdinal: number
  ordinal: number
  sourceCallId: string | null
  name: string | null
  /** Undefined means absent; null, arrays, strings and empty values remain intact. */
  arguments: unknown
  result: unknown
  error: unknown
  hasResult: boolean
  pairing: 'id' | 'arguments' | 'missing' | 'unmatched'
  status: TraceStatus
  /** Only a duration on this individual result, never the round's action total. */
  durationMs: number | null
  rawCall: unknown
  rawResult: unknown
}

export interface TraceRound {
  id: string
  sourceRoundId: string | null
  turnId: string
  sessionId: string
  turnOrdinal: number
  ordinal: number
  mode: string | null
  stage: string | null
  body: string | null | undefined
  thinking: string | null | undefined
  model: string | null
  modelSource: 'round' | 'turn' | null
  status: TraceStatus
  /** Explicit round wall time only; Turn totals are not assigned to rounds. */
  durationMs: number | null
  /** Recorded wall time of the whole action group; not an individual tool time. */
  actDurationMs: number | null
  usage: Record<TraceUsageField, number | null>
  usageSources: Record<TraceUsageField, string[]>
  usageIssues: Record<TraceUsageField, TraceUsageIssue>
  calls: TraceToolCall[]
  /** Exact top-level stored fields, with their original keys. Never a reconstruction. */
  recordedRequest: Record<string, unknown>
  raw: unknown
}

export interface TraceRecordIssue {
  turnId: string
  roundId?: string
  path: string
  code: 'invalid_ota_records' | 'invalid_round' | 'invalid_tool_calls' | 'invalid_tool_results'
}

export interface TraceRecords {
  rounds: TraceRound[]
  calls: TraceToolCall[]
  issues: TraceRecordIssue[]
}
