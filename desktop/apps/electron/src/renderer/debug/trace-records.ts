import type { TraceRecords, TraceRound, TraceStatus, TraceToolCall, TraceTurnInput, TraceUsageField, TraceUsageIssue } from './types'

export type { TraceRecords, TraceRound, TraceStatus, TraceToolCall, TraceTurnInput } from './types'

type JsonObject = Record<string, unknown>

function object(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : undefined
}

/** Aliases are selected by presence so null/empty values never acquire another meaning. */
function field(raw: JsonObject | undefined, ...names: string[]): unknown {
  for (const name of names) if (raw && Object.hasOwn(raw, name)) return raw[name]
  return undefined
}

function text(value: unknown): string | null | undefined {
  return value === null || typeof value === 'string' ? value : undefined
}

function identity(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

function duration(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameValue(value, right[index]))
  }
  const a = object(left)
  const b = object(right)
  return !!a && !!b && Object.keys(a).length === Object.keys(b).length
    && Object.keys(a).every(key => Object.hasOwn(b, key) && sameValue(a[key], b[key]))
}

function thinking(raw: JsonObject | undefined): string | null | undefined {
  const content = text(field(raw, 'reasoning_content', 'reasoningContent'))
  if (typeof content === 'string') return content
  const blocks = field(raw, 'thinking_blocks', 'thinkingBlocks')
  if (Array.isArray(blocks)) {
    const exposed = blocks.flatMap(block => {
      const record = object(block)
      const value = record?.thinking
      return (record?.type === undefined || record.type === 'thinking') && typeof value === 'string' ? [value] : []
    })
    if (exposed.length) return exposed.join('')
  }
  return content
}

const usageContainers = ['usage', 'provider_usage', 'providerUsage', 'usage_metadata', 'usageMetadata']
const usageFields: Record<TraceUsageField, string[][]> = {
  inputTokens: [['prompt_tokens'], ['input_tokens'], ['prompt_token_count']],
  outputTokens: [['completion_tokens'], ['output_tokens'], ['candidates_token_count']],
  totalTokens: [['total_tokens'], ['total_token_count']],
  cachedInputTokens: [['prompt_tokens_details', 'cached_tokens'], ['input_tokens_details', 'cached_tokens'], ['cache_read_input_tokens'], ['cached_content_token_count']],
  cacheCreationInputTokens: [['cache_creation_input_tokens']],
}

function providerUsage(raw: JsonObject | undefined): Pick<TraceRound, 'usage' | 'usageSources' | 'usageIssues'> {
  const usage = {} as TraceRound['usage']
  const usageSources = {} as TraceRound['usageSources']
  const usageIssues = {} as TraceRound['usageIssues']
  for (const key of Object.keys(usageFields) as TraceUsageField[]) {
    const candidates: { value: number; path: string }[] = []
    let problem: TraceUsageIssue = 'missing'
    for (const name of usageContainers) {
      const container = object(raw?.[name])
      if (!container) continue
      for (const path of usageFields[key]) {
        let value: unknown = container
        for (const part of path) value = field(object(value), part)
        if (value === undefined) continue
        if (container.source === 'estimated') { problem = 'estimated'; continue }
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
          candidates.push({ value, path: `${name}.${path.join('.')}` })
        } else problem = 'invalid'
      }
    }
    const values = new Set(candidates.map(candidate => candidate.value))
    usage[key] = values.size === 1 ? candidates[0]!.value : null
    usageSources[key] = candidates.map(candidate => candidate.path)
    if (values.size > 1) usageIssues[key] = 'conflict'
    else if (candidates.length && problem === 'missing') usageIssues[key] = null
    else usageIssues[key] = problem
  }
  return { usage, usageSources, usageIssues }
}

function resultStatus(value: unknown): TraceStatus {
  const raw = object(value)
  if (!raw) return 'unknown'
  if (raw.success === false || (typeof raw.error === 'string' && raw.error.length > 0) || object(raw.error)) return 'error'
  return raw.success === true ? 'success' : 'unknown'
}

