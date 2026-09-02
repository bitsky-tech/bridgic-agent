import { describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'

import {
  activeSessionWorkflowRunsAtom,
  activeSessionWorkflowsAtom,
  associateSessionWorkflowsFromInputAtom,
  deleteWorkflowAtom,
  deleteWorkflowRunAtom,
  hydrateSessionWorkflowRunsAtom,
  hydrateWorkflowDetailAtom,
  hydrateWorkflowsAtom,
  renameWorkflowAtom,
  remapSessionWorkflowResourcesAtom,
  workflowDetailsAtom,
  workflowRunsAtom,
  workflowsAtom,
} from '../workflows'
import { backendSnapshotAtom } from '../backend'
import { toastAtom } from '../toast'
import { resolveConfirmAtom } from '../confirm'
import {
  activeSessionIdAtom,
  hydrateSessionsFromDaemonAtom,
} from '../sessions'
import { BackendState } from '../../../main/python-client/types'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('session resource projections', () => {
  it('associates a Run optimistically with the root and remaps draft ids', async () => {
    const store = createStore()
    const run = {
      id: 'wfr_1',
      workflow_id: 'wf_1',
      workflow_name: '论文筛选',
      source_session_id: 'root',
      workflow_input: { text: '筛选论文', blocks: [] },
      status: 'completed',
      validation_status: 'passed',
      created_at: '2026-07-22T08:00:00Z',
      finished_at: '2026-07-22T08:01:00Z',
    }
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
    globalThis.fetch = mock(async (url: string) => {
      const request = new URL(url)
      const path = request.pathname
      if (path === '/sessions') return jsonResponse([
        { id: 'root', title: 'Root', parent_session_id: null },
        { id: 'child', title: 'Child', parent_session_id: 'root', subagent_mode: 'background' },
      ])
      if (path === '/workflows') {
        return jsonResponse([{ id: 'wf_1', name: '论文筛选', workflow_dir: '/wf/wf_1' }])
      }
      if (path === '/workflow-runs') {
        return jsonResponse(request.searchParams.has('session_id') ? [] : [run])
      }
      return jsonResponse({}, 404)
    }) as never

    await store.set(hydrateSessionsFromDaemonAtom)
    await store.set(hydrateWorkflowsAtom)
    store.set(associateSessionWorkflowsFromInputAtom, {
      sessionId: 'child',
      blocks: [{ type: 'mention', id: 'wfr_1', label: '论文筛选结果', group: 'WorkflowRun' }],
    })

    store.set(activeSessionIdAtom, 'root')
    expect(store.get(activeSessionWorkflowsAtom).map((item) => item.id)).toEqual(['wf_1'])
    expect(store.get(activeSessionWorkflowRunsAtom).map((item) => item.id)).toEqual(['wfr_1'])
    store.set(activeSessionIdAtom, 'child')
    expect(store.get(activeSessionWorkflowsAtom)).toEqual([])
    expect(store.get(activeSessionWorkflowRunsAtom)).toEqual([])

    store.set(associateSessionWorkflowsFromInputAtom, {
      sessionId: 'draft',
      blocks: [{ type: 'mention', id: 'wfr_1', label: '论文筛选结果', group: 'WorkflowRun' }],
    })
    store.set(remapSessionWorkflowResourcesAtom, {
      sourceSessionId: 'draft',
      targetSessionId: 'daemon',
    })
    store.set(activeSessionIdAtom, 'daemon')
    await store.set(hydrateSessionWorkflowRunsAtom, 'daemon')
    expect(store.get(activeSessionWorkflowRunsAtom).map((item) => item.id)).toEqual(['wfr_1'])
  })
})

describe('deleteWorkflowAtom', () => {
  it('removes the definition caches but retains historical Run results', async () => {
    const store = createStore()
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
    let deleted = false
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE' && url.endsWith('/workflows/wf_1')) {
        deleted = true
        return new Response(null, { status: 204 })
      }
      if (new URL(url).pathname === '/workflow-runs') {
        return jsonResponse([{
          id: 'wfr_1',
          workflow_id: 'wf_1',
          workflow_name: '论文筛选',
          source_session_id: 'session_1',
          workflow_input: { text: '筛选论文', blocks: [] },
          status: 'completed',
          validation_status: 'passed',
          created_at: '2026-07-22T08:00:00Z',
          finished_at: '2026-07-22T08:01:00Z',
        }])
      }
      if (url.endsWith('/workflows/wf_1')) {
        return jsonResponse({ id: 'wf_1', name: '论文筛选', fields: {} })
      }
      if (url.endsWith('/workflows')) {
        return jsonResponse([{ id: 'wf_1', name: '论文筛选', workflow_dir: '/wf/wf_1' }])
      }
      return jsonResponse({}, 404)
    }) as never

    await store.set(hydrateWorkflowsAtom)
    await store.set(hydrateWorkflowDetailAtom, { workflowId: 'wf_1' })
    expect(store.get(workflowsAtom)).toHaveLength(1)
    expect(store.get(workflowRunsAtom)).toHaveLength(1)
    expect(store.get(workflowDetailsAtom).wf_1).toBeDefined()

    expect(await store.set(deleteWorkflowAtom, { workflowId: 'wf_1', name: '论文筛选' })).toBe(true)

    expect(deleted).toBe(true)
    expect(store.get(workflowsAtom)).toHaveLength(0)
    expect(store.get(workflowDetailsAtom).wf_1).toBeUndefined()
    expect(store.get(workflowRunsAtom).map((run) => run.id)).toEqual(['wfr_1'])
  })

  it('keeps its caches when an active Run makes deletion conflict', async () => {
    const store = createStore()
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
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        return jsonResponse({ detail: '工作流仍有未结束的运行' }, 409)
      }
      if (url.endsWith('/workflows')) {
        return jsonResponse([{ id: 'wf_1', name: '论文筛选', workflow_dir: '/wf/wf_1' }])
      }
      if (new URL(url).pathname === '/workflow-runs') return jsonResponse([])
      return jsonResponse({}, 404)
    }) as never

    await store.set(hydrateWorkflowsAtom)
    const deleted = await store.set(
      deleteWorkflowAtom,
      { workflowId: 'wf_1', name: '论文筛选' },
    )

    expect(deleted).toBe(false)
    expect(store.get(workflowsAtom).map((workflow) => workflow.id)).toEqual(['wf_1'])
  })
})

