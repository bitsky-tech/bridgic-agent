import type { DesktopDebugTurn } from '@shared/debug-types'
import type { TraceRecords, TraceRound, TraceToolCall, TraceUsageField } from './types'

export interface UsageTotal {
  value: number | null
  partial: boolean
}

export interface ExecutionStage {
  key: string
  mode: string | null
  stage: string | null
  rounds: number
  visits: number
  firstRoundId: string
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

/** Aggregate measured facts without treating missing usage or outcomes as zero. */
export function buildExecutionOverview(turns: readonly DesktopDebugTurn[], records: TraceRecords) {
  const turnIds = new Set(turns.map(turn => turn.id))
  const rounds = records.rounds.filter(round => {
    if (!turnIds.has(round.turnId)) return false
    const raw = object(round.raw)
    return raw !== null && (raw.model_call_started === true || raw.think_result != null || raw.thinkResult != null
      || raw.action_result != null || raw.actionResult != null
      || Object.values(round.usage).some(value => value !== null))
  })
  const sum = (items: readonly UsageTotal[]): UsageTotal => {
    const known = items.filter(item => item.value !== null)
    return { value: known.length || !items.length ? known.reduce((total, item) => total + item.value!, 0) : null,
      partial: items.some(item => item.value === null || item.partial) }
  }
  const roundUsage = (round: TraceRound, field: TraceUsageField): number | null => {
    const value = round.usage[field]
    if (round.usageIssues[field] != null) return null
    return value
  }
  const roundTotal = (round: TraceRound): number | null => {
    const total = roundUsage(round, 'totalTokens')
    if (total !== null) return total
    const input = roundUsage(round, 'inputTokens')
    const output = roundUsage(round, 'outputTokens')
    return input !== null && output !== null ? input + output : null
  }
  const sumRounds = (items: readonly TraceRound[], read: (round: TraceRound) => number | null) =>
    sum(items.map(round => ({ value: read(round), partial: false })))
  const perTurn = turns.map(turn => {
    const own = rounds.filter(round => round.turnId === turn.id)
    const corrupt = records.issues.some(issue => issue.turnId === turn.id)
    const snapshot = object(turn.contextUsage)
    // These counters include auxiliary compaction calls. Occupancy and the
    // snapshot's cached_input_tokens describe only the latest call, not totals.
    const input = tokenCount(snapshot?.input_tokens)
    const output = tokenCount(snapshot?.output_tokens)
    const measured = snapshot?.source === 'provider' || (input ?? 0) > 0 || (output ?? 0) > 0
    const fromRounds = (read: (round: TraceRound) => number | null): UsageTotal => {
      const result = sumRounds(own, read)
      if (corrupt) return { value: own.length ? result.value : null, partial: true }
      return result
    }
    const incomplete = (field: TraceUsageField) => own.some(round => roundUsage(round, field) === null
      && (object(round.raw)?.model_call_started === true || snapshot?.source === 'estimated'))
    const inputTokens = measured && input !== null ? { value: input, partial: incomplete('inputTokens') } : fromRounds(round => roundUsage(round, 'inputTokens'))
    const outputTokens = measured && output !== null ? { value: output, partial: incomplete('outputTokens') } : fromRounds(round => roundUsage(round, 'outputTokens'))
    const totalTokens = measured && input !== null && output !== null
      ? { value: input + output, partial: inputTokens.partial || outputTokens.partial } : fromRounds(roundTotal)
    return { inputTokens, outputTokens, totalTokens }
  })
  const usage = {
    inputTokens: sum(perTurn.map(turn => turn.inputTokens)),
    outputTokens: sum(perTurn.map(turn => turn.outputTokens)),
    totalTokens: sum(perTurn.map(turn => turn.totalTokens)),
    cachedInputTokens: sumRounds(rounds, round => roundUsage(round, 'cachedInputTokens')),
    cacheCreationInputTokens: sumRounds(rounds, round => roundUsage(round, 'cacheCreationInputTokens')),
  }
  const cacheRounds = rounds.filter(round => roundUsage(round, 'cachedInputTokens') !== null)
  const cacheRateRounds = cacheRounds.filter(round => roundUsage(round, 'inputTokens') !== null
    && round.usage.cachedInputTokens! <= round.usage.inputTokens!)
  const cacheInput = cacheRateRounds.reduce((total, round) => total + round.usage.inputTokens!, 0)
  const cacheRead = cacheRateRounds.reduce((total, round) => total + round.usage.cachedInputTokens!, 0)
  const stages = new Map<string, ExecutionStage>()
  let previous: TraceRound | undefined
  for (const round of rounds) {
    const key = JSON.stringify([round.mode, round.stage])
    const entry = stages.get(key) ?? { key, mode: round.mode, stage: round.stage, rounds: 0, visits: 0, firstRoundId: round.id }
    entry.rounds += 1
    if (!previous || previous.turnId !== round.turnId || previous.mode !== round.mode || previous.stage !== round.stage) entry.visits += 1
    stages.set(key, entry)
    previous = round
  }
  const calls: TraceToolCall[] = []
  let unmatchedResults = 0
  for (const round of rounds) {
    // A result which could not be paired is evidence, not another invocation.
    // Keep it out of totals when that round already has declared calls.
    const declared = round.calls.filter(call => call.pairing !== 'unmatched')
    calls.push(...declared)
    const orphaned = round.calls.filter(call => call.pairing === 'unmatched')
    if (declared.length) unmatchedResults += orphaned.length
    else calls.push(...orphaned)
  }
  const tools = {
    total: calls.length,
    success: calls.filter(call => call.status === 'success').length,
    failed: calls.filter(call => call.status === 'error').length,
    unknown: calls.filter(call => call.status === 'unknown').length,
    unmatchedResults,
  }
  const issues = records.issues.filter(issue => turnIds.has(issue.turnId))
  return {
    rounds, usage, tools, stages: [...stages.values()],
    modes: new Set(rounds.flatMap(round => round.mode ? [round.mode] : [])).size,
    stageCount: [...stages.values()].filter(stage => stage.mode && stage.stage).length,
    cacheRecordedRounds: cacheRounds.length,
    cacheRate: cacheInput > 0 ? cacheRead / cacheInput : null,
    issues,
  }
}
