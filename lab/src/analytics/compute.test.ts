import { describe, expect, test } from 'bun:test'
import type {
  JsonObject,
  OtaRound,
  SessionSummary,
  TurnDetail,
  TurnSummary,
} from '../api/types'
import {
  analyzeProviderUsage,
  analyzeSession,
  analyzeTurn,
  buildAnalyticsPanel,
} from './compute'

const session: SessionSummary = {
  id: 'session_1',
  title: 'Analytics fixture',
  status: 'completed',
  kind: 'user',
  parentSessionId: null,
  parentCallId: null,
  subagentMode: null,
  workspaceRoot: '/tmp/work',
  scheduleId: null,
  lastUsedModel: 'gpt-5',
  lastAnswer: 'Done',
  createdAt: '2026-08-18T00:00:00Z',
  updatedAt: '2026-08-18T00:01:00Z',
  turnCount: 2,
  inputTokens: 140,
  outputTokens: 35,
}

function round(ordinal: number, raw: JsonObject = {}): OtaRound {
  return {
    id: `turn_${ordinal}:round:${ordinal}`,
    ordinal,
    observationResult: null,
    thinkResult: null,
    permission: null,
    actionResult: null,
    durationMs: null,
    raw,
  }
}

function turnSummary(id: string, ordinal: number, inputTokens: number, outputTokens: number): TurnSummary {
  return {
    id,
    sessionId: session.id,
    sessionOrdinal: ordinal,
    userInput: { text: `Turn ${ordinal}`, blocks: [] },
    status: 'completed',
    finalAnswer: 'Done',
    error: null,
    executionMode: 'auto',
    maxRounds: 8,
    model: 'gpt-5',
    inputTokens,
    outputTokens,
    createdAt: `2026-08-18T00:0${ordinal}:00Z`,
    completedAt: `2026-08-18T00:0${ordinal}:30Z`,
    durationMs: ordinal * 1000,
  }
}

function turnDetail(summary: TurnSummary, otaRecords: OtaRound[]): TurnDetail {
  return {
    ...summary,
    otaRecords,
    agentState: { mode: 'normal' },
    browserToolLoaded: false,
    workspaceToolsLoaded: false,
    skillsToolLoaded: false,
    mounts: [],
    session,
    workspace: { root: session.workspaceRoot, mounts: [] },
  }
}

describe('token and Session analytics', () => {
  test('sorts the token trend and calculates exact cumulative values', () => {
    const second = turnSummary('turn_2', 2, 90, 20)
    const first = turnSummary('turn_1', 1, 50, 15)
    const result = analyzeSession(session, [second, first])

    expect(result.tokens.trend.availability).toBe('available')
    expect(result.tokens.trend.value?.map((point) => point.turnId)).toEqual(['turn_1', 'turn_2'])
    expect(result.tokens.trend.value?.[1]).toMatchObject({
      inputTokens: 90,
      outputTokens: 20,
      totalTokens: 110,
      cumulativeInputTokens: 140,
      cumulativeOutputTokens: 35,
      cumulativeTotalTokens: 175,
    })
    expect(result.tokens.persistedTotals.value).toEqual({
      inputTokens: 140,
      outputTokens: 35,
      totalTokens: 175,
    })
  })

  test('marks paginated token data and detail totals as partial instead of pretending they are complete', () => {
    const first = turnSummary('turn_1', 1, 50, 15)
    const detail = turnDetail(first, [round(1), round(2)])
    const result = analyzeSession(session, [first], [detail])

    expect(result.coverage).toMatchObject({
      expectedTurns: 2,
      loadedTurnSummaries: 1,
      loadedTurnDetails: 1,
      summariesComplete: false,
      detailsComplete: false,
    })
    expect(result.tokens.trend.availability).toBe('partial')
    expect(result.tokens.loadedTurnTotals.value?.totalTokens).toBe(65)
    expect(result.totals.rounds).toMatchObject({ availability: 'partial', value: 2 })
    expect(result.totals.rounds.reason?.code).toBe('incomplete_coverage')
  })

  test('sums persisted Turn durations but reports missing samples', () => {
    const first = turnSummary('turn_1', 1, 50, 15)
    const second = { ...turnSummary('turn_2', 2, 90, 20), durationMs: null }
    const result = analyzeSession(session, [first, second])

    expect(result.totals.durationMs).toMatchObject({ availability: 'partial', value: 1000 })
    expect(result.totals.durationMs.reason?.code).toBe('partial_samples')
  })
})

