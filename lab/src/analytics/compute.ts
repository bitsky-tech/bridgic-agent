import type { JsonObject, JsonValue, OtaRound, SessionSummary, TurnDetail, TurnSummary } from '../api/types'
import type {
  AnalyticsMetric,
  AnalyticsMetricSource,
  AnalyticsPanelModel,
  AnalyticsReason,
  DataCoverage,
  ProviderUsageAnalytics,
  ProviderUsageField,
  RoundAnalytics,
  SessionAnalytics,
  TokenCounts,
  TokenTrendPoint,
  TurnAnalytics,
} from './types'

interface CandidatePath {
  container: readonly string[]
  field: readonly string[]
}

interface CandidateValue {
  path: string
  value: number
}

interface MetricCandidates {
  foundContainers: string[]
  foundValues: CandidateValue[]
  invalidPaths: string[]
  inspectedPaths: string[]
}

const usageContainers = [
  ['usage'],
  ['provider_usage'],
  ['providerUsage'],
  ['usage_metadata'],
  ['usageMetadata'],
] as const

const providerFields: Record<ProviderUsageField, readonly (readonly string[])[]> = {
  inputTokens: [
    ['prompt_tokens'],
    ['input_tokens'],
    ['prompt_token_count'],
  ],
  outputTokens: [
    ['completion_tokens'],
    ['output_tokens'],
    ['candidates_token_count'],
  ],
  totalTokens: [
    ['total_tokens'],
    ['total_token_count'],
  ],
  cachedInputTokens: [
    ['prompt_tokens_details', 'cached_tokens'],
    ['input_tokens_details', 'cached_tokens'],
    ['cache_read_input_tokens'],
    ['cached_content_token_count'],
  ],
  cacheCreationInputTokens: [
    ['cache_creation_input_tokens'],
  ],
}

/**
 * The only usage locations interpreted by the Lab.
 *
 * Keeping this list explicit prevents a tool result containing an unrelated
 * `usage`-like object from being mistaken for model-provider telemetry.
 */
export const PROVIDER_USAGE_CONTAINER_PATHS = usageContainers.map((path) => path.join('.'))

function source(path: string, extras: Partial<AnalyticsMetricSource> = {}): AnalyticsMetricSource {
  return { kind: 'persisted', path, ...extras }
}

function available<T>(value: T, sources: AnalyticsMetricSource[], inspectedPaths: string[]): AnalyticsMetric<T> {
  return { availability: 'available', value, reason: null, sources, inspectedPaths }
}

function partial<T>(
  value: T,
  reason: AnalyticsReason,
  sources: AnalyticsMetricSource[],
  inspectedPaths: string[],
): AnalyticsMetric<T> {
  return { availability: 'partial', value, reason, sources, inspectedPaths }
}

function unavailable<T>(
  reason: AnalyticsReason,
  inspectedPaths: string[],
  sources: AnalyticsMetricSource[] = [],
): AnalyticsMetric<T> {
  return { availability: 'unavailable', value: null, reason, sources, inspectedPaths }
}

function tokenCounts(inputTokens: number, outputTokens: number): TokenCounts {
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readPath(root: JsonObject, path: readonly string[]): { found: boolean; value?: JsonValue } {
  let current: JsonValue = root
  for (const part of path) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) {
      return { found: false }
    }
    current = current[part] as JsonValue
  }
  return { found: true, value: current }
}