function pairCalls(calls: unknown[], results: unknown[]): Map<number, { index: number; by: 'id' | 'arguments' }> {
  const pairs = new Map<number, { index: number; by: 'id' | 'arguments' }>()
  const consumed = new Set<number>()
  const callId = (value: unknown) => identity(field(object(value), 'call_id', 'callId'))
  const resultId = (value: unknown) => identity(field(object(value), 'tool_id', 'toolId'))
  const callName = (value: unknown) => text(field(object(value), 'tool', 'name'))
  const resultName = (value: unknown) => text(field(object(value), 'tool_name', 'toolName'))
  const args = (value: unknown) => field(object(value), 'tool_arguments', 'toolArguments', 'arguments')
  calls.forEach((call, index) => {
    const id = callId(call)
    if (!id || calls.filter(candidate => callId(candidate) === id).length !== 1) return
    const candidates = results.flatMap((result, resultIndex) => resultId(result) === id ? [resultIndex] : [])
    const match = candidates[0]
    if (candidates.length !== 1 || match === undefined || !callName(call) || callName(call) !== resultName(results[match])) return
    pairs.set(index, { index: match, by: 'id' })
    consumed.add(match)
  })
  calls.forEach((call, index) => {
    if (pairs.has(index) || callId(call) || !callName(call) || args(call) === undefined) return
    const candidates = results.flatMap((result, resultIndex) => !consumed.has(resultIndex) && !resultId(result)
      && callName(call) === resultName(result) && sameValue(args(call), args(result)) ? [resultIndex] : [])
    const match = candidates[0]
    const equivalents = calls.filter((other, otherIndex) => !pairs.has(otherIndex) && !callId(other)
      && callName(call) === callName(other) && sameValue(args(call), args(other)))
    if (candidates.length !== 1 || match === undefined || equivalents.length !== 1) return
    pairs.set(index, { index: match, by: 'arguments' })
    consumed.add(match)
  })
  return pairs
}

