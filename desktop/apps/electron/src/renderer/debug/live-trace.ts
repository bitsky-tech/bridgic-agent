import type { AgentEvent, ThinkPosition } from '@shared/types'
import type { TraceRound, TraceToolCall } from './types'

export type LivePhase = 'running' | 'waiting' | 'complete' | 'error' | 'stopped'
export interface LiveRound {
  record: TraceRound
  modelComplete: boolean
  phase: LivePhase
}
export interface LiveTurn {
  messageId: string
  sessionId: string
  userMessageId?: string
  turnId?: string
  rounds: LiveRound[]
  position: Pick<ThinkPosition, 'mode' | 'stage'> | null
  ended: boolean
}

/** A saved snapshot may lag behind a resumed response, including its tool results. */
export function savedRoundsCoverLive(saved: TraceRound[], live: LiveTurn): boolean {
  if (saved.length < live.rounds.length) return false
  // A projection captured after reload may cover only the resumed suffix, so
  // its local ordinals are not durable round identities.
  const covers = (field: 'body' | 'thinking') => {
    const content = live.rounds.map(round => round.record[field] ?? '').join('').trim()
    return !content || saved.map(round => round[field] ?? '').join('').includes(content)
  }
  const calls = saved.flatMap(round => round.calls)
  // Post-processing can change a saved outcome after the live tool_result event.
  // Result presence, rather than equal status, determines whether it is covered.
  return covers('body') && covers('thinking') && live.rounds.every(({ record }) => record.calls.every(call =>
    calls.some(candidate => candidate.sourceCallId === call.sourceCallId && candidate.name === call.name
      && (!call.hasResult || candidate.hasResult))))
}

export function beginLiveTurn(sessionId: string, messageId: string, userMessageId?: string, previous?: LiveTurn, saved: TraceRound[] = [], turnId?: string): LiveTurn {
  const useSaved = saved.length > 0 && (!previous || savedRoundsCoverLive(saved, previous))
  const turn: LiveTurn = {
    sessionId, messageId, userMessageId: previous?.userMessageId ?? userMessageId,
    turnId: turnId ?? previous?.turnId, position: null, ended: false,
    rounds: useSaved ? saved.map(record => ({ record, modelComplete: true, phase: 'complete' })) : previous?.rounds ?? [],
  }
  if (!turn.rounds.length) turn.rounds = [newRound(turn)]
  return turn
}

function newRound(turn: LiveTurn): LiveRound {
  const ordinal = (turn.rounds.at(-1)?.record.ordinal ?? 0) + 1
  const id = `live:${turn.messageId}:round:${ordinal}`
  return { modelComplete: false, phase: 'running', record: {
    id, ordinal, sessionId: turn.sessionId, turnId: turn.turnId ?? `live:${turn.messageId}`, turnOrdinal: 0,
    sourceRoundId: null, mode: turn.position?.mode ?? null,
    stage: turn.position?.stage ?? (turn.position?.mode === 'normal' ? 'main' : null),
    body: '', thinking: '', model: null, modelSource: null, status: 'unknown',
    durationMs: null, modelDurationMs: null, actDurationMs: null, calls: [], recordedRequest: {}, raw: undefined,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null, cachedInputTokens: null, cacheCreationInputTokens: null },
    usageSources: { inputTokens: [], outputTokens: [], totalTokens: [], cachedInputTokens: [], cacheCreationInputTokens: [] },
    usageIssues: { inputTokens: 'missing', outputTokens: 'missing', totalTokens: 'missing', cachedInputTokens: 'missing', cacheCreationInputTokens: 'missing' },
  } }
}

