/** Session-mode surfaces share one temporary rail slot above persistent tools. */
import { atom } from 'jotai'
import {
  currentBriefAtom,
  focusModeAtom,
} from './build'
import {
  currentThinkingModeAtom,
  currentWorkflowRunAtom,
} from './agent'
import {
  currentSessionFocusPaneAtom,
  SessionFocusPaneKind,
  setSessionFocusPaneAtom,
} from './session-focus-pane'

export const SessionModeSurfaceKind = {
  Task: 'task',
  WorkflowRun: 'workflow_run',
} as const
export type SessionModeSurfaceKind =
  (typeof SessionModeSurfaceKind)[keyof typeof SessionModeSurfaceKind]

/** The temporary Agent-mode surface currently available to the active Session. */
export const sessionModeSurfaceAtom = atom((get): SessionModeSurfaceKind | null => {
  const taskAvailable = get(currentBriefAtom) !== null && get(focusModeAtom)
  if (taskAvailable) return SessionModeSurfaceKind.Task

  const position = get(currentThinkingModeAtom)
  const run = get(currentWorkflowRunAtom)
  if (position?.mode === 'run_workflow' && run) return SessionModeSurfaceKind.WorkflowRun
  return null
})

/** The available mode surface is selected only when its identity still matches. */
export const selectedSessionModeSurfaceAtom = atom((get): SessionModeSurfaceKind | null => {
  const surface = get(sessionModeSurfaceAtom)
  const selection = get(currentSessionFocusPaneAtom)
  if (
    surface === SessionModeSurfaceKind.Task
    && selection?.kind === SessionFocusPaneKind.TaskSpec
  ) return surface
  if (
    surface === SessionModeSurfaceKind.WorkflowRun
    && selection?.kind === SessionFocusPaneKind.WorkflowRun
    && selection.generation === get(currentWorkflowRunAtom)?.generation
  ) return surface
  return null
})

/** Bring the active Session's temporary Agent-mode surface to the foreground. */
export const openSessionModeSurfaceAtom = atom(null, (get, set) => {
  const surface = get(sessionModeSurfaceAtom)
  if (surface === SessionModeSurfaceKind.Task) {
    set(setSessionFocusPaneAtom, { kind: SessionFocusPaneKind.TaskSpec })
    return
  }
  if (surface === SessionModeSurfaceKind.WorkflowRun) {
    const run = get(currentWorkflowRunAtom)
    if (run) {
      set(setSessionFocusPaneAtom, {
        kind: SessionFocusPaneKind.WorkflowRun,
        generation: run.generation,
      })
    }
  }
})

/** Effective visibility of any temporary Session-mode surface. */
export const sessionFocusPaneOpenAtom = atom(
  (get) => get(selectedSessionModeSurfaceAtom) !== null,
)