/** Project recorded facts only; raw values remain available when their shape is unknown. */
export function buildTraceRecords(turns: readonly TraceTurnInput[]): TraceRecords {
  const records: TraceRecords = { rounds: [], calls: [], issues: [] }
  const ordered = [...turns].sort((a, b) => a.sessionOrdinal - b.sessionOrdinal || a.id.localeCompare(b.id))
  for (const turn of ordered) {
    const contextRecords = field(object(turn.otaContext), 'ota_record')
    const invalidDirectRecords = turn.otaRecords !== undefined && turn.otaRecords !== null && !Array.isArray(turn.otaRecords)
    if (invalidDirectRecords) records.issues.push({ turnId: turn.id, path: 'otaRecords', code: 'invalid_ota_records' })
    let source: unknown
    if (Array.isArray(turn.otaRecords)) source = turn.otaRecords
    else if (Array.isArray(contextRecords)) source = contextRecords
    else source = turn.otaRecords ?? contextRecords
    if (!Array.isArray(source)) {
      if (!invalidDirectRecords && source !== undefined && source !== null) records.issues.push({ turnId: turn.id, path: 'otaContext.ota_record', code: 'invalid_ota_records' })
      continue
    }
    source.forEach((value, index) => {
      const raw = object(value)
      const roundId = `${encodeURIComponent(turn.id)}:round:${index + 1}`
      const issue = (code: TraceRecords['issues'][number]['code'], path: string) => records.issues.push({ turnId: turn.id, roundId, code, path })
      if (!raw) issue('invalid_round', `otaRecords[${index}]`)
      const scope = object(raw?.think_scope)
      const think = object(field(raw, 'think_result', 'thinkResult'))
      const action = object(field(raw, 'action_result', 'actionResult'))
      const rawCalls = field(think, 'tool_calls', 'toolCalls')
      const rawResults = field(action, 'results')
      const invalidCalls = rawCalls !== undefined && !Array.isArray(rawCalls)
      const invalidResults = rawResults !== undefined && !Array.isArray(rawResults)
      if (invalidCalls) issue('invalid_tool_calls', 'think_result.tool_calls')
      if (invalidResults) issue('invalid_tool_results', 'action_result.results')
      const calls = Array.isArray(rawCalls) ? rawCalls : []
      const results = Array.isArray(rawResults) ? rawResults : []
      const pairs = pairCalls(calls, results)
      const consumed = new Set([...pairs.values()].map(pair => pair.index))
      const toolCalls: TraceToolCall[] = []
      const addCall = (callValue: unknown, resultValue: unknown, hasResult: boolean, pairing: TraceToolCall['pairing'], key: string) => {
        const call = object(callValue)
        const result = object(resultValue)
        toolCalls.push({
          id: `${roundId}:${key}`, roundId, turnId: turn.id, turnOrdinal: turn.sessionOrdinal, ordinal: toolCalls.length + 1,
          sourceCallId: identity(call ? field(call, 'call_id', 'callId') : field(result, 'tool_id', 'toolId')),
          name: text(call ? field(call, 'tool', 'name') : field(result, 'tool_name', 'toolName')) ?? null,
          arguments: field(call ?? result, 'tool_arguments', 'toolArguments', 'arguments'),
          result: field(result, 'tool_result', 'toolResult'), error: field(result, 'error'), hasResult, pairing,
          status: hasResult ? resultStatus(resultValue) : 'unknown', durationMs: duration(field(result, 'duration_ms', 'durationMs')),
          rawCall: callValue, rawResult: resultValue,
        })
      }
      calls.forEach((call, callIndex) => {
        const pair = pairs.get(callIndex)
        addCall(call, pair ? results[pair.index] : undefined, !!pair, pair?.by ?? 'missing', `call:${callIndex + 1}`)
      })
      results.forEach((result, resultIndex) => {
        if (!consumed.has(resultIndex)) addCall(undefined, result, true, 'unmatched', `result:${resultIndex + 1}`)
      })
      const recordedRequest: Record<string, unknown> = {}
      for (const key of ['request', 'llm_request', 'request_messages', 'prompt_messages', 'prompt', 'system_prompt', 'tool_definitions', 'model_options']) {
        if (raw && Object.hasOwn(raw, key)) recordedRequest[key] = raw[key]
      }
      const roundModel = text(field(raw, 'model', 'model_id'))
      const body = text(field(think, 'step_content', 'stepContent'))
      let status: TraceStatus = 'unknown'
      if (toolCalls.some(call => call.status === 'error')) status = 'error'
      else if (invalidCalls || invalidResults || toolCalls.some(call => call.status === 'unknown')) status = 'unknown'
      else if (toolCalls.length > 0 || (typeof body === 'string' && Array.isArray(rawCalls) && rawCalls.length === 0)) status = 'success'
      let modelSource: TraceRound['modelSource'] = null
      if (roundModel !== undefined) modelSource = 'round'
      else if (turn.model !== null) modelSource = 'turn'
      const round: TraceRound = {
        id: roundId, sourceRoundId: identity(field(raw, 'id')), turnId: turn.id, sessionId: turn.sessionId,
        turnOrdinal: turn.sessionOrdinal, ordinal: index + 1,
        mode: text(scope?.mode) ?? null, stage: text(scope && Object.hasOwn(scope, 'stage') ? scope.stage : raw?.build_stage) ?? null,
        body, thinking: thinking(raw), model: roundModel !== undefined ? roundModel : turn.model,
        modelSource,
        status, durationMs: duration(field(raw, 'round_duration_ms', 'roundDurationMs')),
        actDurationMs: duration(field(raw, 'act_duration_ms', 'actDurationMs')), ...providerUsage(raw),
        calls: toolCalls, recordedRequest, raw: value,
      }
      records.rounds.push(round)
      records.calls.push(...toolCalls)
    })
  }
  return records
}
