import type { EmbeddedPowerPointSnapshot } from '@shared/types'
import { atom } from 'jotai'
import { viewedSessionIdAtom } from './navigation'
import {
  rightPanelCollapsedAtom,
  setRightPanelCollapsedAtom,
} from './layout'
import { currentSessionFocusPaneAtom } from './session-focus-pane'
import { SessionWorkbenchSurface, sessionWorkbenchSurfaceAtom } from './workbench'

export const embeddedPowerPointSnapshotAtom = atom<EmbeddedPowerPointSnapshot>({ sessions: [] })

/** The PowerPoint surface owned by the Agent Session currently shown in the app. */
export const activeEmbeddedPowerPointSessionAtom = atom((get) => {
  const sessionId = get(viewedSessionIdAtom)
  if (!sessionId) return null
  return get(embeddedPowerPointSnapshotAtom).sessions.find(
    (session) => session.sessionId === sessionId,
  ) ?? null
})

/** Apply native PPT state and retract the visible tool after its document surface closes. */
export const setEmbeddedPowerPointSnapshotAtom = atom(
  null,
  (get, set, snapshot: EmbeddedPowerPointSnapshot) => {
    const sessionId = get(viewedSessionIdAtom)
    const previous = get(embeddedPowerPointSnapshotAtom)
    const previouslyOpen = sessionId
      ? previous.sessions.some((session) => session.sessionId === sessionId)
      : false
    const nowOpen = sessionId
      ? snapshot.sessions.some((session) => session.sessionId === sessionId)
      : false
    const closedVisiblePresentation = previouslyOpen
      && !nowOpen
      && get(sessionWorkbenchSurfaceAtom) === SessionWorkbenchSurface.Presentation
      && get(currentSessionFocusPaneAtom) === null

    set(embeddedPowerPointSnapshotAtom, snapshot)
    if (closedVisiblePresentation && !get(rightPanelCollapsedAtom)) {
      set(setRightPanelCollapsedAtom, true)
    }
  },
)
