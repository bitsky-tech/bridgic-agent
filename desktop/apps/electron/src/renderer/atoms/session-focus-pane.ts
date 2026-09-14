/** Per-Session selection for the temporary Agent-mode surface in the right dock. */
import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'
import { activeSessionIdAtom } from './sessions'

export const SessionFocusPaneKind = {
  Presentation: 'presentation',
  TaskSpec: 'task_spec',
  WorkflowRun: 'workflow_run',
} as const
export type SessionFocusPaneKind =
  (typeof SessionFocusPaneKind)[keyof typeof SessionFocusPaneKind]

export type SessionFocusPaneSelection =
  | { kind: typeof SessionFocusPaneKind.Presentation }
  | { kind: typeof SessionFocusPaneKind.TaskSpec }
  | { kind: typeof SessionFocusPaneKind.WorkflowRun; generation: string }

const selectionFamily = atomFamily(
  (_sessionId: string) => atom<SessionFocusPaneSelection | null>(null),
)

const exitCollapseRequestFamily = atomFamily(
  (_sessionId: string) => atom(false),
)

/** Selected mode surface for the active Session, before content validity checks. */
export const currentSessionFocusPaneAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  return sessionId ? get(selectionFamily(sessionId)) : null
})

/** Whether the viewed Session should finish closing its Agent-owned right pane. */
export const currentSessionModeExitCollapseRequestAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  return sessionId ? get(exitCollapseRequestFamily(sessionId)) : false
})

/** Select or clear the active Session's exclusive focus pane. */
export const setSessionFocusPaneAtom = atom(
  null,
  (get, set, selection: SessionFocusPaneSelection | null) => {
    const sessionId = get(activeSessionIdAtom)
    if (!sessionId) return
    set(selectionFamily(sessionId), selection)
  },
)

/** Consume one Session-scoped Agent-exit collapse request after dock handoff. */
export const consumeSessionModeExitCollapseRequestAtom = atom(
  null,
  (get, set, sessionId: string) => {
    if (!get(exitCollapseRequestFamily(sessionId))) return
    set(exitCollapseRequestFamily(sessionId), false)
  },
)

/** Synchronize live-mode cycle ownership with one daemon thinking-mode update. */
export const syncSessionFocusPaneModeAtom = atom(
  null,
  (
    get,
    set,
    payload: {
      sessionId: string
      previousMode: 'build' | 'normal' | 'presentation' | 'run_workflow' | null
      nextMode: 'build' | 'normal' | 'presentation' | 'run_workflow'
      runGeneration?: string
    },
  ) => {
    if (
      payload.nextMode === 'build'
      || payload.nextMode === 'presentation'
      || payload.nextMode === 'run_workflow'
    ) {
      set(exitCollapseRequestFamily(payload.sessionId), false)
      return
    }

    if (
      payload.previousMode !== 'build'
      && payload.previousMode !== 'presentation'
      && payload.previousMode !== 'run_workflow'
    ) return
    const selection = get(selectionFamily(payload.sessionId))
    let agentOwnsPane = false
    if (payload.previousMode === 'build') {
      agentOwnsPane = selection?.kind === SessionFocusPaneKind.TaskSpec
    } else if (payload.previousMode === 'presentation') {
      agentOwnsPane = selection?.kind === SessionFocusPaneKind.Presentation
    } else {
      agentOwnsPane = selection?.kind === SessionFocusPaneKind.WorkflowRun
        && selection.generation === payload.runGeneration
    }
    set(selectionFamily(payload.sessionId), null)
    set(exitCollapseRequestFamily(payload.sessionId), agentOwnsPane)
  },
)

/** Clear one kind of transient surface for a specific Session. */
export const clearSessionFocusPaneKindAtom = atom(
  null,
  (get, set, payload: { sessionId: string; kind: SessionFocusPaneKind }) => {
    const current = get(selectionFamily(payload.sessionId))
    if (current?.kind === payload.kind) set(selectionFamily(payload.sessionId), null)
  },
)

/** Drop transient focus selection for a deleted Session. */
export function purgeSessionFocusPaneState(sessionId: string): void {
  selectionFamily.remove(sessionId)
  exitCollapseRequestFamily.remove(sessionId)
}
