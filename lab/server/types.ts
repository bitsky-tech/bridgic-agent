export type SourceStatus = 'connected' | 'missing' | 'error'

export interface SourceHealth {
  status: SourceStatus
  readonly: true
  path: string
  counts: {
    sessions: number
    turns: number
    mounts: number
  } | null
  sizeBytes: number | null
  lastModifiedAt: string | null
  error: {
    code: 'state_db_missing' | 'state_db_unavailable'
    message: string
  } | null
}

export interface SessionItem {
  id: string
  title: string | null
  status: 'finish' | 'completed' | 'awaiting' | 'unknown'
  kind: 'user' | 'scheduled' | 'unknown'
  parentSessionId: string | null
  parentCallId: string | null
  subagentMode: 'background' | 'blocking' | 'rpc' | 'unknown' | null
  workspaceRoot: string
  scheduleId: string | null
  lastUsedModel: string | null
  lastAnswer: string | null
  createdAt: string
  updatedAt: string
  turnCount: number
  inputTokens: number
  outputTokens: number
}

export interface UserInput {
  text: string
  blocks: Record<string, unknown>[]
}

export interface TurnItem {
  id: string
  sessionId: string
  sessionOrdinal: number
  userInput: UserInput
  status:
    | 'awaiting_human'
    | 'awaiting_permission'
    | 'awaiting_subagents'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'unknown'
  finalAnswer: string | null
  error: string | null
  executionMode: 'request' | 'auto' | 'full' | null
  maxRounds: number | null
  model: string | null
  inputTokens: number
  outputTokens: number
  createdAt: string
  completedAt: string | null
  durationMs: number | null
}

export interface MountItem {
  id: string
  sessionId: string
  name: string
  absPath: string
  kind: 'file' | 'folder' | 'unknown'
  createdAt: string
}

export interface OtaRecordItem {
  id: string
  ordinal: number
  observationResult: unknown
  thinkResult: unknown
  permission: unknown
  actionResult: unknown
  turnDurationMs?: number
  raw: Record<string, unknown>
}

export interface TurnDetail extends TurnItem {
  otaRecords: OtaRecordItem[]
  agentState: Record<string, unknown> | null
  browserToolLoaded: boolean
  workspaceToolsLoaded: boolean
  skillsToolLoaded: boolean
  mounts: MountItem[]
  session: SessionItem
}

export interface PromptConversation {
  target: TurnDetail
  turns: TurnDetail[]
}

export interface SessionPromptConversation {
  session: SessionItem
  mounts: MountItem[]
  turns: TurnDetail[]
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  total: number
}
