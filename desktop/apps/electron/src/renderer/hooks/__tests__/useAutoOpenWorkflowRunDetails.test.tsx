import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const {
  thinkingModeFamily,
  workflowRunFamily,
} = await import('@/atoms/agent')
const {
  briefFamily,
  openSpecPreviewAtom,
  specPreviewOpenAtom,
} = await import('@/atoms/build')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const {
  closeWorkflowRunDetailsAtom,
  workflowRunDetailsOpenAtom,
} = await import('@/atoms/workflow-run-details')
const { useAutoOpenWorkflowRunDetails } = await import('../useAutoOpenWorkflowRunDetails')

function Harness() {
  useAutoOpenWorkflowRunDetails()
  return null
}

function runState(sessionId: string, generation: string, stepIndex = 0) {
  return {
    workflowId: 'wf-auto-open',
    generation,
    workflowName: '自动打开测试工作流',
    sourceSessionId: sessionId,
    phase: 'execute' as const,
    stepIndex,
    executionSteps: ['执行第一步', '执行第二步'],
  }
}

describe('useAutoOpenWorkflowRunDetails', () => {
  it('opens each Run generation once and preserves a manual close', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-run-auto-open'
    store.set(activeSessionIdAtom, sessionId)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>,
      )
    })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)

    await act(async () => {
      store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)

    await act(async () => {
      store.set(workflowRunFamily(sessionId), runState(sessionId, 'generation-1'))
    })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(true)

    await act(async () => {
      store.set(closeWorkflowRunDetailsAtom)
      store.set(briefFamily(sessionId), '# 任务\n保留当前任务说明')
      store.set(openSpecPreviewAtom)
      store.set(workflowRunFamily(sessionId), runState(sessionId, 'generation-1', 1))
    })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)
    expect(store.get(specPreviewOpenAtom)).toBe(true)

    await act(async () => {
      store.set(thinkingModeFamily(sessionId), { mode: 'normal', stage: null })
      store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)

    await act(async () => {
      store.set(workflowRunFamily(sessionId), runState(sessionId, 'generation-2'))
    })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(true)
    expect(store.get(specPreviewOpenAtom)).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })

  it('replaces an open task preview when the Run starts', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-run-replaces-task'
    store.set(activeSessionIdAtom, sessionId)
    store.set(briefFamily(sessionId), '# 任务\n已有任务说明')
    store.set(openSpecPreviewAtom)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily(sessionId), runState(sessionId, 'generation-focused'))
    expect(store.get(specPreviewOpenAtom)).toBe(true)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>,
      )
    })

    expect(store.get(specPreviewOpenAtom)).toBe(false)
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(true)

    await act(async () => root.unmount())
    host.remove()
  })

  it('tracks one-shot auto-open history independently for each Session', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const generation = 'shared-generation-label'
    store.set(activeSessionIdAtom, 'session-a')
    store.set(thinkingModeFamily('session-a'), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily('session-a'), runState('session-a', generation))
    store.set(thinkingModeFamily('session-b'), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily('session-b'), runState('session-b', generation))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>,
      )
    })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(true)

    await act(async () => {
      store.set(closeWorkflowRunDetailsAtom)
      store.set(activeSessionIdAtom, 'session-b')
    })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(true)

    await act(async () => {
      store.set(activeSessionIdAtom, 'session-a')
    })
    expect(store.get(workflowRunDetailsOpenAtom)).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })
})
