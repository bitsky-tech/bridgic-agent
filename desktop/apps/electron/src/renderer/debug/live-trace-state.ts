import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import { messageFamily, type AgentEventObservation } from '@/atoms/agent'
import { beginLiveTurn, updateLiveTurn, type LiveTurn } from './live-trace'
import type { TraceRound } from './types'

export const savedDebugRoundsFamily = atomFamily((_sessionId: string) => atom<TraceRound[]>([]))
export const liveDebugTurnsFamily = atomFamily((_sessionId: string) => atom<LiveTurn[]>([]))

/** Installed only by DebugSessionProvider. Keep event boundaries even in React batches. */
export const observeDebugEventAtom = atom(null, (get, set, { sessionId, event, continuation }: AgentEventObservation) => {
  const target = liveDebugTurnsFamily(sessionId)
  const turns = get(target)
  if (event.type === 'message_start') {
    const previous = continuation ? turns.find(turn => turn.messageId === continuation.messageId)
      ?? turns.findLast(turn => (continuation.turnId && turn.turnId === continuation.turnId)
        || (continuation.userMessageId && turn.userMessageId === continuation.userMessageId)) : undefined
    const saved = continuation?.turnId ? get(savedDebugRoundsFamily(sessionId)).filter(round => round.turnId === continuation.turnId) : []
    const user = get(messageFamily(sessionId)).findLast(message => message.role === 'user')
    const turn = beginLiveTurn(sessionId, event.messageId, user?.id, previous, saved, continuation?.turnId)
    // Bound transient retention; durable history supplies older cards.
    set(target, [...turns.filter(item => item !== previous && item.messageId !== event.messageId).slice(-19), turn])
    return
  }
  if (event.type === 'stream_discard') {
    set(target, turns.filter(turn => turn.ended))
    return
  }
  const active = turns.at(-1)
  if (!active || active.ended) return
  const next = updateLiveTurn(active, event)
  if (next !== active) set(target, [...turns.slice(0, -1), next])
})
