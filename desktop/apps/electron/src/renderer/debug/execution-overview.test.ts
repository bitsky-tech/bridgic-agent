import { describe, expect, test } from 'bun:test'
import type { DesktopDebugTurn } from '@shared/debug-types'
import { buildTraceRecords } from './trace-records'
import { buildExecutionOverview } from './execution-overview'

function turn(otaRecords: unknown, overrides: Partial<DesktopDebugTurn> = {}): DesktopDebugTurn {
  return { id: 'turn-1', sessionId: 'session-1', sessionOrdinal: 0, status: 'completed', createdAt: '', userInput: '',
    finalAnswer: null, error: null, executionMode: null, maxRounds: null, model: 'model', durationMs: null,
    otaRecords, otaContext: null, otaContextSource: 'unavailable', agentState: null, contextUsage: null, ...overrides }
}

function round(mode = 'normal', stage = 'main', usage: unknown = null) {
  return { think_scope: { mode, stage }, think_result: { step_content: '', tool_calls: [] }, usage }
}

function overview(turns: DesktopDebugTurn[]) {
  return buildExecutionOverview(turns, buildTraceRecords(turns))
}

describe('execution overview statistics', () => {
  test('sums provider input/output and computes a weighted cache rate without adding cache twice', () => {
    const result = overview([turn([
      round('normal', 'main', { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 80 } }),
      round('normal', 'main', { prompt_tokens: 300, completion_tokens: 10, total_tokens: 310, prompt_tokens_details: { cached_tokens: 60 } }),
    ])])
    expect(result.usage.inputTokens).toEqual({ value: 400, partial: false })
    expect(result.usage.outputTokens.value).toBe(30)
    expect(result.usage.totalTokens).toEqual({ value: 430, partial: false })
    expect(result.usage.cachedInputTokens.value).toBe(140)
    expect(result.cacheRate).toBe(.35)
    expect(result.usage.cacheCreationInputTokens.value).toBeNull()
  })

  test('normalizes native Anthropic reads/writes and normalized provider cache aliases', () => {
    const result = overview([turn([
      round('normal', 'main', { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 80, cache_creation_input_tokens: 10 }),
      round('normal', 'main', { input_tokens: 100, output_tokens: 5, cached_input_tokens: 50 }),
    ])])
    expect(result.usage.inputTokens.value).toBe(200)
    expect(result.usage.totalTokens.value).toBe(210)
    expect(result.usage.cachedInputTokens.value).toBe(130)
    expect(result.usage.cacheCreationInputTokens).toEqual({ value: 10, partial: true })
    expect(result.cacheRate).toBe(.65)
  })

  test('uses saved Turn totals including compaction once, never latest-call occupancy or cache', () => {
    const result = overview([turn([round(), round()], { contextUsage: {
      source: 'provider', input_tokens: 900, output_tokens: 100, occupied_input_tokens: 300, cached_input_tokens: 250,
    } })])
    expect(result.usage.totalTokens).toEqual({ value: 1000, partial: false })
    expect(result.usage.inputTokens.value).toBe(900)
    expect(result.usage.outputTokens.value).toBe(100)
    expect(result.usage.cachedInputTokens.value).toBeNull()
    expect(result.cacheRecordedRounds).toBe(0)
    expect(result.cacheRate).toBeNull()
  })

  test('keeps missing, partial, measured zero, and estimated usage distinct', () => {
    const result = overview([turn([
      round('normal', 'main', { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }),
      round(), round('normal', 'main', { source: 'estimated', input_tokens: 500, output_tokens: 100 }),
    ], { contextUsage: { source: 'estimated', input_tokens: 0, output_tokens: 0, occupied_input_tokens: 500 } })])
    expect(result.usage.totalTokens).toEqual({ value: 0, partial: true })
    expect(result.usage.cachedInputTokens).toEqual({ value: 0, partial: true })
    expect(result.cacheRecordedRounds).toBe(1)
    expect(result.cacheRate).toBeNull()
    expect(overview([turn([round()])]).usage.totalTokens.value).toBeNull()
    expect(overview([turn([])]).usage.totalTokens).toEqual({ value: 0, partial: false })
  })

  test('counts unique mode/stage combinations and contiguous entries separately across Turns', () => {
    const result = overview([
      turn([round(), round(), round('build', 'clarify'), round(), round('workflow', 'clarify')]),
      turn([round()], { id: 'turn-2', sessionOrdinal: 1 }),
    ])
    expect(result.rounds).toHaveLength(6)
    expect(result.stageCount).toBe(3)
    expect(result.modes).toBe(3)
    expect(result.stages.map(({ mode, stage, rounds, visits }) => ({ mode, stage, rounds, visits }))).toEqual([
      { mode: 'normal', stage: 'main', rounds: 4, visits: 3 },
      { mode: 'build', stage: 'clarify', rounds: 1, visits: 1 },
      { mode: 'workflow', stage: 'clarify', rounds: 1, visits: 1 },
    ])
  })

  test('marks saved totals as partial while a started round has not reported its usage', () => {
    const result = overview([turn([
      { ...round(), model_call_started: true },
    ], { contextUsage: { source: 'provider', input_tokens: 100, output_tokens: 10 } })])
    expect(result.usage.totalTokens).toEqual({ value: 110, partial: true })
  })

  test('does not count unstarted placeholders but includes a started model call without a response', () => {
    const result = overview([turn([{}, null, { think_scope: { mode: 'build', stage: 'plan' }, model_call_started: true }, round()])])
    expect(result.rounds).toHaveLength(2)
    expect(result.usage.totalTokens.value).toBeNull()
    expect(result.issues).toHaveLength(1)
    expect(overview([turn('malformed')]).usage.totalTokens.value).toBeNull()
  })

  test('counts outcomes without duplicating unpaired results or inventing success', () => {
    const tools = overview([turn([{
      ...round(), think_result: { tool_calls: ['a', 'b', 'c'].map(call_id => ({ call_id, tool: 'read_file', tool_arguments: {} })) },
      action_result: { results: [
        { tool_id: 'a', tool_name: 'read_file', success: true },
        { tool_id: 'b', tool_name: 'read_file', success: false },
        { tool_id: 'ambiguous', tool_name: 'read_file', success: true },
      ] },
    }])]).tools
    expect(tools).toEqual({ total: 3, success: 1, failed: 1, unknown: 1, unmatchedResults: 1 })
    expect(overview([turn([{ action_result: { results: [{ tool_id: 'a', tool_name: 'read_file', success: true }] } }])]).tools.success).toBe(1)
  })

  test('filters all metrics to the selected Turn even when other Turns are loaded', () => {
    const turns = [turn([round('normal', 'main', { input_tokens: 100, output_tokens: 1 })]),
      turn([round('build', 'plan', { input_tokens: 900, output_tokens: 9 })], { id: 'turn-2', sessionOrdinal: 1 })]
    const result = buildExecutionOverview([turns[0]!], buildTraceRecords(turns))
    expect(result.rounds).toHaveLength(1)
    expect(result.usage.totalTokens.value).toBe(101)
    expect(result.stages[0]!.mode).toBe('normal')
    expect(overview(turns).usage.totalTokens.value).toBe(1010)
  })

  test('excludes invalid and conflicting usage instead of claiming complete totals', () => {
    const result = overview([turn([
      { ...round('normal', 'main', { input_tokens: 10, output_tokens: -1 }), provider_usage: { input_tokens: 20 } },
      round('normal', 'main', { input_tokens: 30, output_tokens: 2 }),
    ])])
    expect(result.usage.inputTokens).toEqual({ value: 30, partial: true })
    expect(result.usage.totalTokens).toEqual({ value: 32, partial: true })
  })
})