function isTokenCount(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function metricCandidates(raw: JsonObject, field: ProviderUsageField): MetricCandidates {
  const foundContainers: string[] = []
  const foundValues: CandidateValue[] = []
  const invalidPaths: string[] = []
  const inspectedPaths: string[] = []

  for (const containerPath of usageContainers) {
    const containerName = containerPath.join('.')
    const container = readPath(raw, containerPath)
    if (!container.found || !isObject(container.value)) continue
    foundContainers.push(containerName)

    for (const fieldPath of providerFields[field]) {
      const fullPath = [...containerPath, ...fieldPath]
      const name = fullPath.join('.')
      inspectedPaths.push(name)
      const candidate = readPath(raw, fullPath)
      if (!candidate.found) continue
      if (isTokenCount(candidate.value)) {
        foundValues.push({ path: name, value: candidate.value })
      } else {
        invalidPaths.push(name)
      }
    }
  }

  if (foundContainers.length === 0) {
    for (const containerPath of usageContainers) {
      for (const fieldPath of providerFields[field]) {
        inspectedPaths.push([...containerPath, ...fieldPath].join('.'))
      }
    }
  }

  return { foundContainers, foundValues, invalidPaths, inspectedPaths }
}

function providerMetric(raw: JsonObject, roundId: string, field: ProviderUsageField): AnalyticsMetric<number> {
  const candidates = metricCandidates(raw, field)
  const metricSources = candidates.foundValues.map((candidate) =>
    source(`raw.${candidate.path}`, { roundId }))

  if (candidates.foundValues.length > 0) {
    const values = [...new Set(candidates.foundValues.map((candidate) => candidate.value))]
    if (values.length > 1) {
      return unavailable({
        code: 'conflicting_values',
        message: `Recognized provider fields disagree for ${field}; no value was selected.`,
      }, candidates.inspectedPaths.map((path) => `raw.${path}`), metricSources)
    }
    const value = values[0]
    if (value === undefined) {
      throw new Error('Provider usage candidate invariant failed')
    }
    if (candidates.invalidPaths.length > 0) {
      return partial(value, {
        code: 'invalid_value',
        message: `A valid ${field} value was found, but other recognized fields were invalid.`,
      }, metricSources, candidates.inspectedPaths.map((path) => `raw.${path}`))
    }
    return available(value, metricSources, candidates.inspectedPaths.map((path) => `raw.${path}`))
  }

  if (candidates.invalidPaths.length > 0) {
    return unavailable({
      code: 'invalid_value',
      message: `Recognized ${field} fields were present but were not non-negative integers.`,
    }, candidates.inspectedPaths.map((path) => `raw.${path}`))
  }

  if (candidates.foundContainers.length > 0) {
    return unavailable({
      code: 'not_reported',
      message: field === 'cachedInputTokens' || field === 'cacheCreationInputTokens'
        ? `Provider usage is persisted, but ${field} is not reported; zero is not assumed.`
        : `Provider usage is persisted, but ${field} is not reported.`,
    }, candidates.inspectedPaths.map((path) => `raw.${path}`))
  }

  return unavailable({
    code: 'not_persisted',
    message: field === 'cachedInputTokens' || field === 'cacheCreationInputTokens'
      ? `No provider cache usage is persisted for this round; zero is not assumed.`
      : `No provider usage is persisted for this round; Turn aggregate tokens are not assigned to a round.`,
  }, candidates.inspectedPaths.map((path) => `raw.${path}`))
}

function providerAvailability(
  metrics: Pick<ProviderUsageAnalytics, 'inputTokens' | 'outputTokens' | 'totalTokens'>,
): Pick<ProviderUsageAnalytics, 'availability' | 'reason'> {
  const core = [metrics.inputTokens, metrics.outputTokens]
  if (core.every((metric) => metric.availability === 'available')) {
    return { availability: 'available', reason: null }
  }

  const availableCore = core
    .filter((metric) => metric.availability !== 'unavailable').length
  const anyUsage = availableCore > 0 || metrics.totalTokens.availability !== 'unavailable'
  if (anyUsage) {
    return {
      availability: 'partial',
      reason: {
        code: 'partial_samples',
        message: 'Only part of the provider token usage was reported.',
      },
    }
  }

  const reasons = [metrics.inputTokens, metrics.outputTokens, metrics.totalTokens]
    .map((metric) => metric.reason?.code)
  if (reasons.every((reason) => reason === 'no_samples')) {
    return {
      availability: 'unavailable',
      reason: {
        code: 'no_samples',
        message: 'No OTA rounds are available for provider usage analysis.',
      },
    }
  }
  const code = reasons.every((reason) => reason === 'not_persisted') ? 'not_persisted' : 'not_reported'
  return {
    availability: 'unavailable',
    reason: {
      code,
      message: code === 'not_persisted'
        ? 'Per-round provider usage is not persisted; Turn aggregate tokens are kept separate.'
        : 'No unambiguous provider token usage is available for this round.',
    },
  }
}

/** Extract provider telemetry only from the explicit allowlist above. */
export function analyzeProviderUsage(raw: JsonObject, roundId = 'round'): ProviderUsageAnalytics {
  const inputTokens = providerMetric(raw, roundId, 'inputTokens')
  const outputTokens = providerMetric(raw, roundId, 'outputTokens')
  const totalTokens = providerMetric(raw, roundId, 'totalTokens')
  const cachedInputTokens = providerMetric(raw, roundId, 'cachedInputTokens')
  const cacheCreationInputTokens = providerMetric(raw, roundId, 'cacheCreationInputTokens')
  const containers = usageContainers
    .filter((path) => isObject(readPath(raw, path).value))
    .map((path) => `raw.${path.join('.')}`)
  return {
    ...providerAvailability({ inputTokens, outputTokens, totalTokens }),
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    containers,
  }
}

function aggregateMetric(metrics: readonly AnalyticsMetric<number>[], label: string): AnalyticsMetric<number> {
  const inspectedPaths = metrics.flatMap((metric) => metric.inspectedPaths)
  const values = metrics.flatMap((metric) => metric.value === null ? [] : [metric.value])
  const sources = metrics.flatMap((metric) => metric.sources)
  if (values.length === 0) {
    const notPersisted = metrics.length > 0
      && metrics.every((metric) => metric.reason?.code === 'not_persisted')
    return unavailable({
      code: metrics.length === 0 ? 'no_samples' : notPersisted ? 'not_persisted' : 'not_reported',
      message: metrics.length === 0
        ? `No samples are available for ${label}.`
        : `No unambiguous samples are available for ${label}.`,
      availableSamples: 0,
      totalSamples: metrics.length,
    }, inspectedPaths, sources)
  }

  const value = values.reduce((sum, current) => sum + current, 0)
  const allAvailable = values.length === metrics.length
    && metrics.every((metric) => metric.availability === 'available')
  if (allAvailable) return available(value, sources, inspectedPaths)
  return partial(value, {
    code: 'partial_samples',
    message: `${label} includes only the samples that were explicitly reported.`,
    availableSamples: values.length,
    totalSamples: metrics.length,
  }, sources, inspectedPaths)
}

function aggregateProviderUsage(items: readonly ProviderUsageAnalytics[]): ProviderUsageAnalytics {
  const inputTokens = aggregateMetric(items.map((item) => item.inputTokens), 'provider input tokens')
  const outputTokens = aggregateMetric(items.map((item) => item.outputTokens), 'provider output tokens')
  const totalTokens = aggregateMetric(items.map((item) => item.totalTokens), 'provider total tokens')
  const cachedInputTokens = aggregateMetric(items.map((item) => item.cachedInputTokens), 'cached input tokens')
  const cacheCreationInputTokens = aggregateMetric(
    items.map((item) => item.cacheCreationInputTokens),
    'cache creation input tokens',
  )
  return {
    ...providerAvailability({ inputTokens, outputTokens, totalTokens }),
    inputTokens,
    outputTokens,
    totalTokens,
    cachedInputTokens,
    cacheCreationInputTokens,
    containers: [...new Set(items.flatMap((item) => item.containers))],
  }
}

function aggregateActionDuration(rounds: readonly RoundAnalytics[]): AnalyticsMetric<number> {
  const applicable = rounds
    .map((round) => round.actionDurationMs)
    .filter((metric) => metric.reason?.code !== 'not_applicable')
  if (applicable.length === 0) {
    return unavailable({
      code: 'not_applicable',
      message: 'This Turn has no persisted action rounds.',
      availableSamples: 0,
      totalSamples: 0,
    }, rounds.flatMap((round) => round.actionDurationMs.inspectedPaths))
  }
  return aggregateMetric(applicable, 'tool execution duration')
}

function actionDuration(round: OtaRound): AnalyticsMetric<number> {
  const path = 'raw.act_duration_ms'
  const candidate = readPath(round.raw, ['act_duration_ms'])
  if (!candidate.found) {
    return unavailable({
      code: round.actionResult === null ? 'not_applicable' : 'not_persisted',
      message: round.actionResult === null
        ? 'This round has no persisted action result.'
        : 'Tool execution duration is not persisted for this round.',
    }, [path])
  }
  if (!isTokenCount(candidate.value)) {
    return unavailable({
      code: 'invalid_value',
      message: 'The persisted tool execution duration is not a non-negative integer.',
    }, [path])
  }
  return available(candidate.value, [source(path, { roundId: round.id })], [path])
}

export function analyzeRound(round: OtaRound): RoundAnalytics {
  const requestedTools = (round.thinkResult?.toolCalls ?? []).map((call) => ({
    callId: call.callId,
    toolName: call.tool,
  }))
  const executedTools = (round.actionResult?.results ?? []).map((result) => {
    const success = result.success && result.error === null
    return {
      callId: result.toolId,
      toolName: result.toolName,
      success,
      error: result.error,
    }
  })
  const failedToolCalls = executedTools.filter((tool) => !tool.success).length
  return {
    roundId: round.id,
    ordinal: round.ordinal,
    requestedToolCalls: requestedTools.length,
    executedToolCalls: executedTools.length,
    succeededToolCalls: executedTools.length - failedToolCalls,
    failedToolCalls,
    requestedTools,
    executedTools,
    actionDurationMs: actionDuration(round),
    providerUsage: analyzeProviderUsage(round.raw, round.id),
  }
}

function turnDuration(turn: TurnSummary): AnalyticsMetric<number> {
  const inspectedPaths = ['turn.durationMs']
  if (turn.durationMs === null) {
    return unavailable({
      code: 'not_persisted',
      message: 'Total Turn duration is not persisted.',
    }, inspectedPaths)
  }
  return available(turn.durationMs, [source('turn.durationMs', { turnId: turn.id })], inspectedPaths)
}

export function analyzeTurn(turn: TurnDetail): TurnAnalytics {
  const rounds = [...turn.otaRecords]
    .sort((left, right) => left.ordinal - right.ordinal)
    .map(analyzeRound)
  return {
    turnId: turn.id,
    sessionId: turn.sessionId,
    ordinal: turn.sessionOrdinal,
    totalRounds: rounds.length,
    requestedToolCalls: rounds.reduce((sum, round) => sum + round.requestedToolCalls, 0),
    executedToolCalls: rounds.reduce((sum, round) => sum + round.executedToolCalls, 0),
    succeededToolCalls: rounds.reduce((sum, round) => sum + round.succeededToolCalls, 0),
    failedToolCalls: rounds.reduce((sum, round) => sum + round.failedToolCalls, 0),
    tokens: tokenCounts(turn.inputTokens, turn.outputTokens),
    durationMs: turnDuration(turn),
    actionDurationMs: aggregateActionDuration(rounds),
    providerUsage: aggregateProviderUsage(rounds.map((round) => round.providerUsage)),
    rounds,
  }
}

function uniqueSessionItems<T extends { id: string; sessionId: string }>(
  sessionId: string,
  items: readonly T[],
): T[] {
  const matching = items.filter((item) => item.sessionId === sessionId)
  return [...new Map(matching.map((item) => [item.id, item])).values()]
}

function coverage(session: SessionSummary, turns: readonly TurnSummary[], details: readonly TurnDetail[]): DataCoverage {
  const loadedTurnSummaries = uniqueSessionItems(session.id, turns).length
  const loadedTurnDetails = uniqueSessionItems(session.id, details).length
  return {
    expectedTurns: session.turnCount,
    loadedTurnSummaries,
    loadedTurnDetails,
    summariesComplete: loadedTurnSummaries >= session.turnCount,
    detailsComplete: loadedTurnDetails >= session.turnCount,
  }
}

function coverageMetric(
  value: number,
  loaded: number,
  expected: number,
  label: string,
  sources: AnalyticsMetricSource[],
  inspectedPaths: string[],
): AnalyticsMetric<number> {
  if (expected === 0) return available(0, sources, inspectedPaths)
  if (loaded === 0) {
    return unavailable({
      code: 'incomplete_coverage',
      message: `No Turn details are loaded for ${label}.`,
      availableSamples: 0,
      totalSamples: expected,
    }, inspectedPaths, sources)
  }
  if (loaded < expected) {
    return partial(value, {
      code: 'incomplete_coverage',
      message: `${label} covers ${loaded} of ${expected} Session Turns.`,
      availableSamples: loaded,
      totalSamples: expected,
    }, sources, inspectedPaths)
  }
  return available(value, sources, inspectedPaths)
}

function sessionDuration(
  turns: readonly TurnSummary[],
  expected: number,
): AnalyticsMetric<number> {
  const metrics = turns.map(turnDuration)
  const withDuration = metrics.filter((metric) => metric.value !== null)
  const inspectedPaths = turns.map((turn) => `turns.${turn.id}.durationMs`)
  const sources = withDuration.flatMap((metric) => metric.sources)
  if (expected === 0) return available(0, [], inspectedPaths)
  if (withDuration.length === 0) {
    return unavailable({
      code: turns.length === 0 ? 'incomplete_coverage' : 'not_persisted',
      message: turns.length === 0
        ? 'No Turn summaries are loaded for Session duration.'
        : 'No loaded Turn has a persisted total duration.',
      availableSamples: 0,
      totalSamples: expected,
    }, inspectedPaths, sources)
  }
  const value = withDuration.reduce((sum, metric) => sum + (metric.value ?? 0), 0)
  if (turns.length < expected || withDuration.length < turns.length) {
    return partial(value, {
      code: turns.length < expected ? 'incomplete_coverage' : 'partial_samples',
      message: `Session duration includes ${withDuration.length} persisted Turn durations out of ${expected}.`,
      availableSamples: withDuration.length,
      totalSamples: expected,
    }, sources, inspectedPaths)
  }
  return available(value, sources, inspectedPaths)
}

function tokenAnalytics(session: SessionSummary, turns: readonly TurnSummary[], dataCoverage: DataCoverage) {
  const persistedTotals = available(
    tokenCounts(session.inputTokens, session.outputTokens),
    [
      source('session.inputTokens'),
      source('session.outputTokens'),
    ],
    ['session.inputTokens', 'session.outputTokens'],
  )

  let cumulativeInputTokens = 0
  let cumulativeOutputTokens = 0
  const points: TokenTrendPoint[] = [...turns]
    .sort((left, right) => left.sessionOrdinal - right.sessionOrdinal || left.id.localeCompare(right.id))
    .map((turn) => {
      cumulativeInputTokens += turn.inputTokens
      cumulativeOutputTokens += turn.outputTokens
      return {
        turnId: turn.id,
        ordinal: turn.sessionOrdinal,
        createdAt: turn.createdAt,
        model: turn.model,
        ...tokenCounts(turn.inputTokens, turn.outputTokens),
        cumulativeInputTokens,
        cumulativeOutputTokens,
        cumulativeTotalTokens: cumulativeInputTokens + cumulativeOutputTokens,
      }
    })
  const loadedTotals = tokenCounts(cumulativeInputTokens, cumulativeOutputTokens)
  const turnSources = turns.flatMap((turn) => [
    source(`turns.${turn.id}.inputTokens`, { turnId: turn.id }),
    source(`turns.${turn.id}.outputTokens`, { turnId: turn.id }),
  ])
  const inspectedPaths = turns.flatMap((turn) => [
    `turns.${turn.id}.inputTokens`,
    `turns.${turn.id}.outputTokens`,
  ])

  let loadedTurnTotals: AnalyticsMetric<TokenCounts>
  let trend: AnalyticsMetric<TokenTrendPoint[]>
  if (dataCoverage.expectedTurns === 0) {
    loadedTurnTotals = available(loadedTotals, turnSources, inspectedPaths)
    trend = unavailable({ code: 'no_samples', message: 'This Session has no Turn token samples.' }, inspectedPaths)
  } else if (turns.length === 0) {
    const reason: AnalyticsReason = {
      code: 'incomplete_coverage',
      message: 'No Turn summaries are loaded for token analysis.',
      availableSamples: 0,
      totalSamples: dataCoverage.expectedTurns,
    }
    loadedTurnTotals = unavailable(reason, inspectedPaths)
    trend = unavailable(reason, inspectedPaths)
  } else if (!dataCoverage.summariesComplete) {
    const reason: AnalyticsReason = {
      code: 'incomplete_coverage',
      message: `Token analysis covers ${turns.length} of ${dataCoverage.expectedTurns} Session Turns.`,
      availableSamples: turns.length,
      totalSamples: dataCoverage.expectedTurns,
    }
    loadedTurnTotals = partial(loadedTotals, reason, turnSources, inspectedPaths)
    trend = partial(points, reason, turnSources, inspectedPaths)
  } else {
    loadedTurnTotals = available(loadedTotals, turnSources, inspectedPaths)
    trend = available(points, turnSources, inspectedPaths)
  }
  return { persistedTotals, loadedTurnTotals, trend }
}

export function analyzeSession(
  session: SessionSummary,
  turnSummaries: readonly TurnSummary[],
  turnDetails: readonly TurnDetail[] = [],
): SessionAnalytics {
  const turns = uniqueSessionItems(session.id, turnSummaries)
  const details = uniqueSessionItems(session.id, turnDetails)
  const dataCoverage = coverage(session, turns, details)
  const analyzedTurns = details.map(analyzeTurn).sort((left, right) => left.ordinal - right.ordinal)
  const detailSources = analyzedTurns.map((turn) => ({
    kind: 'derived' as const,
    path: `turnDetails.${turn.turnId}`,
    turnId: turn.turnId,
  }))
  const detailPaths = analyzedTurns.map((turn) => `turnDetails.${turn.turnId}`)
  const rounds = analyzedTurns.reduce((sum, turn) => sum + turn.totalRounds, 0)
  const requestedToolCalls = analyzedTurns.reduce((sum, turn) => sum + turn.requestedToolCalls, 0)
  const executedToolCalls = analyzedTurns.reduce((sum, turn) => sum + turn.executedToolCalls, 0)
  const failedToolCalls = analyzedTurns.reduce((sum, turn) => sum + turn.failedToolCalls, 0)

  return {
    sessionId: session.id,
    coverage: dataCoverage,
    tokens: tokenAnalytics(session, turns, dataCoverage),
    totals: {
      turns: session.turnCount,
      rounds: coverageMetric(rounds, details.length, session.turnCount, 'total rounds', detailSources, detailPaths),
      requestedToolCalls: coverageMetric(
        requestedToolCalls,
        details.length,
        session.turnCount,
        'requested tool calls',
        detailSources,
        detailPaths,
      ),
      executedToolCalls: coverageMetric(
        executedToolCalls,
        details.length,
        session.turnCount,
        'executed tool calls',
        detailSources,
        detailPaths,
      ),
      failedToolCalls: coverageMetric(
        failedToolCalls,
        details.length,
        session.turnCount,
        'failed tool calls',
        detailSources,
        detailPaths,
      ),
      durationMs: sessionDuration(turns, session.turnCount),
    },
    providerUsage: aggregateProviderUsage(analyzedTurns.map((turn) => turn.providerUsage)),
    analyzedTurns,
  }
}

export function buildAnalyticsPanel(
  session: SessionSummary,
  turnSummaries: readonly TurnSummary[],
  turnDetails: readonly TurnDetail[] = [],
  selectedTurnId: string | null = null,
): AnalyticsPanelModel {
  const sessionAnalytics = analyzeSession(session, turnSummaries, turnDetails)
  const selectedTurn = selectedTurnId === null
    ? null
    : sessionAnalytics.analyzedTurns.find((turn) => turn.turnId === selectedTurnId) ?? null
  return { session: sessionAnalytics, selectedTurn }
}
