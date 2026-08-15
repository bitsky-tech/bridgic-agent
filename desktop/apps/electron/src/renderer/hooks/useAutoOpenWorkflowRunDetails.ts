/** Open the right-column execution pane once when a Workflow Run generation starts. */
import { useEffect, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import {
  currentThinkingModeAtom,
  currentWorkflowRunAtom,
} from '@/atoms/agent'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { openWorkflowRunDetailsAtom } from '@/atoms/workflow-run-details'

/** Auto-open each Run once while preserving a manual close for that generation. */
export function useAutoOpenWorkflowRunDetails(): void {
  const sessionId = useAtomValue(activeSessionIdAtom)
  const position = useAtomValue(currentThinkingModeAtom)
  const run = useAtomValue(currentWorkflowRunAtom)
  const openDetails = useSetAtom(openWorkflowRunDetailsAtom)
  const openedRuns = useRef(new Set<string>())

  useEffect(() => {
    if (!sessionId || position?.mode !== 'run_workflow' || !run) return
    const key = `${sessionId}:${run.generation}`
    if (openedRuns.current.has(key)) return
    openedRuns.current.add(key)
    openDetails(run.generation)
  }, [openDetails, position?.mode, run, sessionId])
}
