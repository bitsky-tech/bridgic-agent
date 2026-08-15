import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DEFAULT_SETTINGS } from '@app/shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const testWindow = window as unknown as { api?: Record<string, unknown> }
testWindow.api = {
  ...testWindow.api,
  settings: {
    get: async () => DEFAULT_SETTINGS,
    set: async () => {},
  },
  fs: {
    listDir: async () => ({ ok: true, nodes: [] }),
    searchDir: async () => ({ hits: [], total: 0, partial: false }),
  },
  shell: {
    showItemInFolder: async () => {},
  },
  dialog: {
    open: async () => ({ canceled: true, filePaths: [] }),
  },
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { BackendState } = await import('../../../../main/python-client/types')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { activeModalAtom, ComposerTarget, ModalKind } = await import('@/atoms/amphi')
const {
  activeSessionIdAtom,
  pendingComposerInsertsAtom,
} = await import('@/atoms/sessions')
const { hydrateWorkflowDefinitionsAtom } = await import('@/atoms/workflows')
const { SessionFilesPanel } = await import('../SessionFilesPanel')
const { WorkflowLibraryPanel } = await import('../WorkflowLibraryPanel')

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

function readyStore() {
  const store = createStore()
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
  } as never)
  return store
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('Session workbench tools', () => {
  it('renders the Files tool as a dedicated searchable surface', async () => {
    const store = readyStore()
    store.set(activeSessionIdAtom, 'session-files')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SessionFilesPanel />
        </Provider>,
      )
    })

    expect(host.querySelector('[data-testid="session-files-panel"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="session-files-header"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="session-files-search"] input')).not.toBeNull()

    await act(async () => root.unmount())
  })

  it('hydrates each Workflow scope independently and runs into the current composer', async () => {
    const store = readyStore()
    store.set(activeSessionIdAtom, 'session-workflows')
    const sessionWorkflow = {
      id: 'wf-session',
      name: '本会话目录统计',
      workflow_dir: '/workflows/wf-session',
      desc: '只在当前会话中关联',
      source_session_id: 'session-workflows',
    }
    const allWorkflow = {
      id: 'wf-all',
      name: '全局论文筛选',
      workflow_dir: '/workflows/wf-all',
      desc: '全部工作流中的项目',
      source_session_id: 'another-session',
    }
    const requestedWorkflowScopes: Array<string | null> = []
    let workflowRunRequests = 0
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const request = new URL(String(input))
      if (request.pathname === '/workflows') {
        const sessionId = request.searchParams.get('session_id')
        requestedWorkflowScopes.push(sessionId)
        return jsonResponse(sessionId ? [sessionWorkflow] : [sessionWorkflow, allWorkflow])
      }
      if (request.pathname === '/workflow-runs') {
        workflowRunRequests += 1
        return jsonResponse([])
      }
      return jsonResponse({})
    }) as never

    // Prime the all-workflow projection; the panel still owns its session-scope hydration.
    await store.set(hydrateWorkflowDefinitionsAtom)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowLibraryPanel />
        </Provider>,
      )
    })
    await flushEffects()

    expect(host.querySelector('[data-testid="workflow-library-panel"]')).not.toBeNull()
    expect(host.textContent).toContain('本会话目录统计')
    expect(host.textContent).not.toContain('全局论文筛选')

    const scopeTabs = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    expect(scopeTabs.length).toBe(2)
    await act(async () => scopeTabs[1]?.click())
    await flushEffects()
    expect(host.textContent).toContain('本会话目录统计')
    expect(host.textContent).toContain('全局论文筛选')
    expect(requestedWorkflowScopes).toContain('session-workflows')
    expect(requestedWorkflowScopes).toContain(null)
    expect(workflowRunRequests).toBe(0)

    const viewButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-library-view-wf-all"]',
    )
    await act(async () => viewButton?.click())
    expect(store.get(activeModalAtom)).toEqual({
      type: ModalKind.WorkflowDetail,
      workflowId: 'wf-all',
      workflowName: '全局论文筛选',
      composerTarget: ComposerTarget.CurrentSession,
    })

    const runButton = host.querySelector<HTMLButtonElement>(
      '[data-testid="workflow-library-run-wf-all"]',
    )
    await act(async () => runButton?.click())
    expect(store.get(pendingComposerInsertsAtom)).toEqual([[
      {
        type: 'slash',
        id: 'wf-all',
        label: '全局论文筛选',
        resource: 'workflow',
      },
      { type: 'text', value: ' ' },
    ]])
    await act(async () => root.unmount())
  })
})