/** These are event projections, never substitutes for persisted OTA records. */
export function updateLiveTurn(turn: LiveTurn, event: AgentEvent): LiveTurn {
  if (turn.ended) return turn
  if (event.type === 'stage') {
    const position = { mode: event.position.mode, stage: event.position.stage }
    const last = turn.rounds.at(-1)
    const next = { ...turn, position }
    if (!last) return { ...next, rounds: [newRound(next)] }
    if (!last.modelComplete && !last.record.body && !last.record.thinking && !last.record.calls.length) {
      return { ...next, rounds: [...turn.rounds.slice(0, -1), { ...last, record: {
        ...last.record, mode: position.mode, stage: position.stage ?? (position.mode === 'normal' ? 'main' : null),
      } }] }
    }
    return next
  }
  const waiting = ['human_request', 'permission_request', 'build_confirm_request', 'task_confirm_request',
    'workflow_confirm_request', 'presentation_outline_confirm_request', 'presentation_template_selection_request'].includes(event.type)
  if (!waiting && !['text_delta', 'thinking_delta', 'context_usage', 'tool_call', 'tool_result', 'model_retry',
    'message_stop', 'error'].includes(event.type)) return turn
  if ((event.type === 'text_delta' || event.type === 'thinking_delta') && event.messageId !== turn.messageId) return turn
  if (event.type === 'tool_call' && event.messageId !== turn.messageId) return turn
  if (event.type === 'message_stop' && event.messageId !== turn.messageId) return turn

  let rounds = [...turn.rounds]
  const last = rounds.at(-1)
  // context_usage ends the model response, not the round's tool execution.
  // A subsequent response/usage starts another card; parallel tools stay together.
  const startsModel = (event.type === 'text_delta' && event.source !== 'final') || event.type === 'thinking_delta' || event.type === 'context_usage'
  if (!last || (startsModel && last.modelComplete)) {
    if (last) rounds[rounds.length - 1] = { ...last, phase: 'complete' }
    rounds.push(newRound({ ...turn, rounds }))
  }
  let index = rounds.length - 1
  if (event.type === 'tool_call' || event.type === 'tool_result') {
    const owner = rounds.findIndex(round => round.record.calls.some(call => call.sourceCallId === event.toolUseId))
    if (owner >= 0) index = owner
    else if (event.type === 'tool_result') return turn
  }
  const current = rounds[index]!
  let record = { ...current.record }
  let phase = current.phase
  let modelComplete = current.modelComplete
  let ended = false
  switch (event.type) {
    case 'text_delta': record.body = (record.body ?? '') + event.text; break
    case 'thinking_delta': record.thinking = (record.thinking ?? '') + event.text; break
    case 'context_usage': {
      modelComplete = true
      record.model = event.usage.modelId
      const reported = event.usage.source === 'provider'
      for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
        const value = event.usage[key]
        const issue = value == null ? 'missing' : null
        record = { ...record,
          usage: { ...record.usage, [key]: reported ? value : null },
          usageSources: { ...record.usageSources, [key]: [`context_usage.${key}`] },
          usageIssues: { ...record.usageIssues, [key]: reported ? issue : 'estimated' },
        }
      }
      break
    }
    case 'tool_call': {
      const existing = record.calls.find(call => call.sourceCallId === event.toolUseId)
      const call: TraceToolCall = {
        id: existing?.id ?? `${record.id}:tool:${event.toolUseId}`, roundId: record.id,
        turnId: record.turnId, turnOrdinal: record.turnOrdinal, ordinal: existing?.ordinal ?? record.calls.length + 1,
        sourceCallId: event.toolUseId, name: event.toolName, arguments: event.input,
        result: undefined, error: undefined, hasResult: false, pairing: 'missing', status: 'unknown',
        durationMs: null, rawCall: undefined, rawResult: undefined,
      }
      record.calls = existing ? record.calls.map(value => value === existing ? call : value) : [...record.calls, call]
      phase = 'running'
      break
    }
    case 'tool_result':
      record.calls = record.calls.map(call => call.sourceCallId !== event.toolUseId ? call : {
        ...call, result: event.output, error: event.isError ? event.output : undefined, hasResult: true,
        pairing: 'id', status: event.isError ? 'error' : 'success',
        durationMs: Number.isFinite(event.durationMs) && event.durationMs >= 0 ? event.durationMs : null,
      })
      break
    case 'model_retry':
      if (event.active) {
        const discard = (text: string | null | undefined, count: number) => {
          const points = Array.from(text ?? '')
          return points.slice(0, Math.max(0, points.length - count)).join('')
        }
        record.body = discard(record.body, event.discardTextChars)
        record.thinking = discard(record.thinking, event.discardReasoningChars)
      }
      break
    case 'message_stop':
      ended = true
      if (event.reason === 'cancelled') phase = 'stopped'
      else if (phase !== 'waiting') phase = 'complete'
      break
    case 'error': ended = true; phase = 'error'; break
  }
  if (waiting) phase = 'waiting'
  rounds[index] = { record, phase, modelComplete }
  return { ...turn, rounds, ended }
}
