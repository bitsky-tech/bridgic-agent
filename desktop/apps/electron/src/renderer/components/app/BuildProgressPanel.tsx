/**
 * Right-column output surface — renders `RightPanel` groups such as saved Workflows,
 * Workflow Run results, and Session files. `SessionResourcePanel` owns switching
 * between this durable tool surface and temporary Agent-mode surfaces.
 *
 * Visibility is decided by `showRightPanelAtom`, shared with App's right-column slot.
 *
 * Note: `building`/`completed` are scaffolding props reserved for daemon output events; the daemon does not emit those
 * events yet, so they are not passed here (RightPanel has its own empty-state fallback).
 */
import { useCallback, useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  ComposerTarget,
  ModalKind,
  openModalAtom,
  RightPanelFilter,
  selectRightPanelFilterAtom,
  showRightPanelAtom,
} from '@/atoms/amphi'
import {
  activeSessionWorkflowRunsAtom,
  activeSessionWorkflowsAtom,
  hydrateSessionWorkflowRunsAtom,
  hydrateSessionWorkflowsAtom,
} from '@/atoms/workflows'
import { activeSessionIdAtom, sessionCompletionSeqByIdAtom } from '@/atoms/sessions'
import { RightPanel, type CompletedWorkflow } from '@/components/amphi'
import type { WorkflowSummary } from '@/lib/amphiClient'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

export interface BuildProgressPanelProps {
  /** Hide the output surface's native heading when another host supplies one. */
  showHeader?: boolean
}

/** Right-column content. Mounted in AppLayout's right slot; the collapsed state is controlled by App through rightCollapsed. */
export function BuildProgressPanel({ showHeader = true }: BuildProgressPanelProps = {}) {
  const show = useAtomValue(showRightPanelAtom)
  const workflows = useAtomValue(activeSessionWorkflowsAtom)
  const workflowRuns = useAtomValue(activeSessionWorkflowRunsAtom)
  const sessionId = useAtomValue(activeSessionIdAtom)
  const completionSeqById = useAtomValue(sessionCompletionSeqByIdAtom)
  const completionSeq = sessionId ? completionSeqById[sessionId] ?? 0 : 0
  const hydrateSessionWorkflows = useSetAtom(hydrateSessionWorkflowsAtom)
  const hydrateSessionWorkflowRuns = useSetAtom(hydrateSessionWorkflowRunsAtom)
  const openModal = useSetAtom(openModalAtom)
  const selectRightPanelFilter = useSetAtom(selectRightPanelFilterAtom)
  const handledCompletionsRef = useRef(new Map<string, number>())
  const workflowRunsRef = useRef(workflowRuns)

  useEffect(() => {
    workflowRunsRef.current = workflowRuns
  }, [workflowRuns])

  // Eye icon → open that workflow's full detail dialog (the top of the first tab, "workflow info", is its task spec).
  const handlePreviewWorkflow = useCallback(
    (workflowId: string, workflowName: string) => {
      openModal({
        type: ModalKind.WorkflowDetail,
        workflowId,
        workflowName,
        composerTarget: ComposerTarget.CurrentSession,
      })
    },
    [openModal],
  )

  const handlePreviewWorkflowRun = useCallback(
    (runId: string) => {
      openModal({
        type: ModalKind.WorkflowRunDetail,
        runId,
        composerTarget: ComposerTarget.CurrentSession,
      })
    },
    [openModal],
  )

  useEffect(() => {
    if (!show || !sessionId) return
    const handledCompletion = handledCompletionsRef.current.get(sessionId) ?? 0
    const shouldRevealNewRun = completionSeq > handledCompletion
    const known = new Set(workflowRunsRef.current.map((run) => run.id))
    let cancelled = false
    void hydrateSessionWorkflows(sessionId)
    void hydrateSessionWorkflowRuns(sessionId).then((runs) => {
      if (cancelled) return
      if (shouldRevealNewRun) {
        handledCompletionsRef.current.set(sessionId, completionSeq)
      }
      if (
        shouldRevealNewRun
        && runs.some((run) => !known.has(run.id))
      ) {
        selectRightPanelFilter(RightPanelFilter.WorkflowRun)
      }
    })
    return () => {
      cancelled = true
    }
  }, [
    completionSeq,
    hydrateSessionWorkflowRuns,
    hydrateSessionWorkflows,
    selectRightPanelFilter,
    sessionId,
    show,
  ])

  if (!show) return null
  return (
    <RightPanel
      completed={workflows.map(toCompletedWorkflow)}
      workflowRuns={workflowRuns}
      onPreviewWorkflow={handlePreviewWorkflow}
      onPreviewWorkflowRun={handlePreviewWorkflowRun}
      headerHeight={SESSION_STATUS_BAR_HEIGHT_PX}
      showHeader={showHeader}
    />
  )
}

function toCompletedWorkflow(w: WorkflowSummary): CompletedWorkflow {
  return {
    id: w.id,
    name: w.name,
  }
}
