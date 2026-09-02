/** Session workbench selection plus event-time Browser/Files reveal arbitration. */
import { atom } from 'jotai'
import {
  setBrowserNeedsAttentionAtom,
} from './browser-attention'
import {
  setFilesNeedsAttentionAtom,
} from './files-attention'
import {
  rightPanelCollapseRequestAtom,
  rightPanelCollapsedAtom,
  setRightPanelCollapsedAtom,
} from './layout'
import { viewedSessionIdAtom } from './navigation'
import {
  currentSessionFocusPaneAtom,
  currentSessionModeExitCollapseRequestAtom,
} from './session-focus-pane'

type SessionStateUpdate<T> = T | ((current: T) => T)

/** Durable tools that can occupy the viewed Session's workbench. */
export const SessionWorkbenchSurface = {
  Files: 'files',
  Workflows: 'workflows',
  Results: 'results',
  Schedules: 'schedules',
  Sheet: 'sheet',
  Doc: 'doc',
  Browser: 'browser',
} as const
export type SessionWorkbenchSurface =
  (typeof SessionWorkbenchSurface)[keyof typeof SessionWorkbenchSurface]

const workbenchSurfacesBySessionAtom = atom<ReadonlyMap<string, SessionWorkbenchSurface>>(
  new Map(),
)

/** Current viewed Session's tool; an unseen Session starts in the file system. */
export const sessionWorkbenchSurfaceAtom = atom((get): SessionWorkbenchSurface => {
  const sessionId = get(viewedSessionIdAtom)
  if (!sessionId) return SessionWorkbenchSurface.Files
  return get(workbenchSurfacesBySessionAtom).get(sessionId) ?? SessionWorkbenchSurface.Files
})

/** Set only the viewed Session's tool; writes outside a Session are ignored. */
export const setSessionWorkbenchSurfaceAtom = atom(
  null,
  (get, set, update: SessionStateUpdate<SessionWorkbenchSurface>) => {
    const sessionId = get(viewedSessionIdAtom)
    if (!sessionId) return
    const current = get(sessionWorkbenchSurfaceAtom)
    const next = typeof update === 'function' ? update(current) : update
    const surfaces = new Map(get(workbenchSurfacesBySessionAtom))
    if (next === SessionWorkbenchSurface.Files) surfaces.delete(sessionId)
    else surfaces.set(sessionId, next)
    set(workbenchSurfacesBySessionAtom, surfaces)
  },
)

export type AttentionWorkbenchSurface =
  | typeof SessionWorkbenchSurface.Browser
  | typeof SessionWorkbenchSurface.Files

/**
 * Report one new Browser/File activity at the moment it happens.
 *
 * Attention is latched first. The first activity finding a genuinely empty
 * right column owns it; a simultaneous or later activity sees that new owner
 * synchronously and stays in the background. This avoids delayed React effects
 * retargeting the dock from a newer UI snapshot.
 */
export const notifySessionWorkbenchActivityAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      agentModeHasPriority: boolean
      sessionId: string
      surface: AttentionWorkbenchSurface
    },
  ) => {
    if (!payload.sessionId) return
    if (payload.surface === SessionWorkbenchSurface.Browser) {
      set(setBrowserNeedsAttentionAtom, {
        sessionId: payload.sessionId,
        needsAttention: true,
      })
    } else {
      set(setFilesNeedsAttentionAtom, {
        sessionId: payload.sessionId,
        needsAttention: true,
      })
    }

    // Background Sessions/non-Home views only retain attention. Returning to
    // them later must never replay an old automatic reveal.
    if (get(viewedSessionIdAtom) !== payload.sessionId) return

    const agentOwnsColumn = payload.agentModeHasPriority
      || get(currentSessionFocusPaneAtom) !== null
    const columnIsOccupied = !get(rightPanelCollapsedAtom)
    const collapseIsPending = get(rightPanelCollapseRequestAtom)
      || get(currentSessionModeExitCollapseRequestAtom)
    if (agentOwnsColumn || columnIsOccupied || collapseIsPending) return

    set(setSessionWorkbenchSurfaceAtom, payload.surface)
    set(setRightPanelCollapsedAtom, false)
  },
)

/** Drop a deleted Session's durable workbench selection. */
export const purgeSessionWorkbenchStateAtom = atom(null, (get, set, sessionId: string) => {
  const current = get(workbenchSurfacesBySessionAtom)
  if (!current.has(sessionId)) return
  const next = new Map(current)
  next.delete(sessionId)
  set(workbenchSurfacesBySessionAtom, next)
})