describe('renameWorkflowAtom', () => {
  it('updates current definition projections and preserves historical Run names', async () => {
    const store = createStore()
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
    let patchBody: unknown
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname
      if (path === '/workflows/wf_1' && init?.method === 'PATCH') {
        patchBody = JSON.parse(String(init.body))
        return jsonResponse({
          id: 'wf_1',
          name: '论文精选',
          workflow_dir: '/wf/wf_1',
        })
      }
      if (path === '/workflows/wf_1') {
        return jsonResponse({ id: 'wf_1', name: '论文筛选', fields: {} })
      }
      if (path === '/workflows') {
        return jsonResponse([{ id: 'wf_1', name: '论文筛选', workflow_dir: '/wf/wf_1' }])
      }
      if (path === '/workflow-runs') {
        return jsonResponse([{
          id: 'wfr_1',
          workflow_id: 'wf_1',
          workflow_name: '论文筛选',
          source_session_id: 'session_1',
          workflow_input: { text: '筛选论文', blocks: [] },
          status: 'completed',
          validation_status: 'passed',
          created_at: '2026-07-22T08:00:00Z',
          finished_at: '2026-07-22T08:01:00Z',
        }])
      }
      return jsonResponse({}, 404)
    }) as never

    await store.set(hydrateWorkflowsAtom)
    await store.set(hydrateWorkflowDetailAtom, { workflowId: 'wf_1' })
    store.set(activeSessionIdAtom, 'session_1')
    store.set(associateSessionWorkflowsFromInputAtom, {
      sessionId: 'session_1',
      blocks: [{ type: 'slash', id: 'wf_1', label: '论文筛选', resource: 'workflow' }],
    })

    const renamed = await store.set(renameWorkflowAtom, {
      workflowId: 'wf_1',
      name: '  论文精选  ',
    })

    expect(renamed).toBe(true)
    expect(patchBody).toEqual({ name: '论文精选' })
    expect(store.get(workflowsAtom)[0]?.name).toBe('论文精选')
    expect(store.get(activeSessionWorkflowsAtom)[0]?.name).toBe('论文精选')
    expect(store.get(workflowDetailsAtom).wf_1?.name).toBe('论文精选')
    expect(store.get(workflowRunsAtom)[0]?.workflow_name).toBe('论文筛选')
  })
})

