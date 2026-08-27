import type {
  JsonObject,
  NativeToolCall,
  PromptComponent,
  PromptMessage,
  PromptReconstruction,
  PromptRole,
} from '../api/types'

export type CanonicalPromptBlockKind =
  | 'persona'
  | 'context'
  | 'session_history'
  | 'current_input'
  | 'current_turn'
  | 'tools'

export type ReadablePromptFidelity = 'exact' | 'reconstructed' | 'partial' | 'unavailable'

export interface PromptViewOptions {
  /** Localized display titles may be supplied by the React/i18n layer. */
  blockTitles?: Partial<Record<CanonicalPromptBlockKind, string>>
  documentTitle?: string
  emptyBlockText?: string
  /** Diagnostic opt-in. Prompt analysis hides non-readable provider replay metadata by default. */
  includeMessageExtras?: boolean
}

export interface ReadableToolCall extends NativeToolCall {
  argumentsText: string
}

export interface ReadablePromptMessage {
  id: string
  index: number
  role: PromptRole
  heading: string
  label: string
  content: string | null
  toolCallId?: string
  toolCalls: ReadableToolCall[]
  extras: JsonObject | null
  text: string
  copyText: string
}

export interface PromptTranscriptView {
  messages: ReadablePromptMessage[]
  text: string
}

export interface ReadablePromptBlock {
  /** Directly compatible with PromptReadableView's block key. */
  id: string
  kind: CanonicalPromptBlockKind
  title: string
  /** Directly compatible with PromptReadableView's display label. */
  label: string
  originalLabel: string | null
  componentId: string | null
  fidelity: ReadablePromptFidelity
  description?: string
  sources: string[]
  limitations: string[]
  metadata?: JsonObject
  messageIndexes: number[]
  unresolvedMessageIndexes: number[]
  text: string
  characterCount: number
  empty: boolean
  defaultExpanded?: boolean
}

export interface PromptViewModel {
  sessionId: string
  turnId: string
  roundId: string
  roundIndex: number
  stage: string
  model: string | null
  blocks: ReadablePromptBlock[]
  transcript: PromptTranscriptView
  toolSurfaceText: string
  /** One copyable, human-readable projection of the complete native model request. */
  assembledText: string
  fidelity: PromptReconstruction['fidelity']
  reconstructedAt: string
  unmappedComponents: PromptComponent[]
}

export interface RenderTranscriptOptions {
  /** Diagnostic opt-in. Keep disabled in user-facing Prompt analysis. */
  includeMessageExtras?: boolean
  /** Original indexes to retain when rendering a component subset. */
  messageIndexes?: readonly number[]
}

export type PromptViewInput = PromptReconstruction
export type PromptViewMessage = PromptMessage
