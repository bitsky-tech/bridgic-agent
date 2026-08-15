import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import {
  thinkingModeFamily,
  workflowRunFamily,
} from '@/atoms/agent'
import {
  briefFamily,
  closeSpecPreviewAtom,
  openSpecPreviewAtom,
  specPreviewOpenAtom,
} from '@/atoms/build'
import { activeSessionIdAtom } from '@/atoms/sessions'
import {
  closeWorkflowRunDetailsAtom,
  openWorkflowRunDetailsAtom,
  workflowRunDetailsOpenAtom,
} from '@/atoms/workflow-run-details'

function seedRun(store: ReturnType<typeof createStore>, sessionId: string, generation: string) {
  store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
  store.set(workflowRunFamily(sessionId), {
    workflowId: 'wf-run-details',
    generation,
    workflowName: '测试工作流',
    sourceSessionId: sessionId,
    phase: 'execute',
    stepIndex: 0,
    executionSteps: ['执行一步'],
    validationSteps: [],
  })
}

describe('Workflow Run detail pane state', () => {
  it('isolates the open generation by Session and does not carry it into a replacement Run', () => {
    const store = createStore()
    seedRun(store, 'session-a', 'generation-a1')
    seedRun(store, 'session-b', 'generation-b1')
    store.set(activeSessionIdAtom, 'session-a')

    store.set(openWorkflowRunDetailsAtom, 'stale-generation')
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)
    store.set(openWorkflowRunDetailsAtom)
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(true)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(true)

    seedRun(store, 'session-a', 'generation-a2')
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)

    store.set(openWorkflowRunDetailsAtom)
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(true)
    store.set(closeWorkflowRunDetailsAtom)
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)
  })

  it('closes effectively when the Session leaves Run mode and replaces an open task preview', () => {
    const store = createStore()
    const sessionId = 'session-focused-pane'
    store.set(activeSessionIdAtom, sessionId)
    seedRun(store, sessionId, 'generation-focused')
    store.set(briefFamily(sessionId), '# 任务\n测试任务')
    store.set(openSpecPreviewAtom)
    expect(store.get(specPreviewOpenAtom)).toBe(true)

    store.set(openWorkflowRunDetailsAtom)
    expect(store.get(specPreviewOpenAtom)).toBe(false)
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(true)

    store.set(openSpecPreviewAtom)
    expect(store.get(specPreviewOpenAtom)).toBe(true)
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)
    store.set(closeSpecPreviewAtom)
    expect(store.get(specPreviewOpenAtom)).toBe(false)
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)

    store.set(openWorkflowRunDetailsAtom)
    store.set(thinkingModeFamily(sessionId), { mode: 'normal', stage: null })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)
  })
})
