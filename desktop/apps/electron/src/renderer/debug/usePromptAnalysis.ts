import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAtomValue } from 'jotai'
import type { DesktopDebugPrompt } from '@shared/debug-prompt-types'
import { useDebugSession } from './DebugSessionProvider'
import { debugPromptClientAtom, fetchPromptAnalysis } from './prompt-analysis-client'

export interface PromptLoadState {
  loading: boolean
  error: string | null
  prompt: DesktopDebugPrompt | null
}

/** List existing rounds, then ask Cognitive to assemble only inspected requests. */
export function usePromptAnalysis(sessionId: string, active: boolean) {
  const client = useAtomValue(debugPromptClientAtom)
  const { records } = useDebugSession()
  const scope = useMemo(() => ({ sessionId, client, entries: new Map<string, PromptLoadState>(), pending: new Map<string, AbortController>() }), [sessionId, client])
  const [snapshot, setSnapshot] = useState({ scope, entries: new Map<string, PromptLoadState>() })
  const entries = snapshot.scope === scope ? snapshot.entries : new Map<string, PromptLoadState>()
  const prompts = records.rounds.map((round): DesktopDebugPrompt => ({
    turnId: round.turnId, turnOrdinal: round.turnOrdinal, roundIndex: round.ordinal - 1,
    stage: round.stage, mode: round.mode, availability: 'pending', request: null,
    ...entries.get(round.id)?.prompt,
    // Renderer identity is shared with the trace inspector, independently of API IDs.
    id: round.id,
  })).sort((a, b) => a.turnOrdinal - b.turnOrdinal || a.turnId.localeCompare(b.turnId) || a.roundIndex - b.roundIndex)

  const assemble = useCallback((id: string, retry = false) => {
    const round = records.rounds.find(item => item.id === id)
    if (!active || !round || scope.pending.has(id) || (!retry && scope.entries.has(id))) return
    const update = (entry: PromptLoadState) => {
      scope.entries.set(id, entry)
      setSnapshot({ scope, entries: new Map(scope.entries) })
    }
    if (!client || !round.stage || !round.mode) {
      update({ loading: false, prompt: null, error: !client ? 'Backend unavailable' : 'Round stage or mode is missing' })
      return
    }
    const controller = new AbortController()
    scope.pending.set(id, controller)
    update({ loading: true, prompt: null, error: null })
    void fetchPromptAnalysis(client, sessionId, {
      turnId: round.turnId, roundIndex: round.ordinal - 1, stage: round.stage, mode: round.mode,
    }, controller.signal).then(data => {
      if (!controller.signal.aborted) update({ loading: false, prompt: data.item, error: null })
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) update({ loading: false, prompt: null, error: error instanceof Error ? error.message : String(error) })
    }).finally(() => { if (scope.pending.get(id) === controller) scope.pending.delete(id) })
  }, [active, client, sessionId, records, scope])

  useEffect(() => () => {
    for (const [id, controller] of scope.pending) { controller.abort(); scope.entries.delete(id) }
    scope.pending.clear()
  }, [scope, active])
  return { prompts, entries, assemble }
}
