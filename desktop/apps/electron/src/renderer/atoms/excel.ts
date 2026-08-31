import { atom } from 'jotai'
import type { ExcelHostSnapshot } from '@shared/types'
import { rightPanelCollapsedAtom, setRightPanelCollapsedAtom } from './layout'
import { viewedSessionIdAtom } from './navigation'
import { currentSessionFocusPaneAtom } from './session-focus-pane'
import { SessionWorkbenchSurface, sessionWorkbenchSurfaceAtom } from './workbench'

type ExcelStateUpdate<T> = T | ((current: T) => T)

export const excelHostSnapshotAtom = atom<ExcelHostSnapshot>({ sessions: [] })

/** Apply target inventory and retract a visible Excel surface when its final tab
 * closes and therefore disposes the Session target. Keep Excel selected so the
 * next manual click opens its launch surface, matching Browser semantics. */
export const setExcelHostSnapshotAtom = atom(null, (get, set, snapshot: ExcelHostSnapshot) => {
  const sessionId = get(viewedSessionIdAtom)
  const previous = get(excelHostSnapshotAtom)
  const previouslyOpen = sessionId
    ? previous.sessions.some((session) => session.sessionId === sessionId)
    : false
  const nextOpen = sessionId
    ? snapshot.sessions.some((session) => session.sessionId === sessionId)
    : false
  const closedFinalVisibleTab = previouslyOpen
    && !nextOpen
    && get(sessionWorkbenchSurfaceAtom) === SessionWorkbenchSurface.Excel
    && get(currentSessionFocusPaneAtom) === null

  set(excelHostSnapshotAtom, snapshot)
  if (closedFinalVisibleTab && !get(rightPanelCollapsedAtom)) {
    set(setRightPanelCollapsedAtom, true)
  }
})

/** The native Excel target belonging to the Agent Session being viewed. */
export const activeExcelHostSessionAtom = atom((get) => {
  const sessionId = get(viewedSessionIdAtom)
  if (!sessionId) return null
  return get(excelHostSnapshotAtom).sessions.find((session) => session.sessionId === sessionId) ?? null
})

const expandedSessionsAtom = atom<ReadonlySet<string>>(new Set<string>())

/** Whether Excel owns the complete center + right work area for this Session. */
export const excelExpandedAtom = atom(
  (get) => {
    const sessionId = get(viewedSessionIdAtom)
    return sessionId ? get(expandedSessionsAtom).has(sessionId) : false
  },
  (get, set, update: ExcelStateUpdate<boolean>) => {
    const sessionId = get(viewedSessionIdAtom)
    if (!sessionId) return
    const current = get(expandedSessionsAtom)
    const nextValue = typeof update === 'function' ? update(current.has(sessionId)) : update
    if (nextValue === current.has(sessionId)) return
    const next = new Set(current)
    if (nextValue) next.add(sessionId)
    else next.delete(sessionId)
    set(expandedSessionsAtom, next)
  },
)

/** Release renderer projection state after an Agent Session is deleted. */
export const purgeExcelStateAtom = atom(null, (get, set, sessionId: string) => {
  if (get(expandedSessionsAtom).has(sessionId)) {
    const expanded = new Set(get(expandedSessionsAtom))
    expanded.delete(sessionId)
    set(expandedSessionsAtom, expanded)
  }
  const snapshot = get(excelHostSnapshotAtom)
  if (snapshot.sessions.some((session) => session.sessionId === sessionId)) {
    set(excelHostSnapshotAtom, {
      sessions: snapshot.sessions.filter((session) => session.sessionId !== sessionId),
    })
  }
})