describe('round and tool analytics', () => {
  test('counts requested, executed, and failed tools and reads only act_duration_ms as action time', () => {
    const summary = turnSummary('turn_1', 1, 50, 15)
    const ota = round(1, { act_duration_ms: 321, turn_duration_ms: 9000 })
    ota.id = 'turn_1:round:1'
    ota.thinkResult = {
      stepContent: 'Run two tools',
      toolCalls: [
        { callId: 'call_1', tool: 'read_file', arguments: {}, raw: {} },
        { callId: 'call_2', tool: 'write_file', arguments: {}, raw: {} },
      ],
      raw: {},
    }
    ota.actionResult = {
      results: [
        {
          toolId: 'call_1',
          toolName: 'read_file',
          toolArguments: {},
          toolResult: 'ok',
          success: true,
          error: null,
          raw: {},
        },
        {
          toolId: 'call_2',
          toolName: 'write_file',
          toolArguments: {},
          toolResult: null,
          success: true,
          error: 'permission denied',
          raw: {},
        },
      ],
      raw: {},
    }
    const result = analyzeTurn(turnDetail(summary, [ota]))

    expect(result).toMatchObject({
      totalRounds: 1,
      requestedToolCalls: 2,
      executedToolCalls: 2,
      succeededToolCalls: 1,
      failedToolCalls: 1,
    })
    expect(result.rounds[0]?.actionDurationMs).toMatchObject({ availability: 'available', value: 321 })
    expect(result.rounds[0]?.actionDurationMs.sources[0]?.path).toBe('raw.act_duration_ms')
  })

  test('does not treat turn_duration_ms as a per-round or action duration', () => {
    const summary = turnSummary('turn_1', 1, 50, 15)
    const ota = round(1, { turn_duration_ms: 9000 })
    ota.actionResult = { results: [], raw: {} }
    const result = analyzeTurn(turnDetail(summary, [ota]))

    expect(result.durationMs.value).toBe(1000)
    expect(result.rounds[0]?.actionDurationMs).toMatchObject({
      availability: 'unavailable',
      value: null,
    })
  })

  test('does not count no-action rounds as missing action-duration samples', () => {
    const summary = turnSummary('turn_1', 1, 50, 15)
    const action = round(1, { act_duration_ms: 250 })
    action.actionResult = { results: [], raw: {} }
    const noAction = round(2)
    const result = analyzeTurn(turnDetail(summary, [action, noAction]))

    expect(result.actionDurationMs).toMatchObject({ availability: 'available', value: 250 })
    expect(result.rounds[1]?.actionDurationMs.reason?.code).toBe('not_applicable')
  })
})

describe('provider usage availability', () => {
  test('does not infer per-round provider or cached tokens from Turn totals', () => {
    const summary = turnSummary('turn_1', 1, 50, 15)
    const result = analyzeTurn(turnDetail(summary, [round(1)]))

    expect(result.tokens.totalTokens).toBe(65)
    expect(result.rounds[0]?.providerUsage.availability).toBe('unavailable')
    expect(result.rounds[0]?.providerUsage.inputTokens.reason?.code).toBe('not_persisted')
    expect(result.rounds[0]?.providerUsage.cachedInputTokens).toMatchObject({
      availability: 'unavailable',
      value: null,
    })
    expect(result.rounds[0]?.providerUsage.cachedInputTokens.reason?.message).toContain('zero is not assumed')
  })

  test('recognizes OpenAI-compatible token and cache-detail fields without deriving missing totals', () => {
    const usage = analyzeProviderUsage({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 25,
        prompt_tokens_details: { cached_tokens: 40 },
      },
    })

    expect(usage.availability).toBe('available')
    expect(usage.inputTokens).toMatchObject({ availability: 'available', value: 100 })
    expect(usage.outputTokens).toMatchObject({ availability: 'available', value: 25 })
    expect(usage.cachedInputTokens).toMatchObject({ availability: 'available', value: 40 })
    expect(usage.totalTokens).toMatchObject({ availability: 'unavailable', value: null })
    expect(usage.totalTokens.reason?.code).toBe('not_reported')
  })

  test('recognizes Anthropic cache fields and leaves unreported cache creation unavailable', () => {
    const usage = analyzeProviderUsage({
      provider_usage: {
        input_tokens: 80,
        output_tokens: 12,
        cache_read_input_tokens: 30,
      },
    })

    expect(usage.cachedInputTokens.value).toBe(30)
    expect(usage.cacheCreationInputTokens.reason?.code).toBe('not_reported')
    expect(usage.cacheCreationInputTokens.value).toBeNull()
  })

  test('refuses conflicting aliases and invalid numeric strings', () => {
    const conflict = analyzeProviderUsage({
      usage: { prompt_tokens: 100, input_tokens: 101, output_tokens: 5 },
    })
    const invalid = analyzeProviderUsage({
      usage_metadata: { prompt_token_count: '100', candidates_token_count: 5 },
    })

    expect(conflict.inputTokens).toMatchObject({ availability: 'unavailable', value: null })
    expect(conflict.inputTokens.reason?.code).toBe('conflicting_values')
    expect(invalid.inputTokens.reason?.code).toBe('invalid_value')
    expect(invalid.inputTokens.value).toBeNull()
  })

  test('aggregates only explicit samples and labels missing rounds as partial', () => {
    const summary = turnSummary('turn_1', 1, 50, 15)
    const first = round(1, {
      usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 4 } },
    })
    const second = round(2)
    const result = analyzeTurn(turnDetail(summary, [first, second]))

    expect(result.providerUsage.availability).toBe('partial')
    expect(result.providerUsage.inputTokens).toMatchObject({ availability: 'partial', value: 10 })
    expect(result.providerUsage.inputTokens.reason).toMatchObject({
      code: 'partial_samples',
      availableSamples: 1,
      totalSamples: 2,
    })
    expect(result.providerUsage.cachedInputTokens.value).toBe(4)
  })
})

describe('analysis panel model', () => {
  test('exposes the selected analyzed Turn without depending on React', () => {
    const first = turnSummary('turn_1', 1, 50, 15)
    const second = turnSummary('turn_2', 2, 90, 20)
    const firstDetail = turnDetail(first, [round(1)])
    const secondDetail = turnDetail(second, [round(1), round(2)])
    const panel = buildAnalyticsPanel(session, [first, second], [firstDetail, secondDetail], 'turn_2')

    expect(panel.session.totals.rounds).toMatchObject({ availability: 'available', value: 3 })
    expect(panel.selectedTurn).toMatchObject({ turnId: 'turn_2', totalRounds: 2 })
  })
})
