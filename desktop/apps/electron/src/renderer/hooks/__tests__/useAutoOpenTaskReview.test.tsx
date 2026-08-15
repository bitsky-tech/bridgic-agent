import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { AgentRole } = await import('@shared/types')
const { messageFamily, thinkingModeFamily } = await import('@/atoms/agent')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const {
  closeSpecPreviewAtom,
  originalBriefFamily,
  specPreviewOpenAtom,
} = await import('@/atoms/build')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { BackendState } = await import('../../../main/python-client/types')
const { useAutoOpenTaskReview } = await import('../useAutoOpenTaskReview')

function Harness() {
  useAutoOpenTaskReview()
  return null
}

describe('useAutoOpenTaskReview', () => {
  it('does not open on build clarify entry and waits for the task review', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-build-entry'
    store.set(activeSessionIdAtom, sessionId)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>,
      )
      store.set(thinkingModeFamily(sessionId), {
        mode: 'build',
        stage: 'clarify',
      })
    })
    expect(store.get(specPreviewOpenAtom)).toBe(false)

    await act(async () => {
      store.set(messageFamily(sessionId), [{
        id: 'assistant-build-review',
        role: AgentRole.Assistant,
        text: '',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-build-review',
          taskMarkdown: '# Task\nNew definition',
          status: 'pending',
        }],
        done: true,
        createdAt: 1,
      }])
    })
    expect(store.get(specPreviewOpenAtom)).toBe(true)

    await act(async () => root.unmount())
    host.remove()
  })

  it('loads and opens the restored original task when edit clarify starts', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () =>
      new Response(JSON.stringify({
        id: 'wf-existing',
        name: 'Existing Workflow',
        fields: { task: { value: '# Task\nOriginal definition' } },
      }), {
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-edit-entry'
    store.set(activeSessionIdAtom, sessionId)
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
      },
      lastError: null,
    } as never)

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <Harness />
          </Provider>,
        )
      })
      await act(async () => {
        store.set(thinkingModeFamily(sessionId), {
          mode: 'build',
          stage: 'clarify',
          workflowId: 'wf-existing',
        })
      })

      expect(store.get(specPreviewOpenAtom)).toBe(true)
      expect(store.get(originalBriefFamily(sessionId))).toContain('Original definition')
    } finally {
      await act(async () => root.unmount())
      host.remove()
      globalThis.fetch = originalFetch
    }
  })

  it('opens a collapsed preview for a new review but respects a manual close', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-review'
    store.set(activeSessionIdAtom, sessionId)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <Harness />
        </Provider>,
      )
    })
    expect(store.get(specPreviewOpenAtom)).toBe(false)

    await act(async () => {
      store.set(messageFamily(sessionId), [{
        id: 'assistant-review',
        role: AgentRole.Assistant,
        text: '',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-review-1',
          taskMarkdown: '# Task\nReview me',
          status: 'pending',
        }],
        done: true,
        createdAt: 1,
      }])
    })
    expect(store.get(specPreviewOpenAtom)).toBe(true)

    await act(async () => {
      store.set(closeSpecPreviewAtom)
    })
    expect(store.get(specPreviewOpenAtom)).toBe(false)

    await act(async () => {
      store.set(messageFamily(sessionId), [{
        id: 'assistant-review-2',
        role: AgentRole.Assistant,
        text: '',
        toolCalls: [],
        blocks: [{
          type: 'task_confirm',
          requestId: 'task-review-2',
          taskMarkdown: '# Task\nReview me again',
          status: 'pending',
        }],
        done: true,
        createdAt: 2,
      }])
    })
    expect(store.get(specPreviewOpenAtom)).toBe(true)

    await act(async () => root.unmount())
    host.remove()
  })
})
