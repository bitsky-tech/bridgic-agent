/**
 * Active Workflow Run detail-pane state.
 *
 * The selected generation is stored per Session so switching conversations never
 * leaks an open pane to another Run. The effective atom also requires the viewed
 * Session to still be executing that exact generation; finishing or replacing the
 * Run therefore closes the Agent pane automatically.
 */
import { atom } from 'jotai'
import { currentThinkingModeAtom, currentWorkflowRunAtom } from './agent'
import { activeSessionIdAtom } from './sessions'
import {
  currentSessionFocusPaneAtom,
  SessionFocusPaneKind,
  setSessionFocusPaneAtom,
} from './session-focus-pane'

/** Whether the active Session's current Workflow Run owns the right column. */
export const workflowRunDetailsOpenAtom = atom((get) => {
  const sessionId = get(activeSessionIdAtom)
  const position = get(currentThinkingModeAtom)
  const run = get(currentWorkflowRunAtom)
  if (!sessionId || position?.mode !== 'run_workflow' || !run) return false
  const selection = get(currentSessionFocusPaneAtom)
  return selection?.kind === SessionFocusPaneKind.WorkflowRun
    && selection.generation === run.generation
})

/** Open the right-column details for the active Run generation. */
export const openWorkflowRunDetailsAtom = atom(
  null,
  (get, set, generation?: string) => {
    const sessionId = get(activeSessionIdAtom)
    const position = get(currentThinkingModeAtom)
    const run = get(currentWorkflowRunAtom)
    if (
      !sessionId
      || position?.mode !== 'run_workflow'
      || !run
      || (generation !== undefined && generation !== run.generation)
    ) return
    set(setSessionFocusPaneAtom, {
      kind: SessionFocusPaneKind.WorkflowRun,
      generation: run.generation,
    })
  },
)

/** Close the active Session's Workflow Run details. */
export const closeWorkflowRunDetailsAtom = atom(null, (get, set) => {
  const sessionId = get(activeSessionIdAtom)
  if (!sessionId) return
  if (get(currentSessionFocusPaneAtom)?.kind !== SessionFocusPaneKind.WorkflowRun) return
  set(setSessionFocusPaneAtom, null)
})
