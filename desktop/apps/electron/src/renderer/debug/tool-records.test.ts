import { describe, expect, test } from 'bun:test'
import { AgentRole } from '@shared/types'
import type { DesktopDebugTurn } from '@shared/debug-types'
import { beginLiveTurn, updateLiveTurn } from './live-trace'
import { buildTraceRecords } from './trace-records'
import { mergeToolRecords, toolStatus } from './tool-records'

const stored = (id = 't'): DesktopDebugTurn => ({ id, sessionId: 's', sessionOrdinal: 0, status: 'completed',
  createdAt: '', userInput: { text: 'Read a file' }, finalAnswer: '', error: null, executionMode: null, maxRounds: null,
  model: null, durationMs: null, otaContext: null, otaContextSource: 'stored', agentState: null, contextUsage: null,
  otaRecords: [{ think_result: { tool_calls: [{ call_id: 'a', tool: 'read_file', tool_arguments: {} }] },
    action_result: { results: [{ tool_id: 'a', tool_name: 'read_file', tool_result: 'Done', success: true }] } }],
})
const user = { id: 'u', turnId: 't', role: AgentRole.User, text: 'Read a file', toolCalls: [], done: true, createdAt: 1 }
const live = () => updateLiveTurn(beginLiveTurn('s', 'm', 'u'), { type: 'tool_call', messageId: 'm', toolUseId: 'a', toolName: 'read_file', input: {} })

describe('live tool inspector records', () => {
  test('updates status and adopts saved records without changing the selected call identity', () => {
    let turn = live()
    const initial = mergeToolRecords(buildTraceRecords([]), [turn], [], [user], new Map())
    expect(initial.calls).toHaveLength(1)
    expect(toolStatus(initial.calls[0]!)).toBe('running')
    turn = updateLiveTurn(turn, { type: 'tool_result', toolUseId: 'a', output: 'Done', isError: false, durationMs: 12 })
    const finished = mergeToolRecords(buildTraceRecords([]), [turn], [], [user], initial.identities)
    expect(finished.calls[0]).toMatchObject({ id: initial.calls[0]!.id, result: 'Done', durationMs: 12 })
    expect(toolStatus(finished.calls[0]!)).toBe('success')
    const saved = buildTraceRecords([stored()])
    const adopted = mergeToolRecords(saved, [turn], [stored()], [user], finished.identities)
    expect(adopted.calls).toHaveLength(1)
    expect(adopted.calls[0]).toMatchObject({ id: initial.calls[0]!.id, isLive: false, roundId: saved.rounds[0]!.id })
    expect(adopted.calls[0]!.aliases).toContain(saved.calls[0]!.id)
    const withoutLive = mergeToolRecords(saved, [], [stored()], [user], adopted.identities)
    expect(withoutLive.calls[0]!.id).toBe(initial.calls[0]!.id)
  })

  test('does not merge a provider call id reused in a different Turn', () => {
    const projection = mergeToolRecords(buildTraceRecords([stored('other')]), [live()], [stored('other')], [user], new Map())
    expect(projection.calls).toHaveLength(2)
    expect(projection.calls.map(call => toolStatus(call))).toEqual(['success', 'running'])
  })

  test.each([false, true])('preserves the saved final failure over an earlier dispatch success (stream ended: %s)', ended => {
    let turn = updateLiveTurn(beginLiveTurn('s', 'm', 'u'), {
      type: 'tool_call', messageId: 'm', toolUseId: 'child', toolName: 'run_subagent', input: {},
    })
    turn = updateLiveTurn(turn, {
      type: 'tool_result', toolUseId: 'child', output: 'Child dispatch accepted', isError: false, durationMs: 2,
    })
    if (ended) turn = updateLiveTurn(turn, { type: 'message_stop', messageId: 'm' })
    const initial = mergeToolRecords(buildTraceRecords([]), [turn], [], [user], new Map())
    const saved = stored()
    saved.otaRecords = [{ think_result: { tool_calls: [{ call_id: 'child', tool: 'run_subagent', tool_arguments: {} }] },
      action_result: { results: [{ tool_id: 'child', tool_name: 'run_subagent', tool_result: 'Sub-agent ended with status failed',
        success: false, error: 'Child failed', duration_ms: 20 }] } }]
    const projection = mergeToolRecords(buildTraceRecords([saved]), [turn], [saved], [user], initial.identities)
    expect(projection.calls).toHaveLength(1)
    expect(projection.calls[0]).toMatchObject({
      id: initial.calls[0]!.id, result: 'Sub-agent ended with status failed', error: 'Child failed',
      status: 'error', durationMs: 20, isLive: false,
    })
    expect(toolStatus(projection.calls[0]!)).toBe('error')
  })

  test('does not replace a live result with an older pending record or invent success after cancellation', () => {
    let turn = live()
    turn = updateLiveTurn(turn, { type: 'message_stop', messageId: 'm', reason: 'cancelled' })
    expect(toolStatus(mergeToolRecords(buildTraceRecords([]), [turn], [], [user], new Map()).calls[0]!)).toBe('unknown')
    const stale = stored()
    stale.otaRecords = [{ think_result: { tool_calls: [{ call_id: 'a', tool: 'read_file', tool_arguments: {} }] } }]
    const complete = updateLiveTurn(live(), { type: 'tool_result', toolUseId: 'a', output: 'Failed', isError: true, durationMs: 3 })
    const projection = mergeToolRecords(buildTraceRecords([stale]), [complete], [stale], [user], new Map())
    expect(projection.calls).toHaveLength(1)
    expect(projection.calls[0]).toMatchObject({ result: 'Failed', status: 'error', isLive: true })
  })
})
