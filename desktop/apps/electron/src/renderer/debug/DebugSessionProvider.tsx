import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom, useStore } from 'jotai'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { currentMessagesAtom, currentStreamingAtom } from '@/atoms/agent'
import { localeAtom } from '@/atoms/locale'
import { requestSessionWorkbenchSurfaceOpenAtom } from '@/atoms/workbench'
import type { PipelineRevealRequest } from '@/components/amphi/Pipeline'
import type { DesktopDebugTurn } from '@shared/debug-types'
import { buildTraceRecords } from './trace-records'
import { fetchTracePage } from './trace-client'
import type { TraceRecords, TraceRound } from './types'

export type DebugPanelKind = 'tools' | 'rounds'
interface Selection { sessionId: string; kind: DebugPanelKind; id: string; nonce: number }
interface TraceState {
  sessionId: string | null
  turns: DesktopDebugTurn[]
  hasMore: boolean
  loading: boolean
  error: string | null
}
interface DebugContextValue extends TraceState {
  records: TraceRecords
  selection: Selection | null
  reveal: PipelineRevealRequest | null
  refresh: () => void
  loadMore: () => void
  inspect: (kind: DebugPanelKind, id: string) => void
  locate: (round: TraceRound) => void
  revealFailed: () => void
  notice: string | null
}
const Context = createContext<DebugContextValue | null>(null)
const EMPTY_TURNS: DesktopDebugTurn[] = []

export function useDebugText() {
  const locale = useAtomValue(localeAtom).resolved
  return useCallback((zh: string, en: string) => locale === 'zh' ? zh : en, [locale])
}

export const debugRoundElementId = (id: string) => `desktop-debug-round-${encodeURIComponent(id)}`

