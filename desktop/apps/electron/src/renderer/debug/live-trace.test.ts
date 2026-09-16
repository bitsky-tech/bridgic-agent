import { describe, expect, test } from 'bun:test'
import type { AgentEvent } from '@shared/types'
import { beginLiveTurn, savedRoundsCoverLive, updateLiveTurn } from './live-trace'
import { buildTraceRecords } from './trace-records'

const usage: AgentEvent = { type: 'context_usage', usage: {
  modelId: 'test-model', inputTokens: 20, outputTokens: 5, cachedInputTokens: 0,
  usedTokens: 20, usableTokens: 100, percentage: 20, source: 'provider',
  breakdown: { systemPromptTokens: 0, dynamicContextTokens: 0, toolSchemaTokens: 0, sessionHistoryTokens: 0, currentInputTokens: 20 },
} }
const text = (value: string): AgentEvent => ({ type: 'text_delta', messageId: 'm', text: value })
const tool = (id: string): AgentEvent => ({ type: 'tool_call', messageId: 'm', toolUseId: id, toolName: 'read_file', input: { path: id } })
const result = (id: string, failed = false): AgentEvent => ({ type: 'tool_result', toolUseId: id, output: `Output ${id}`, isError: failed, durationMs: failed ? 42 : 0 })

describe('live round projection', () => {
  test('resumes with settled saved results even when an earlier live event reported success', () => {
    let turn = beginLiveTurn('s', 'm', 'u')
    for (const event of [text('First'), usage,
      { ...tool('child'), toolName: 'run_subagent' } as AgentEvent, result('child'),
      { type: 'message_stop', messageId: 'm' } as AgentEvent]) turn = updateLiveTurn(turn, event)
    const saved = buildTraceRecords([{ id: 't', sessionId: 's', sessionOrdinal: 0, status: 'completed',
      model: null, durationMs: null, otaContext: null, otaRecords: [{
        think_result: { step_content: 'First', tool_calls: [{ call_id: 'child', tool: 'run_subagent', tool_arguments: {} }] },
        action_result: { results: [{ tool_id: 'child', tool_name: 'run_subagent', tool_result: 'Child failed', error: 'Child failed', success: false }] },
      }],
    }]).rounds
    expect(savedRoundsCoverLive(saved, turn)).toBe(true)
    let resumed = beginLiveTurn('s', 'next', 'u', turn, saved, 't')
    resumed = updateLiveTurn(resumed, { type: 'text_delta', messageId: 'next', text: 'Continuing' })
    expect(resumed.rounds[0]!.record.calls[0]).toMatchObject({ status: 'error', result: 'Child failed', error: 'Child failed' })
    expect(resumed.rounds.map(round => round.record.body)).toEqual(['First', 'Continuing'])
    expect(turn.rounds[0]!.record.calls[0]!.status).toBe('success')
  })

  test('retains newer responses and tool results when resuming with an older saved snapshot', () => {
    let turn = beginLiveTurn('s', 'm', 'u')
    for (const event of [text('First'), usage, tool('a')]) turn = updateLiveTurn(turn, event)
    const saved = turn.rounds.map(round => round.record)
    turn = updateLiveTurn(turn, result('a'))
    expect(savedRoundsCoverLive(saved, turn)).toBe(false)
    expect(beginLiveTurn('s', 'next', 'u', turn, saved).rounds[0]!.record.calls[0]!.hasResult).toBe(true)
    for (const event of [text('Second'), usage]) turn = updateLiveTurn(turn, event)
    const resumed = beginLiveTurn('s', 'next', 'u', turn, saved)
    expect(resumed.rounds.map(round => round.record.body)).toEqual(['First', 'Second'])
    expect(updateLiveTurn(resumed, { type: 'text_delta', messageId: 'next', text: 'Third' }).rounds.at(-1)!.record.ordinal).toBe(3)
  })

  test('adopts complete saved history even when live capture started only after a reload', () => {
    let turn = beginLiveTurn('s', 'm', 'u')
    for (const event of [text('Resumed'), usage]) turn = updateLiveTurn(turn, event)
    const saved = buildTraceRecords([{ id: 't', sessionId: 's', sessionOrdinal: 0, status: 'completed',
      model: null, durationMs: null, otaContext: null, otaRecords: [
        { think_result: { step_content: 'Earlier', tool_calls: [] } },
        { think_result: { step_content: 'Resumed', tool_calls: [] }, round_duration_ms: 100 },
      ] }]).rounds
    expect(savedRoundsCoverLive(saved.slice(0, 1), turn)).toBe(false)
    expect(savedRoundsCoverLive(saved, turn)).toBe(true)
    expect(beginLiveTurn('s', 'next', 'u', turn, saved).rounds.map(round => round.record)).toEqual(saved)
  })

  test('uses model completion boundaries, retaining parallel tools and their individual outcomes', () => {
    let turn = beginLiveTurn('s', 'm')
    for (const event of [
      { type: 'stage', position: { mode: 'normal', stage: null } } as AgentEvent,
      text('First '), text('response'), usage, tool('a'), tool('b'), result('b', true), result('a'),
      { type: 'stage', position: { mode: 'run_workflow', stage: 'execute' } } as AgentEvent,
      text('Second response'), usage,
    ]) turn = updateLiveTurn(turn, event)
    expect(turn.rounds).toHaveLength(2)
    expect(turn.rounds[0]!.record).toMatchObject({ body: 'First response', stage: 'main', mode: 'normal' })
    expect(turn.rounds[0]!.record.calls.map(call => [call.sourceCallId, call.status, call.durationMs])).toEqual([
      ['a', 'success', 0], ['b', 'error', 42],
    ])
    expect(turn.rounds[1]!.record).toMatchObject({ body: 'Second response', stage: 'execute', ordinal: 2 })
    expect(turn.rounds[0]!.record.usage).toMatchObject({ inputTokens: 20, outputTokens: 5, cachedInputTokens: 0 })
    expect(turn.rounds[0]!.record.raw).toBeUndefined()
  })

  test('retains empty and tool-only model responses as separate cards', () => {
    let turn = beginLiveTurn('s', 'm')
    for (const event of [usage, tool('a'), result('a'), usage, usage, text('Final')]) turn = updateLiveTurn(turn, event)
    expect(turn.rounds).toHaveLength(4)
    expect(turn.rounds.map(round => round.record.body)).toEqual(['', '', '', 'Final'])
    expect(turn.rounds[0]!.record.calls).toHaveLength(1)
  })

  test('retries replace only the current attempt and count Unicode code points', () => {
    let turn = beginLiveTurn('s', 'm')
    for (const event of [text('Keep'), usage, text('Discard😀'),
      { type: 'thinking_delta', messageId: 'm', text: 'Thought😀' } as AgentEvent,
      { type: 'model_retry', active: true, attempt: 1, maxRetries: 3, delaySeconds: 1, discardTextChars: 8, discardReasoningChars: 8 } as AgentEvent,
      text('Replacement'), usage]) turn = updateLiveTurn(turn, event)
    expect(turn.rounds).toHaveLength(2)
    expect(turn.rounds.map(round => round.record.body)).toEqual(['Keep', 'Replacement'])
    expect(turn.rounds[1]!.record.thinking).toBe('')
  })

  test('does not invent provider metrics or completion results for interrupted tools', () => {
    let turn = beginLiveTurn('s', 'm')
    turn = updateLiveTurn(turn, { ...usage, usage: { ...usage.usage, source: 'estimated' } })
    turn = updateLiveTurn(turn, tool('a'))
    turn = updateLiveTurn(turn, { type: 'message_stop', messageId: 'm', reason: 'cancelled' })
    expect(turn.rounds[0]!.record.usage.inputTokens).toBeNull()
    expect(turn.rounds[0]!.record.usageIssues.inputTokens).toBe('estimated')
    expect(turn.rounds[0]!.record.calls[0]!.hasResult).toBe(false)
    expect(turn.rounds[0]!.phase).toBe('stopped')
    expect(updateLiveTurn(turn, result('a'))).toBe(turn)
  })

  test('resumes a parked tool in its saved round before creating the next response', () => {
    const saved = buildTraceRecords([{ id: 't', sessionId: 's', sessionOrdinal: 0, status: 'awaiting_permission',
      model: null, durationMs: null, otaContext: null, otaRecords: [
        { think_result: { step_content: 'Earlier', tool_calls: [] } },
        { think_result: { step_content: 'Need permission', tool_calls: [{ call_id: 'a', tool: 'read_file', tool_arguments: { path: 'a' } }] } },
      ] }]).rounds
    let turn = beginLiveTurn('s', 'm', 'u', undefined, saved, 't')
    for (const event of [tool('a'), result('a'), text('Resumed'), usage]) turn = updateLiveTurn(turn, event)
    expect(turn.rounds.map(round => round.record.ordinal)).toEqual([1, 2, 3])
    expect(turn.rounds[1]!.record.calls[0]).toMatchObject({ sourceCallId: 'a', result: 'Output a', status: 'success' })
    expect(saved[1]!.calls[0]!.hasResult).toBe(false)
  })

  test('parks interaction rounds and preserves their text across a live continuation', () => {
    let turn = beginLiveTurn('s', 'm', 'u')
    for (const event of [text('Choose'), usage,
      { type: 'human_request', prompt: 'Which?', questions: [] } as AgentEvent,
      { type: 'message_stop', messageId: 'm', finalAnswer: '' } as AgentEvent]) turn = updateLiveTurn(turn, event)
    expect(turn.rounds[0]!.phase).toBe('waiting')
    let resumed = beginLiveTurn('s', 'next', 'u2', turn)
    resumed = updateLiveTurn(resumed, { type: 'text_delta', messageId: 'next', text: 'Continuing' })
    expect(resumed.rounds.map(round => round.record.body)).toEqual(['Choose', 'Continuing'])
    expect(turn.rounds).toHaveLength(1)
    expect(resumed.userMessageId).toBe('u')
  })

  test('ignores foreign messages and unknown tool results', () => {
    const turn = beginLiveTurn('s', 'm')
    expect(updateLiveTurn(turn, { type: 'text_delta', messageId: 'other', text: 'Wrong message' })).toBe(turn)
    expect(updateLiveTurn(turn, result('unknown'))).toBe(turn)
  })

  test('attaches a final-only answer to its model response instead of opening a phantom round', () => {
    let turn = beginLiveTurn('s', 'm')
    turn = updateLiveTurn(turn, usage)
    turn = updateLiveTurn(turn, { type: 'text_delta', messageId: 'm', text: 'Final-only answer', source: 'final' })
    turn = updateLiveTurn(turn, { type: 'message_stop', messageId: 'm', finalAnswer: 'Final-only answer' })
    expect(turn.rounds).toHaveLength(1)
    expect(turn.rounds[0]!.record.body).toBe('Final-only answer')
    expect(turn.rounds[0]!.record.usage.inputTokens).toBe(20)
  })
})
