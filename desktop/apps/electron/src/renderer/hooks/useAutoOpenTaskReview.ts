/**
 * Open the task preview at the mode-specific review boundary.
 *
 * Create waits for the pending task confirmation because no useful task exists
 * before Clarify completes. Edit opens on clarify entry after loading the saved
 * Workflow task, then switches to its diff when the revised review arrives.
 * This hook lives at app level because a collapsed right panel is unmounted.
 */
import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  currentBuildPresentationCycleAtom,
  currentPendingTaskConfirmAtom,
  loadEditBaselineAtom,
  openSpecPreviewAtom,
} from '@/atoms/build'
import { currentThinkingModeAtom } from '@/atoms/agent'
import { activeSessionIdAtom } from '@/atoms/sessions'

export function useAutoOpenTaskReview(): void {
  const sessionId = useAtomValue(activeSessionIdAtom)
  const buildCycle = useAtomValue(currentBuildPresentationCycleAtom)
  const taskConfirm = useAtomValue(currentPendingTaskConfirmAtom)
  const position = useAtomValue(currentThinkingModeAtom)
  const loadEditBaseline = useSetAtom(loadEditBaselineAtom)
  const openPreview = useSetAtom(openSpecPreviewAtom)
  const openedReviews = useRef(new Set<string>())
  const openedEditBaselines = useRef(new Set<string>())

  useEffect(() => {
    const workflowId =
      position?.mode === 'build' && position.stage === 'clarify'
        ? position.workflowId
        : null
    if (!sessionId || !workflowId) return
    const key = `${sessionId}:${buildCycle}:${workflowId}`
    if (openedEditBaselines.current.has(key)) return
    let cancelled = false
    void loadEditBaseline({ sessionId, workflowId }).then((content) => {
      if (cancelled || content === null) return
      openedEditBaselines.current.add(key)
      openPreview()
    })
    return () => {
      cancelled = true
    }
  }, [buildCycle, loadEditBaseline, openPreview, position, sessionId])

  useEffect(() => {
    if (!sessionId || !taskConfirm) return
    const key = `${sessionId}:${buildCycle}:${taskConfirm.requestId}`
    if (openedReviews.current.has(key)) return
    openedReviews.current.add(key)
    openPreview()
  }, [buildCycle, openPreview, sessionId, taskConfirm])
}