export function DebugSessionProvider({ children }: { children: ReactNode }) {
  const store = useStore()
  const sessionId = useAtomValue(activeSessionIdAtom)
  const messages = useAtomValue(currentMessagesAtom)
  const running = Boolean(useAtomValue(currentStreamingAtom))
  const open = useSetAtom(requestSessionWorkbenchSurfaceOpenAtom)
  const text = useDebugText()
  const [revision, setRevision] = useState(0)
  const [depth, setDepth] = useState({ sessionId, value: 1 })
  const pages = depth.sessionId === sessionId ? depth.value : 1
  const [state, setState] = useState<Omit<TraceState, 'loading'> & { requestKey: string }>({ sessionId: null, turns: [], hasMore: false, requestKey: '', error: null })
  const [selectionSession, setSelectionSession] = useState(sessionId)
  const [selection, setSelection] = useState<Selection | null>(null)
  const [reveal, setReveal] = useState<PipelineRevealRequest | null>(null)
  const [notice, setNotice] = useState<{ sessionId: string; text: string } | null>(null)
  const loadedBoundary = useRef<{ sessionId: string; ordinal: number; id: string } | null>(null)
  const interactionNonce = useRef(0)
  const durableTail = messages.filter((message) => message.turnId).map((message) => `${message.turnId}:${message.done}`).join('|')
  const refresh = useCallback(() => setRevision((value) => value + 1), [])
  const requestKey = JSON.stringify([sessionId, pages, durableTail, running, revision])
  const loading = Boolean(sessionId) && (state.sessionId !== sessionId || state.requestKey !== requestKey)

  // Reset local interaction state before the new Session's children commit.
  if (selectionSession !== sessionId) {
    setSelectionSession(sessionId)
    setDepth({ sessionId, value: 1 })
    setSelection(null)
    setReveal(null)
    setNotice(null)
  }
  useEffect(() => {
    loadedBoundary.current = null
  }, [sessionId])

  useEffect(() => {
    if (!running || loading) return
    const timer = window.setInterval(refresh, 4000)
    return () => window.clearInterval(timer)
  }, [running, loading, refresh])

  useEffect(() => {
    if (!sessionId) return
    const controller = new AbortController()
    const read = async () => {
      let cursor: string | null = null
      let hasMore = false
      const turns = new Map<string, DesktopDebugTurn>()
      const seen = new Set<string>()
      const boundary = loadedBoundary.current?.sessionId === sessionId ? loadedBoundary.current : null
      let reachedBoundary = boundary === null
      // New head Turns can move a previously loaded Turn onto another page.
      // Refresh through the old boundary so an inspected older record remains loaded.
      for (let pageIndex = 0; pageIndex < pages || !reachedBoundary; pageIndex += 1) {
        const page = await fetchTracePage(sessionId, cursor, controller.signal)
        for (const turn of page.turns) turns.set(turn.id, turn)
        if (boundary) reachedBoundary ||= page.turns.some((turn) => turn.sessionOrdinal < boundary.ordinal
          || (turn.sessionOrdinal === boundary.ordinal && turn.id <= boundary.id))
        hasMore = page.hasMore
        if (!hasMore) break
        cursor = page.nextCursor
        if (!cursor || seen.has(cursor)) throw new Error('Invalid pagination cursor')
        seen.add(cursor)
      }
      if (!controller.signal.aborted) {
        const loaded = [...turns.values()]
        const oldest = loaded.reduce<DesktopDebugTurn | undefined>((previous, turn) => !previous
          || turn.sessionOrdinal < previous.sessionOrdinal || (turn.sessionOrdinal === previous.sessionOrdinal && turn.id < previous.id) ? turn : previous, undefined)
        loadedBoundary.current = oldest ? { sessionId, ordinal: oldest.sessionOrdinal, id: oldest.id } : null
        setState({ sessionId, turns: loaded, hasMore, requestKey, error: null })
      }
    }
    void read().catch((error: unknown) => {
      if (!controller.signal.aborted) setState((current) => ({ sessionId, requestKey,
        turns: current.sessionId === sessionId ? current.turns : [], hasMore: current.sessionId === sessionId && current.hasMore,
        error: error instanceof Error ? error.message : String(error) }))
    })
    return () => controller.abort()
  }, [sessionId, pages, requestKey])

  const turns = state.sessionId === sessionId ? state.turns : EMPTY_TURNS
  const records = useMemo(() => buildTraceRecords(turns), [turns])
  if (state.sessionId === sessionId && !loading) {
    if (selection?.sessionId === sessionId && !(selection.kind === 'tools' ? records.calls : records.rounds).some((record) => record.id === selection.id)) setSelection(null)
    if (reveal?.sessionId === sessionId && !records.rounds.some((round) => round.turnId === reveal.turnId && debugRoundElementId(round.id) === reveal.targetId)) setReveal(null)
  }
  const inspect = useCallback((kind: DebugPanelKind, id: string) => {
    if (!sessionId || store.get(activeSessionIdAtom) !== sessionId
      || !(kind === 'tools' ? records.calls : records.rounds).some((record) => record.id === id)) return
    setSelection({ sessionId, kind, id, nonce: ++interactionNonce.current })
    open({ sessionId, surface: kind === 'tools' ? 'extension:debug-tools' : 'extension:debug-rounds' })
  }, [sessionId, open, records, store])
  const locate = useCallback((round: TraceRound) => {
    if (!sessionId || round.sessionId !== sessionId || store.get(activeSessionIdAtom) !== sessionId
      || !records.rounds.some((record) => record.id === round.id)) return
    setNotice(null)
    setReveal({ sessionId, turnId: round.turnId, targetId: debugRoundElementId(round.id), nonce: ++interactionNonce.current })
  }, [sessionId, records, store])
  const revealFailed = useCallback(() => {
    if (sessionId) setNotice({ sessionId, text: text('暂时无法定位到这条消息，请刷新后重试。', 'Unable to locate this message. Refresh and try again.') })
  }, [sessionId, text])

  return <Context.Provider value={{
    sessionId, turns, records,
    error: state.sessionId === sessionId && !loading ? state.error : null,
    loading,
    hasMore: state.sessionId === sessionId && state.hasMore,
    selection: selection?.sessionId === sessionId ? selection : null,
    reveal: reveal?.sessionId === sessionId ? reveal : null,
    notice: notice?.sessionId === sessionId ? notice.text : null,
    refresh, inspect, locate, revealFailed,
    loadMore: () => {
      if (sessionId && store.get(activeSessionIdAtom) === sessionId && !loading && state.hasMore) setDepth({ sessionId, value: pages + 1 })
    },
  }}>{children}</Context.Provider>
}

export function useDebugSession() {
  const value = useContext(Context)
  if (!value) throw new Error('DebugSessionProvider is required')
  return value
}