describe('deleteWorkflowRunAtom', () => {
  it('confirms deletion and removes the Run from the asset cache', async () => {
    const store = createStore()
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
    const run = {
      id: 'wfr_1',
      workflow_id: 'wf_1',
      workflow_name: '论文筛选',
      source_session_id: 'session_1',
      workflow_input: { text: '筛选论文', blocks: [] },
      status: 'completed' as const,
      validation_status: 'passed' as const,
      created_at: '2026-07-22T08:00:00Z',
      finished_at: '2026-07-22T08:01:00Z',
    }
    let deleted = false
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE' && url.endsWith('/workflow-runs/wfr_1')) {
        deleted = true
        return new Response(null, { status: 204 })
      }
      if (url.endsWith('/workflows')) return jsonResponse([])
      if (new URL(url).pathname === '/workflow-runs') return jsonResponse([run])
      return jsonResponse({}, 404)
    }) as never

    await store.set(hydrateWorkflowsAtom)
    const deleting = store.set(deleteWorkflowRunAtom, run)
    store.set(resolveConfirmAtom, true)

    expect(await deleting).toBe(true)
    expect(deleted).toBe(true)
    expect(store.get(workflowRunsAtom)).toHaveLength(0)
  })
})

describe('run-index pagination', () => {
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
      },
      lastError: null,
    } as never)
    return store
  }

  function runAt(index: number, sourceSessionId = 'session_1') {
    return {
      id: `wfr_${index}`,
      workflow_id: 'wf_1',
      workflow_name: '论文筛选',
      source_session_id: sourceSessionId,
      workflow_input: { text: `第 ${index} 次`, blocks: [] },
      status: 'completed',
      validation_status: 'passed',
      created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
      finished_at: null,
    }
  }

  /** Serve `total` runs in `limit`-sized pages off the request's own params. */
  function pagedFetch(total: number, urls: string[]) {
    return mock(async (url: string) => {
      if (url.endsWith('/workflows')) return jsonResponse([])
      const parsed = new URL(url)
      if (parsed.pathname !== '/workflow-runs') return jsonResponse({}, 404)
      urls.push(url)
      // Mirrors the daemon: limit defaults to 100 and is clamped to 200.
      const limit = Math.min(Number(parsed.searchParams.get('limit') ?? 100), 200)
      const offset = Number(parsed.searchParams.get('offset') ?? 0)
      const sourceSessionId = parsed.searchParams.get('source_session_id') ?? 'session_1'
      const rows = Array.from({ length: total }, (_, index) => runAt(index, sourceSessionId))
      return jsonResponse(rows.slice(offset, offset + limit))
    }) as never
  }

  it('hydrateWorkflowsAtom loads every Run, not just the daemon default page', async () => {
    const store = readyStore()
    const urls: string[] = []
    globalThis.fetch = pagedFetch(437, urls)

    await store.set(hydrateWorkflowsAtom)

    expect(store.get(workflowRunsAtom)).toHaveLength(437)
    expect(urls).toHaveLength(3)
  })

  it('hydrateSessionWorkflowRunsAtom pages through one Session past the first page', async () => {
    const store = readyStore()
    const urls: string[] = []
    globalThis.fetch = pagedFetch(437, urls)

    const runs = await store.set(hydrateSessionWorkflowRunsAtom, 'session_1')

    expect(runs).toHaveLength(437)
    expect(store.get(activeSessionWorkflowRunsAtom)).toHaveLength(0) // Inactive session.
    expect(urls.every((url) => url.includes('session_id=session_1'))).toBe(true)
  })
})

describe('workflow failure toasts', () => {
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
      },
      lastError: null,
    } as never)
    return store
  }

  // These messages all use the template "... failed: {{msg}}", so callers must fill the placeholder.
  // The previous `err instanceof Error ? err.message : t(key)` ternary broke both branches:
  // Error values lost the localized wrapper, while non-Error values leaked {{msg}} into the toast.
  it('frames an Error reason with the localized prefix instead of showing it bare', async () => {
    const store = readyStore()
    globalThis.fetch = mock(async () => {
      throw new Error('ENOENT: no such file or directory')
    }) as never

    expect(await store.set(deleteWorkflowAtom, { workflowId: 'wf_1', name: '论文筛选' })).toBe(false)

    expect(store.get(toastAtom)?.message).toBe('删除工作流失败：ENOENT: no such file or directory')
  })

  it('never leaks the {{msg}} placeholder when the thrown value is not an Error', async () => {
    const store = readyStore()
    globalThis.fetch = mock(async () => {
      throw 'socket hang up' // fetch layers and some polyfills can throw non-Error values.
    }) as never

    expect(await store.set(renameWorkflowAtom, { workflowId: 'wf_1', name: '新名字' })).toBe(false)

    const message = store.get(toastAtom)?.message ?? ''
    expect(message).not.toContain('{{msg}}')
    expect(message).toBe('重命名工作流失败：socket hang up')
  })
})
