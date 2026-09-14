import { describe, expect, test } from 'bun:test'
import { buildTraceRecords, type TraceTurnInput } from './trace-records'

function turn(otaRecords: unknown, overrides: Partial<TraceTurnInput> = {}): TraceTurnInput {
  return { id: 'turn-1', sessionId: 'session-1', sessionOrdinal: 1, status: 'completed', model: 'stored-model', durationMs: 900,
    otaRecords, otaContext: null, ...overrides }
}

function call(id: string | null, args: unknown, tool = 'read_file') {
  return { call_id: id, tool, tool_arguments: args }
}

function result(id: string | null, args: unknown, output: unknown, tool = 'read_file') {
  return { tool_id: id, tool_name: tool, tool_arguments: args, tool_result: output, success: true, error: null }
}

function round(calls: unknown[], results: unknown[]) {
  return { think_result: { step_content: '', tool_calls: calls }, action_result: { results } }
}

describe('buildTraceRecords: persisted OTA data', () => {
  test('uses the actual think_scope and snake_case fields without normalizing away raw arguments', () => {
    const args = [{ name: 'path', value: '/tmp/report.txt' }]
    const stored = {
      think_scope: { mode: 'build', stage: 'implement' }, reasoning_content: 'Recorded reasoning',
      think_result: { step_content: 'Recorded response', tool_calls: [call('c1', args)] },
      action_result: { results: [result('c1', { path: '/tmp/report.txt' }, '')] }, act_duration_ms: 25,
    }
    const record = buildTraceRecords([turn([stored])]).rounds[0]!
    expect(record).toMatchObject({ mode: 'build', stage: 'implement', body: 'Recorded response', thinking: 'Recorded reasoning',
      status: 'success', actDurationMs: 25, durationMs: null, model: 'stored-model', modelSource: 'turn' })
    expect(record.calls[0]).toMatchObject({ arguments: args, result: '', hasResult: true, pairing: 'id', status: 'success', durationMs: null })
    expect(record.raw).toBe(stored)
    expect(record.calls[0]!.rawCall).toBe(stored.think_result.tool_calls[0])
    expect(record.calls[0]!.rawResult).toBe(stored.action_result.results[0])
  })

  test('matches reversed results by unique identity, never repeated tool name or position', () => {
    const records = buildTraceRecords([turn([round([call('a', { path: 'a' }), call('b', { path: 'b' })],
      [result('b', {}, 'B'), result('a', {}, 'A')])])])
    expect(records.calls.map(value => [value.sourceCallId, value.result, value.pairing])).toEqual([['a', 'A', 'id'], ['b', 'B', 'id']])
  })

  test('preserves duplicate call identities as unknown and does not consume an ambiguous result', () => {
    const records = buildTraceRecords([turn([round([call('dup', { a: 1 }), call('dup', { a: 2 })], [result('dup', {}, 'unassigned')])])])
    expect(records.calls.map(value => [value.pairing, value.status, value.hasResult])).toEqual([
      ['missing', 'unknown', false], ['missing', 'unknown', false], ['unmatched', 'success', true],
    ])
    expect(new Set(records.calls.map(value => value.id)).size).toBe(3)
    expect(records.rounds[0]!.status).toBe('unknown')
  })

  test('duplicate result IDs and conflicting tool names cannot establish a match', () => {
    const records = buildTraceRecords([turn([round([call('a', {})], [result('a', {}, 1), result('a', {}, 2)]),
      round([call('b', {})], [result('b', {}, 3, 'write_file')])])])
    expect(records.rounds.map(value => value.calls[0]!.hasResult)).toEqual([false, false])
    expect(records.calls.filter(value => value.pairing === 'unmatched')).toHaveLength(3)
  })

  test('legacy calls require unique, equal arguments on both unidentified sides', () => {
    const records = buildTraceRecords([turn([round([call(null, { nested: { a: 1, b: 2 } }), call(null, { path: 'two' })],
      [result(null, { path: 'two' }, 2), result(null, { nested: { b: 2, a: 1 } }, 1)])])])
    expect(records.calls.map(value => [value.result, value.pairing])).toEqual([[1, 'arguments'], [2, 'arguments']])
    const ambiguous = buildTraceRecords([turn([round([call(null, {}), call(null, {})], [result(null, {}, 1)])])])
    expect(ambiguous.calls.map(value => value.pairing)).toEqual(['missing', 'missing', 'unmatched'])
  })

  test('one-sided IDs and absent arguments never fall back to name-only pairing', () => {
    const records = buildTraceRecords([turn([round([call('a', {}), { tool: 'other' }],
      [result(null, {}, 1), { tool_name: 'other', success: true }])])])
    expect(records.calls.map(value => value.pairing)).toEqual(['missing', 'missing', 'unmatched', 'unmatched'])
  })

  test('keeps missing outcomes unknown regardless of turn status', () => {
    for (const status of ['completed', 'failed', 'awaiting_human', 'cancelled']) {
      const record = buildTraceRecords([turn([round([call('a', {})], [])], { status })]).calls[0]!
      expect(record.status).toBe('unknown')
      expect(record.hasResult).toBe(false)
      expect(record.result).toBeUndefined()
    }
  })

  test('explicit failures win over success, and a result without status is still unknown', () => {
    const records = buildTraceRecords([turn([round([], [
      { ...result('a', {}, null), success: false },
      { ...result('b', {}, null), error: 'Execution failed' },
      { tool_id: 'c', tool_name: 'read_file', tool_result: '' },
    ])])])
    expect(records.calls.map(value => value.status)).toEqual(['error', 'error', 'unknown'])
    expect(records.rounds[0]!.status).toBe('error')
  })

  test('preserves zero, empty strings, null, arrays and absent values independently', () => {
    const values: unknown[] = [0, '', null, [], false]
    const records = buildTraceRecords([turn([round(values.map((value, i) => call(String(i), value)),
      values.map((value, i) => ({ ...result(String(i), value, value), duration_ms: 0 })))])])
    expect(records.calls.map(value => value.arguments)).toEqual(values)
    expect(records.calls.map(value => value.result)).toEqual(values)
    expect(records.calls.every(value => value.durationMs === 0)).toBe(true)
    expect(records.calls.every(value => value.hasResult)).toBe(true)
    const bodies = buildTraceRecords([turn([{ think_result: { step_content: null } }, { think_result: { step_content: '' } }, {}])]).rounds
    expect(bodies.map(value => value.body)).toEqual([null, '', undefined])
  })

  test('only reads recorded thinking text and never exposes signatures or redacted blocks as thinking', () => {
    const rounds = buildTraceRecords([turn([
      { reasoning_content: '', thinking_blocks: [{ thinking: 'Do not replace the empty channel' }] },
      { thinking_blocks: [{ type: 'thinking', thinking: 'Part one. ', signature: 'SECRET' }, { thinking: 'Part two.' }, { type: 'redacted_thinking', thinking: 'HIDDEN', data: 'SEALED' }] },
      { reasoning_items: [{ encrypted_content: 'SEALED' }], reasoning_details: [{ signature: 'SECRET' }] },
      { reasoning_content: null },
    ])]).rounds
    expect(rounds.map(value => value.thinking)).toEqual(['', 'Part one. Part two.', undefined, null])
    expect(rounds[2]!.raw).toEqual({ reasoning_items: [{ encrypted_content: 'SEALED' }], reasoning_details: [{ signature: 'SECRET' }] })
  })

  test('never substitutes final answers, summaries or tool outputs for model body', () => {
    const records = buildTraceRecords([turn([{ summary: 'Not model text', observation_result: 'Not model text',
      action_result: { results: [result('a', {}, 'Tool result')] } }])])
    expect(records.rounds[0]!.body).toBeUndefined()
    expect(records.rounds[0]!.thinking).toBeUndefined()
  })

  test('reads only explicit round/tool durations without distributing Turn or action totals', () => {
    const records = buildTraceRecords([turn([
      { ...round([call('a', {})], [{ ...result('a', {}, ''), duration_ms: 0 }]), turn_duration_ms: 500, act_duration_ms: 25, round_duration_ms: 0 },
      { ...round([call('b', {})], [result('b', {}, '')]), turn_duration_ms: 900, act_duration_ms: 30 },
      { round_duration_ms: -1, act_duration_ms: Infinity },
    ], { durationMs: 900 })])
    expect(records.rounds.map(value => value.durationMs)).toEqual([0, null, null])
    expect(records.rounds.map(value => value.actDurationMs)).toEqual([25, 30, null])
    expect(records.calls.map(value => value.durationMs)).toEqual([0, null])
  })

  test('reads provider token fields with provenance, preserving reported zero and unreported cache', () => {
    const records = buildTraceRecords([turn([{ usage: { prompt_tokens: 0, completion_tokens: 4, total_tokens: 4, prompt_tokens_details: { cached_tokens: 0 } } }])])
    const record = records.rounds[0]!
    expect(record.usage).toEqual({ inputTokens: 0, outputTokens: 4, totalTokens: 4, cachedInputTokens: 0, cacheCreationInputTokens: null })
    expect(record.usageSources.inputTokens).toEqual(['usage.prompt_tokens'])
    expect(record.usageIssues.inputTokens).toBeNull()
    expect(record.usageIssues.cacheCreationInputTokens).toBe('missing')
  })

  test('reports conflicting or invalid usage and excludes estimated snapshots and tool payload telemetry', () => {
    const records = buildTraceRecords([turn([
      { usage: { input_tokens: 1, output_tokens: -1 }, provider_usage: { input_tokens: 2, total_tokens: '5' } },
      { usage: { input_tokens: 10, source: 'estimated' }, context_usage: { input_tokens: 100 }, action_result: { results: [result('a', {}, { usage: { input_tokens: 500 } })] } },
      { usage: { input_tokens: 3, output_tokens: 4 } },
    ], { otaContext: { context_usage: { input_tokens: 1000 } } })])
    expect(records.rounds[0]!.usage.inputTokens).toBeNull()
    expect(records.rounds[0]!.usageIssues).toMatchObject({ inputTokens: 'conflict', outputTokens: 'invalid', totalTokens: 'invalid' })
    expect(records.rounds[1]!.usage.inputTokens).toBeNull()
    expect(records.rounds[1]!.usageIssues.inputTokens).toBe('estimated')
    expect(records.rounds[2]!.usage.totalTokens).toBeNull()
  })

  test('round model metadata takes precedence and a Turn fallback is labeled as such', () => {
    const records = buildTraceRecords([turn([{ model_id: 'actual-model' }, { model: '' }, { model: null }, {}])])
    expect(records.rounds.map(value => [value.model, value.modelSource])).toEqual([
      ['actual-model', 'round'], ['', 'round'], [null, 'round'], ['stored-model', 'turn'],
    ])
  })

  test('uses legacy build_stage only when think_scope has no stage and preserves explicit empty stage', () => {
    const records = buildTraceRecords([turn([{ build_stage: 'legacy' }, { think_scope: { mode: 'main', stage: '' }, build_stage: 'ignored' },
      { cognitive_scope: { stage: 'wrong field' } }, { think_scope: { stage: null }, build_stage: 'ignored' }])])
    expect(records.rounds.map(value => value.stage)).toEqual(['legacy', '', null, null])
  })

  test('exposes only stored prompt/request fields with original values and no reconstructed snapshots', () => {
    const request = { messages: [{ role: 'system', content: 'Stored prompt' }], tools: [] }
    const records = buildTraceRecords([turn([{ llm_request: request, prompt_messages: null, system_prompt: '', model_options: { temperature: 0 }, tool_definitions: [] },
      { tool_catalog: ['not a request'], observation_result: { prompt: 'not the model request' } }])])
    expect(records.rounds[0]!.recordedRequest).toEqual({ llm_request: request, prompt_messages: null, system_prompt: '', model_options: { temperature: 0 }, tool_definitions: [] })
    expect(records.rounds[0]!.recordedRequest.llm_request).toBe(request)
    expect(records.rounds[1]!.recordedRequest).toEqual({})
  })

  test('sorts Turns without mutation, preserves OTA order, and scopes IDs to the Turn', () => {
    const turns = [turn([{}, {}], { id: 'later', sessionOrdinal: 3 }), turn([{}], { id: 'earlier', sessionOrdinal: 1 })]
    const before = JSON.stringify(turns)
    const records = buildTraceRecords(turns)
    expect(records.rounds.map(value => [value.turnId, value.ordinal])).toEqual([['earlier', 1], ['later', 1], ['later', 2]])
    expect(new Set(records.rounds.map(value => value.id)).size).toBe(3)
    expect(JSON.stringify(turns)).toBe(before)
  })

  test('uses stored ota_context fallback and preserves malformed records for raw inspection', () => {
    const fallback = buildTraceRecords([turn(null, { otaContext: { ota_record: [{ think_result: { step_content: 'Stored', tool_calls: [] } }] } })])
    expect(fallback.rounds[0]!.body).toBe('Stored')
    const malformed = buildTraceRecords([turn([null, 0, { think_result: { tool_calls: 'invalid' }, action_result: { results: false } }])])
    expect(malformed.rounds.map(value => value.raw)).toEqual([null, 0, { think_result: { tool_calls: 'invalid' }, action_result: { results: false } }])
    expect(malformed.issues.map(value => value.code)).toEqual(['invalid_round', 'invalid_round', 'invalid_tool_calls', 'invalid_tool_results'])
    expect(buildTraceRecords([turn('invalid')]).issues[0]!.code).toBe('invalid_ota_records')
  })

  test('can read a stored context despite malformed direct records while still reporting their corruption', () => {
    const records = buildTraceRecords([turn('invalid', { otaContext: { ota_record: [{ think_result: { step_content: '', tool_calls: [] } }] } })])
    expect(records.rounds[0]!.body).toBe('')
    expect(records.issues).toEqual([{ turnId: 'turn-1', path: 'otaRecords', code: 'invalid_ota_records' }])
  })

  test('malformed action results cannot turn a plain text response into confirmed success', () => {
    const records = buildTraceRecords([turn([{ think_result: { step_content: 'Recorded body', tool_calls: [] }, action_result: { results: 'invalid' } }])])
    expect(records.rounds[0]!.status).toBe('unknown')
    expect(records.issues[0]!.code).toBe('invalid_tool_results')
  })
})
