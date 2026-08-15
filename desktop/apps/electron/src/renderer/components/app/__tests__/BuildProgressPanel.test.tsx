import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { BackendState } = await import('../../../../main/python-client/types')
const {
  RightPanelFilter,
  rightPanelFilterAtom,
  showRightPanelAtom,
} = await import('@/atoms/amphi')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const {
  activeSessionIdAtom,
  bumpSessionCompletionAtom,
  hydrateSessionsFromDaemonAtom,
} = await import('@/atoms/sessions')
const { activeSessionWorkflowRunsAtom } = await import('@/atoms/workflows')
const { BuildProgressPanel } = await import('../BuildProgressPanel')

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('BuildProgressPanel Workflow Run refresh', () => {
  it('does not query or show the resource panel for a Child Session', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const requestedPaths: string[] = []

    globalThis.fetch = mock(async (url: string) => {
      const path = new URL(url).pathname
      requestedPaths.push(path)
      if (path === '/sessions') return jsonResponse([
        { id: 'root', title: 'Root', parent_session_id: null },
        { id: 'child', title: 'Child', parent_session_id: 'root', subagent_mode: 'background' },
      ])
      return jsonResponse([])
    }) as never
    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
        runtimeFile: null,
      },
      lastError: null,
      compatibility: null,
    })
    await store.set(hydrateSessionsFromDaemonAtom)
    store.set(activeSessionIdAtom, 'child')

    await act(async () => {
      root.render(
        <Provider store={store}>
          <BuildProgressPanel />
        </Provider>,
      )
    })
    await flushEffects()

    expect(store.get(showRightPanelAtom)).toBe(false)
    expect(requestedPaths).toEqual(['/sessions'])
    expect(host.textContent).toBe('')

    await act(async () => root.unmount())
    host.remove()
  })

  it('refreshes and reveals a completed Run only when its owning Session becomes active', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const run = {
      id: 'wfr-session-a',
      workflow_id: 'wf-a',
      workflow_name: 'A 会话工作流',
      source_session_id: 'session-a',
      workflow_input: { text: '运行 A', blocks: [] },
      status: 'completed',
      validation_status: 'passed',
      created_at: '2026-07-31T08:00:00Z',
      finished_at: '2026-07-31T08:01:00Z',
    }
    const requestedRunSessions: string[] = []

    globalThis.fetch = mock(async (url: string) => {
      const request = new URL(url)
      if (request.pathname === '/workflows') return jsonResponse([])
      if (request.pathname === '/workflow-runs') {
        const sessionId = request.searchParams.get('session_id') ?? ''
        requestedRunSessions.push(sessionId)
        return jsonResponse(sessionId === 'session-a' ? [run] : [])
      }
      return jsonResponse({})
    }) as never

    store.set(backendSnapshotAtom, {
      state: BackendState.Ready,
      endpoint: {
        baseUrl: 'http://127.0.0.1:7421',
        token: 'test-token',
        version: null,
        startedAt: null,
        wsPath: null,
        runtimeFile: null,
      },
      lastError: null,
      compatibility: null,
    })
    store.set(activeSessionIdAtom, 'session-b')

    await act(async () => {
      root.render(
        <Provider store={store}>
          <BuildProgressPanel />
        </Provider>,
      )
    })
    await flushEffects()
    await act(async () => {
      store.set(rightPanelFilterAtom, RightPanelFilter.Files)
    })

    await act(async () => {
      store.set(bumpSessionCompletionAtom, 'session-a')
    })
    await flushEffects()

    expect(requestedRunSessions).toEqual(['session-b'])
    expect(store.get(rightPanelFilterAtom)).toBe(RightPanelFilter.Files)

    await act(async () => {
      store.set(activeSessionIdAtom, 'session-a')
    })
    await flushEffects()

    expect(requestedRunSessions).toEqual(['session-b', 'session-a'])
    expect(store.get(activeSessionWorkflowRunsAtom).map((item) => item.id)).toEqual([
      'wfr-session-a',
    ])
    expect(store.get(rightPanelFilterAtom)).toBe(RightPanelFilter.WorkflowRun)

    await act(async () => root.unmount())
    host.remove()
  })
})
