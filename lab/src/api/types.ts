export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[]

export interface JsonObject {
  [key: string]: JsonValue
}

export type SourceStatus = 'connected' | 'missing' | 'error'

export interface SourceHealth {
  status: SourceStatus
  readonly: boolean
  path: string
  counts: {
    sessions: number
    turns: number
    mounts: number
  } | null
  sizeBytes?: number | null
  lastModifiedAt?: string | null
  error?: { code: string; message: string } | null
}

type ExtensibleString<Known extends string> = Known | (string & Record<never, never>)

export type SessionStatus = ExtensibleString<'finish' | 'completed' | 'awaiting'>
export type SessionKind = ExtensibleString<'user' | 'scheduled'>
export type SubagentMode = ExtensibleString<'background' | 'blocking' | 'rpc'>

export interface SessionSummary {
  id: string
  title: string | null
  status: SessionStatus
  kind: SessionKind
  parentSessionId: string | null
  parentCallId: string | null
  subagentMode: SubagentMode | null
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

export interface SessionMount {
  id: string
  sessionId: string
  name: string
  absPath: string
  kind: 'file' | 'folder'
  createdAt: string
}

export interface WorkspaceMetadata {
  root: string
  mounts: SessionMount[]
}

export interface UserInput {
  text: string
  blocks: JsonObject[]
}

export type TurnStatus = ExtensibleString<
  | 'awaiting_human'
  | 'awaiting_permission'
  | 'awaiting_subagents'
  | 'completed'
  | 'failed'
  | 'cancelled'
>

export interface TokenUsage {
  input: number
  output: number
}

export interface TurnSummary {
  id: string
  sessionId: string
  sessionOrdinal: number
  userInput: UserInput
  status: TurnStatus
  finalAnswer: string | null
  error: string | null
  executionMode: string | null
  maxRounds: number | null
  model: string | null
  inputTokens: number
  outputTokens: number
  createdAt: string
  completedAt: string | null
  durationMs: number | null
}

export interface OtaToolCall {
  callId: string | null
  tool: string
  arguments: JsonObject | JsonValue[]
  raw: JsonObject
}

export interface OtaThinkResult {
  stepContent: string
  toolCalls: OtaToolCall[]
  raw: JsonObject
}

export interface OtaToolResult {
  toolId: string | null
  toolName: string
  toolArguments: JsonObject
  toolResult: JsonValue
  success: boolean
  error: string | null
  raw: JsonObject
}

export interface OtaActionResult {
  results: OtaToolResult[]
  raw: JsonObject
}

export interface OtaPermissionVerdict {
  id: string | null
  tool: string
  arguments: JsonObject
  verdict: string
  reason: string | null
  raw: JsonObject
}

export interface OtaPermission {
  executionMode: string | null
  reviewed: boolean
  verdicts: OtaPermissionVerdict[]
  items: JsonObject[]
  raw: JsonObject
}

/** A normalized view of one persisted observe-think-act record. */
export interface OtaRound {
  id: string
  ordinal: number
  observationResult: JsonValue
  thinkResult: OtaThinkResult | null
  permission: OtaPermission | null
  actionResult: OtaActionResult | null
  durationMs: number | null
  raw: JsonObject
}

export interface TurnDetail extends TurnSummary {
  otaRecords: OtaRound[]
  agentState: JsonObject | null
  browserToolLoaded: boolean
  workspaceToolsLoaded: boolean
  skillsToolLoaded: boolean
  mounts: SessionMount[]
  session: SessionSummary
  workspace: WorkspaceMetadata
}

export interface Page<T> {
  items: T[]
  nextCursor: string | null
  total: number
}

export type PromptRole = ExtensibleString<'system' | 'developer' | 'user' | 'assistant' | 'tool'>

export interface NativeToolCall {
  id: string
  name: string
  arguments: JsonObject
}

export interface PromptMessage {
  role: PromptRole
  content: string | null
  toolCalls?: NativeToolCall[]
  toolCallId?: string
  extras?: JsonObject
}

export type PromptComponentKind = ExtensibleString<
  'persona' | 'context' | 'session_history' | 'current_input' | 'current_turn' | 'tools'
>
export type PromptComponentFidelity = ExtensibleString<'exact' | 'reconstructed' | 'partial' | 'unavailable'>

export interface PromptComponent {
  id: string
  kind: PromptComponentKind
  label: string
  content?: string
  messageIndexes: number[]
  source: string[]
  fidelity: PromptComponentFidelity
  limitations: string[]
  metadata?: JsonObject
}

export interface PromptToolSummary {
  name: string
  description: string
  group: string
  advanced: boolean
  required: string[]
  properties: string[]
  parameters: JsonObject
  schemaFidelity: ExtensibleString<'snapshot' | 'lab_catalog' | 'observed' | 'name_only'>
}

export interface PromptFidelity {
  level: ExtensibleString<'reconstructed' | 'partial'>
  score: number
  exactComponents: number
  totalComponents: number
  limitations: string[]
}

export interface PromptReconstruction {
  sessionId: string
  turnId: string
  roundId: string
  roundIndex: number
  stage: string
  model: string | null
  messages: PromptMessage[]
  tools: PromptToolSummary[]
  components: PromptComponent[]
  fidelity: PromptFidelity
  reconstructedAt: string
}

export interface PromptReconstructionList {
  items: PromptReconstruction[]
  total: number
}

export interface ListSessionsParams {
  cursor?: string
  limit?: number
  query?: string
}

export interface ListTurnsParams {
  cursor?: string
  limit?: number
}

export interface RequestOptions {
  signal?: AbortSignal
}
