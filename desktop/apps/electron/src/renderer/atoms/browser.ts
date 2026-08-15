import { atom } from 'jotai'
import type { EmbeddedBrowserSnapshot } from '@shared/types'
import { viewedSessionIdAtom } from './navigation'
import {
  rightPanelCollapsedAtom,
  setRightPanelCollapsedAtom,
} from './layout'
import { currentSessionFocusPaneAtom } from './session-focus-pane'
import {
  SessionWorkbenchSurface,
  sessionWorkbenchSurfaceAtom,
} from './workbench'

export {
  SessionWorkbenchSurface,
  sessionWorkbenchSurfaceAtom,
  setSessionWorkbenchSurfaceAtom,
} from './workbench'

type SessionStateUpdate<T> = T | ((current: T) => T)

export const embeddedBrowserSnapshotAtom = atom<EmbeddedBrowserSnapshot>({ sessions: [] })

const expandedBrowserSessionsAtom = atom<ReadonlySet<string>>(new Set<string>())

const browserHandoffSessionsAtom = atom<ReadonlySet<string>>(new Set<string>())

/** Sessions whose native Browser is hiding before a user-selected surface can commit. */
export const setBrowserHandoffPendingAtom = atom(
  null,
  (get, set, update: { sessionId: string; pending: boolean }) => {
    const current = get(browserHandoffSessionsAtom)
    if (current.has(update.sessionId) === update.pending) return
    const next = new Set(current)
    if (update.pending) next.add(update.sessionId)
    else next.delete(update.sessionId)
    set(browserHandoffSessionsAtom, next)
  },
)

/** Whether the viewed Session's browser owns the work area; scoped per Session. */
export const browserExpandedAtom = atom(
  (get) => {
    const sessionId = get(viewedSessionIdAtom)
    return sessionId ? get(expandedBrowserSessionsAtom).has(sessionId) : false
  },
  (get, set, update: SessionStateUpdate<boolean>) => {
    const sessionId = get(viewedSessionIdAtom)
    if (!sessionId) return
    const current = get(expandedBrowserSessionsAtom)
    const next = typeof update === 'function' ? update(current.has(sessionId)) : update
    if (next === current.has(sessionId)) return
    const expandedSessions = new Set(current)
    if (next) expandedSessions.add(sessionId)
    else expandedSessions.delete(sessionId)
    set(expandedBrowserSessionsAtom, expandedSessions)
  },
)

const browserSurfaceBlockersAtom = atom<ReadonlySet<string>>(new Set<string>())

/** Native WebContentsView must hide while renderer-owned UI overlaps its canvas. */
export const browserSurfaceBlockedAtom = atom((get) => get(browserSurfaceBlockersAtom).size > 0)

/** Add or remove one independently-owned native-surface blocker. */
export const setBrowserSurfaceBlockerAtom = atom(
  null,
  (get, set, update: { source: string; blocked: boolean }) => {
    const current = get(browserSurfaceBlockersAtom)
    const next = new Set(current)
    if (update.blocked) next.add(update.source)
    else next.delete(update.source)
    if (next.size !== current.size || ![...next].every((source) => current.has(source))) {
      set(browserSurfaceBlockersAtom, next)
    }
  },
)

/** The browser surface belonging to the Agent Session the user is viewing. */
export const activeEmbeddedBrowserSessionAtom = atom((get) => {
  const sessionId = get(viewedSessionIdAtom)
  if (!sessionId) return null
  return get(embeddedBrowserSnapshotAtom).sessions.find((item) => item.sessionId === sessionId) ?? null
})

/** Apply native Browser state and retract only a currently visible Browser whose
 *  last tab disappeared. Keeping the Browser selection intact is deliberate:
 *  a later manual click reopens its empty/start surface instead of being treated
 *  as another close transition. */
export const setEmbeddedBrowserSnapshotAtom = atom(
  null,
  (get, set, snapshot: EmbeddedBrowserSnapshot) => {
    const sessionId = get(viewedSessionIdAtom)
    const previous = get(embeddedBrowserSnapshotAtom)
    const previousTabs = sessionId
      ? previous.sessions.find((session) => session.sessionId === sessionId)?.tabs.length ?? 0
      : 0
    const nextTabs = sessionId
      ? snapshot.sessions.find((session) => session.sessionId === sessionId)?.tabs.length ?? 0
      : 0
    const closedFinalVisibleTab = previousTabs > 0
      && nextTabs === 0
      && get(sessionWorkbenchSurfaceAtom) === SessionWorkbenchSurface.Browser
      && get(currentSessionFocusPaneAtom) === null
      && (!sessionId || !get(browserHandoffSessionsAtom).has(sessionId))

    set(embeddedBrowserSnapshotAtom, snapshot)
    if (closedFinalVisibleTab && !get(rightPanelCollapsedAtom)) {
      set(setRightPanelCollapsedAtom, true)
    }
  },
)
