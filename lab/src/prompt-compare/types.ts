import type { PromptReconstruction } from '../api/types'
import type { PromptCacheInvocationPotential } from '../analytics/cache-potential'
import type { CanonicalPromptBlockKind, ReadablePromptFidelity } from '../prompt-view'

export type PromptBlockChangeStatus = 'same' | 'changed' | 'added' | 'removed'
export type PromptMessageBlockKind = Exclude<CanonicalPromptBlockKind, 'tools'>

/** One side of a readable message-block or tool-surface comparison. */
export interface PromptComparisonBlockSide {
  text: string
  characterCount: number
  /** A lightweight UTF-8 byte estimate, not provider tokenizer telemetry. */
  estimatedTokenCount: number
  fidelity: ReadablePromptFidelity
}

export interface PromptSectionComparison {
  title: string
  status: PromptBlockChangeStatus
  baseline: PromptComparisonBlockSide | null
  current: PromptComparisonBlockSide | null
  /** Short excerpts centred near the first character difference. */
  beforeText: string | null
  afterText: string | null
  characterDelta: number
  estimatedTokenDelta: number
  commonPrefixCharacterCount: number
  commonSuffixCharacterCount: number
}

/** One position in the ordered native-message projection. */
export interface PromptBlockComparison extends PromptSectionComparison {
  kind: PromptMessageBlockKind
  order: number
}

/** Tool definitions supplied beside, rather than inside, the ordered messages. */
export interface PromptToolSurfaceComparison extends PromptSectionComparison {
  kind: 'tools'
}

export interface PromptComparisonEndpoint {
  sessionId: string
  turnId: string
  roundId: string
  roundIndex: number
  stage: string
  model: string | null
}

export interface PromptComparison {
  baseline: PromptComparisonEndpoint
  current: PromptComparisonEndpoint
  /** Ordered message-backed Prompt blocks only. */
  blocks: PromptBlockComparison[]
  /** Independent comparison of the parallel top-level tool definitions. */
  toolSurface: PromptToolSurfaceComparison
  /** First changed message block; tool-only changes leave this null. */
  firstChangedBlock: PromptMessageBlockKind | null
  /** Counts describe `blocks`; the independent tool surface has its own status. */
  changedBlockCount: number
  sameBlockCount: number
}

export interface PromptComparisonOptions {
  /** Maximum size of each before/after excerpt. Defaults to 240 characters. */
  excerptCharacterLimit?: number
  /** Optional localized block titles. */
  blockTitles?: Partial<Record<CanonicalPromptBlockKind, string>>
}

export type PromptComparisonInput = PromptReconstruction

export interface PromptCacheComparisonIdentity {
  id: string
  /** Language-neutral fallback. Consumers can localize from the ordinals. */
  label: string
  turnOrdinal: number | null
  roundOrdinal: number
  model: string | null
  inputTokens: number | null
  outputTokens: number | null
}

export interface PromptCacheComparisonSection<Kind extends CanonicalPromptBlockKind> {
  id: Kind
  kind: Kind
  label: string
  status: 'unchanged' | 'changed' | 'added' | 'removed'
  baselineText: string | null
  currentText: string | null
  hitTokens: number | null
  missTokens: number | null
}

export type PromptCacheComparisonBlock = PromptCacheComparisonSection<PromptMessageBlockKind>
export type PromptCacheToolSurfaceComparison = PromptCacheComparisonSection<'tools'>

export interface PromptCacheComparisonViewModel {
  id: string
  baseline: PromptCacheComparisonIdentity
  current: PromptCacheComparisonIdentity
  hitTokens: number
  missTokens: number
  hitRate: number
  /** Ordered message-backed Prompt blocks only. */
  blocks: PromptCacheComparisonBlock[]
  /** Independent cache/diff data for the parallel tool definitions. */
  toolSurface: PromptCacheToolSurfaceComparison
  /** First changed message block, independent of any tool-surface cache miss. */
  firstChangedBlockId: PromptMessageBlockKind | null
}

/** Resolve persisted output usage for an invocation when the caller can attribute it. */
export type PromptCacheTurnOutputResolver = (
  turnId: string,
  invocation: PromptCacheInvocationPotential,
  turnInvocationCount: number,
) => number | null
