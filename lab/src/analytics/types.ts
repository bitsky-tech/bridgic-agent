export type AnalyticsAvailability = 'available' | 'partial' | 'unavailable'

export type AnalyticsReasonCode =
  | 'no_samples'
  | 'incomplete_coverage'
  | 'not_persisted'
  | 'not_reported'
  | 'invalid_value'
  | 'conflicting_values'
  | 'partial_samples'
  | 'not_applicable'

export interface AnalyticsReason {
  code: AnalyticsReasonCode
  message: string
  availableSamples?: number
  totalSamples?: number
}

export interface AnalyticsMetricSource {
  kind: 'persisted' | 'derived'
  path: string
  turnId?: string
  roundId?: string
}

interface AnalyticsMetricBase<T> {
  sources: AnalyticsMetricSource[]
  /** Exact paths checked when the metric was built, including absent paths. */
  inspectedPaths: string[]
  value: T | null
}

export interface AvailableMetric<T> extends AnalyticsMetricBase<T> {
  availability: 'available'
  value: T
  reason: null
}

export interface PartialMetric<T> extends AnalyticsMetricBase<T> {
  availability: 'partial'
  value: T
  reason: AnalyticsReason
}

export interface UnavailableMetric<T> extends AnalyticsMetricBase<T> {
  availability: 'unavailable'
  value: null
  reason: AnalyticsReason
}

export type AnalyticsMetric<T> = AvailableMetric<T> | PartialMetric<T> | UnavailableMetric<T>

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface TokenTrendPoint extends TokenCounts {
  turnId: string
  ordinal: number
  createdAt: string
  model: string | null
  cumulativeInputTokens: number
  cumulativeOutputTokens: number
  cumulativeTotalTokens: number
}

export interface DataCoverage {
  expectedTurns: number
  loadedTurnSummaries: number
  loadedTurnDetails: number
  summariesComplete: boolean
  detailsComplete: boolean
}

export interface SessionTokenAnalytics {
  /** Exact aggregate counters persisted for the Session. */
  persistedTotals: AnalyticsMetric<TokenCounts>
  /** Sum of the currently loaded Turn summaries; partial when pagination is incomplete. */
  loadedTurnTotals: AnalyticsMetric<TokenCounts>
  trend: AnalyticsMetric<TokenTrendPoint[]>
}

export type ProviderUsageField =
  | 'inputTokens'
  | 'outputTokens'
  | 'totalTokens'
  | 'cachedInputTokens'
  | 'cacheCreationInputTokens'

export interface ProviderUsageAnalytics {
  availability: AnalyticsAvailability
  reason: AnalyticsReason | null
  inputTokens: AnalyticsMetric<number>
  outputTokens: AnalyticsMetric<number>
  totalTokens: AnalyticsMetric<number>
  cachedInputTokens: AnalyticsMetric<number>
  cacheCreationInputTokens: AnalyticsMetric<number>
  /** Recognized provider usage container paths. No other JSON keys are interpreted. */
  containers: string[]
}

export interface RequestedToolCallAnalytics {
  callId: string | null
  toolName: string
}

export interface ExecutedToolCallAnalytics {
  callId: string | null
  toolName: string
  success: boolean
  error: string | null
}

export interface RoundAnalytics {
  roundId: string
  ordinal: number
  requestedToolCalls: number
  executedToolCalls: number
  succeededToolCalls: number
  failedToolCalls: number
  requestedTools: RequestedToolCallAnalytics[]
  executedTools: ExecutedToolCallAnalytics[]
  /** Tool execution wall time persisted as `act_duration_ms`, when present. */
  actionDurationMs: AnalyticsMetric<number>
  providerUsage: ProviderUsageAnalytics
}

export interface TurnAnalytics {
  turnId: string
  sessionId: string
  ordinal: number
  totalRounds: number
  requestedToolCalls: number
  executedToolCalls: number
  succeededToolCalls: number
  failedToolCalls: number
  tokens: TokenCounts
  /** Total Turn wall time. This is not a per-round duration. */
  durationMs: AnalyticsMetric<number>
  actionDurationMs: AnalyticsMetric<number>
  providerUsage: ProviderUsageAnalytics
  rounds: RoundAnalytics[]
}

export interface SessionTotalsAnalytics {
  turns: number
  rounds: AnalyticsMetric<number>
  requestedToolCalls: AnalyticsMetric<number>
  executedToolCalls: AnalyticsMetric<number>
  failedToolCalls: AnalyticsMetric<number>
  durationMs: AnalyticsMetric<number>
}

export interface SessionAnalytics {
  sessionId: string
  coverage: DataCoverage
  tokens: SessionTokenAnalytics
  totals: SessionTotalsAnalytics
  providerUsage: ProviderUsageAnalytics
  analyzedTurns: TurnAnalytics[]
}

export interface AnalyticsPanelModel {
  session: SessionAnalytics
  selectedTurn: TurnAnalytics | null
}
