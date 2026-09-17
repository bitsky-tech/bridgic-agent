import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import type { AgentMessage } from '@shared/types'
import type { DesktopDebugTurn } from '@shared/debug-types'
import type { LivePhase, LiveTurn } from './live-trace'
import type { TraceRecords, TraceRound, TraceToolCall } from './types'

export interface ToolInspection extends TraceToolCall {
  round: TraceRound
  aliases: string[]
  livePhase?: LivePhase
  isLive: boolean
  userInput?: unknown
}
export function toolStatus(call: ToolInspection) {
  return !call.hasResult && call.isLive && (call.livePhase === 'running' || call.livePhase === 'waiting') ? call.livePhase : call.status
}
export const toolIdentitiesFamily = atomFamily((_sessionId: string) => atom(new Map<string, string>()))
export function toolIdentity(ids: Map<string, string>, id: string): string {
  const seen = new Set<string>()
  while (ids.has(id) && ids.get(id) !== id && !seen.has(id)) {
    seen.add(id)
    id = ids.get(id)!
  }
  return id
}

/** Match within a durable Turn; repeated provider call ids in other Turns are unrelated. */
export function mergeToolRecords(records: TraceRecords, live: LiveTurn[], turns: DesktopDebugTurn[], messages: AgentMessage[], identities: Map<string, string>) {
  let nextIds = identities
  const register = (alias: string, id: string) => {
    if (toolIdentity(nextIds, alias) === id && nextIds.has(alias)) return
    if (nextIds === identities) nextIds = new Map(identities)
    nextIds.set(alias, id)
  }
  const calls: ToolInspection[] = records.rounds.flatMap(round => round.calls.map(call => ({
    ...call, id: toolIdentity(identities, call.id), round, aliases: [call.id], isLive: false,
    userInput: turns.find(turn => turn.id === call.turnId)?.userInput,
  })))
  for (const turn of live) {
    const user = messages.find(message => message.id === turn.userMessageId)
    const turnId = turn.turnId ?? messages.find(message => message.id === turn.messageId)?.turnId ?? user?.turnId
    const storedTurn = turns.find(item => item.id === turnId)
    for (const round of turn.rounds) for (const call of round.record.calls) {
      const candidates = calls.filter(item => item.aliases.includes(call.id)
        || (turnId && item.turnId === turnId && call.sourceCallId && item.sourceCallId === call.sourceCallId && item.name === call.name))
      const stored = candidates.length === 1 ? candidates[0] : undefined
      const key = toolIdentity(nextIds, call.id)
      register(call.id, key)
      if (stored) {
        register(stored.id, key)
        for (const alias of stored.aliases) register(alias, key)
        // Saved results include post-processing and settled child outcomes. Live
        // events fill missing results, but must not overwrite an authoritative one.
        const needsLiveResult = call.hasResult && !stored.hasResult
        const isLive = needsLiveResult || (!stored.hasResult && !turn.ended)
        calls[calls.indexOf(stored)] = { ...stored, ...(needsLiveResult ? {
          result: call.result, error: call.error, hasResult: call.hasResult, status: call.status, durationMs: call.durationMs,
        } : {}), id: key, aliases: [...new Set([...stored.aliases, call.id])], isLive,
        livePhase: isLive ? round.phase : undefined }
      } else {
        calls.push({ ...call, id: key, turnId: turnId ?? call.turnId, turnOrdinal: storedTurn?.sessionOrdinal ?? -1,
          round: round.record, aliases: [call.id], isLive: true, livePhase: round.phase,
          userInput: storedTurn?.userInput ?? user?.text })
      }
    }
  }
  return { calls, identities: nextIds }
}
