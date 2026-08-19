import type { PromptCacheInvocationPotential } from '../analytics/cache-potential'
import type { CanonicalPromptBlockKind } from '../prompt-view'
import type {
  PromptCacheComparisonIdentity,
  PromptCacheComparisonSection,
  PromptCacheComparisonViewModel,
  PromptCacheTurnOutputResolver,
  PromptComparison,
  PromptComparisonEndpoint,
  PromptSectionComparison,
} from './types'

function invocationFor(
  endpoint: PromptComparisonEndpoint,
  invocations: readonly PromptCacheInvocationPotential[],
): PromptCacheInvocationPotential | null {
  return invocations.find((candidate) => (
    candidate.turnId === endpoint.turnId && candidate.roundId === endpoint.roundId
  )) ?? null
}

function invocationCount(turnId: string, invocations: readonly PromptCacheInvocationPotential[]): number {
  return invocations.reduce((count, candidate) => count + Number(candidate.turnId === turnId), 0)
}

function identity(
  endpoint: PromptComparisonEndpoint,
  invocation: PromptCacheInvocationPotential | null,
  invocations: readonly PromptCacheInvocationPotential[],
  turnOrdinalById: ReadonlyMap<string, number>,
  resolveTurnOutput: PromptCacheTurnOutputResolver,
): PromptCacheComparisonIdentity {
  const zeroBasedTurnOrdinal = turnOrdinalById.get(endpoint.turnId)
  const turnOrdinal = zeroBasedTurnOrdinal === undefined ? null : zeroBasedTurnOrdinal + 1
  const roundOrdinal = endpoint.roundIndex + 1
  const count = invocationCount(endpoint.turnId, invocations)
  return {
    id: endpoint.roundId,
    label: `T${turnOrdinal ?? '?'} · R${roundOrdinal}`,
    turnOrdinal,
    roundOrdinal,
    model: endpoint.model,
    inputTokens: invocation?.estimatedRequestTokens ?? null,
    outputTokens: invocation ? resolveTurnOutput(endpoint.turnId, invocation, count) : null,
  }
}

function missTokensFor(
  kind: CanonicalPromptBlockKind,
  invocation: PromptCacheInvocationPotential,
): number {
  return invocation.nonReusableSections.reduce((total, section) => (
    section.section === kind ? total + section.estimatedTokens : total
  ), 0)
}

function cacheComparisonSection<Kind extends CanonicalPromptBlockKind>(
  section: PromptSectionComparison & { kind: Kind },
  invocation: PromptCacheInvocationPotential,
): PromptCacheComparisonSection<Kind> {
  const missTokens = missTokensFor(section.kind, invocation)
  return {
    id: section.kind,
    kind: section.kind,
    label: section.title,
    status: section.status === 'same' ? 'unchanged' : section.status,
    baselineText: section.baseline?.text ?? null,
    currentText: section.current?.text ?? null,
    hitTokens: null,
    missTokens: missTokens > 0 ? missTokens : null,
  }
}

/**
 * Join the structural Prompt diff with cache-prefix metrics for one invocation.
 * The adapter is deterministic and has no React or localization dependency.
 */
export function buildPromptCacheComparisonViewModel(
  comparison: PromptComparison,
  invocation: PromptCacheInvocationPotential,
  invocations: readonly PromptCacheInvocationPotential[],
  turnOrdinalById: ReadonlyMap<string, number>,
  resolveTurnOutput: PromptCacheTurnOutputResolver,
): PromptCacheComparisonViewModel {
  const baselineInvocation = invocationFor(comparison.baseline, invocations)
  const currentInvocation = invocationFor(comparison.current, invocations) ?? invocation
  const blocks = comparison.blocks.map((block) => cacheComparisonSection(block, invocation))
  const toolSurface = cacheComparisonSection(comparison.toolSurface, invocation)

  return {
    id: `${comparison.baseline.roundId}->${comparison.current.roundId}`,
    baseline: identity(
      comparison.baseline,
      baselineInvocation,
      invocations,
      turnOrdinalById,
      resolveTurnOutput,
    ),
    current: identity(
      comparison.current,
      currentInvocation,
      invocations,
      turnOrdinalById,
      resolveTurnOutput,
    ),
    hitTokens: invocation.estimatedReusableTokens,
    missTokens: invocation.estimatedNonReusableTokens,
    hitRate: invocation.potentialRatio,
    blocks,
    toolSurface,
    firstChangedBlockId: comparison.firstChangedBlock,
  }
}
