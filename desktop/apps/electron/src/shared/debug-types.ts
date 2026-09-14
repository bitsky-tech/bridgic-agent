/** Development-only transport. JSON fields retain their stored shape, including
 * missing values and malformed legacy text; consumers must narrow unknowns. */
export interface DesktopDebugTurn {
  id: string
  sessionId: string
  sessionOrdinal: number
  status: string
  createdAt: string
  userInput: unknown
  finalAnswer: string | null
  error: string | null
  executionMode: string | null
  maxRounds: number | null
  /** Captured on this Turn; never substituted with today's model selection. */
  model: string | null
  durationMs: number | null
  otaRecords: unknown
  otaContext: unknown
  otaContextSource: 'stored' | 'assembled_from_stored_fields' | 'unavailable'
  agentState: unknown
  contextUsage: unknown
}

/** Latest Turns first, ordered by (session_ordinal DESC, id DESC). */
export interface DesktopDebugTurnsPage {
  sessionId: string
  turns: DesktopDebugTurn[]
  nextCursor: string | null
  hasMore: boolean
}

export interface DesktopDebugError {
  error: { code: string; message: string }
}
