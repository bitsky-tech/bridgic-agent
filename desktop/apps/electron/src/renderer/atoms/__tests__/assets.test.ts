import { describe, expect, it, mock } from 'bun:test'
import { createStore } from 'jotai'

import {
  assetsHydrationErrorAtom,
  assetsHydrationStateAtom,
  hydrateAssetsAtom,
  sessionFileAssetsAtom,
} from '../assets'
import { hydrateWorkflowsAtom, workflowRunsAtom } from '../workflows'
import { backendSnapshotAtom } from '../backend'
import { BackendState } from '../../../main/python-client/types'

function workflowRun(index: number) {
  return {
    id: `wfr_${index}`,
    workflow_id: `wf_${index % 3}`,
    workflow_name: `工作流 ${index % 3}`,
    source_session_id: 'session_1',
    workflow_input: { text: `运行 ${index}`, blocks: [] },
    status: 'completed',
    validation_status: 'passed',
    created_at: new Date(Date.UTC(2026, 6, 22, 8, 0, index)).toISOString(),
    finished_at: new Date(Date.UTC(2026, 6, 22, 8, 1, index)).toISOString(),
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function withDaemon(store: ReturnType<typeof createStore>, fetchImpl: typeof fetch): void {
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
  globalThis.fetch = fetchImpl as never
}

describe('hydrateAssetsAtom', () => {
  it('hydrates Session files and Workflow Runs as one page snapshot', async () => {
    const store = createStore()
    withDaemon(store, mock(async (url: string) => {
      if (new URL(url).pathname === '/mounts') {
        return jsonResponse([{
          id: 'mnt_1',
          session_id: 'session_1',
          session_title: '论文分析',
          name: 'paper.pdf',
          path: '/tmp/paper.pdf',
          kind: 'file',
          size_bytes: 42,
          item_count: null,
          exists: true,
          created_at: '2026-07-22T08:00:00Z',
        }])
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
      return jsonResponse({}, 404)
    }) as never)

    await store.set(hydrateAssetsAtom)

    expect(store.get(assetsHydrationStateAtom)).toBe('ready')
    expect(store.get(assetsHydrationErrorAtom)).toBeNull()
    expect(store.get(sessionFileAssetsAtom)[0]?.session_title).toBe('论文分析')
    expect(store.get(workflowRunsAtom)[0]?.workflow_name).toBe('论文筛选')
  })

  it('reports an error when the asset snapshot cannot be loaded', async () => {
    const store = createStore()
    withDaemon(store, mock(async () => jsonResponse({ detail: 'boom' }, 500)) as never)

    await store.set(hydrateAssetsAtom)

    expect(store.get(assetsHydrationStateAtom)).toBe('error')
    expect(store.get(assetsHydrationErrorAtom)).toContain('boom')
  })

  it('keeps a successful category and loads the complete Run index in pages', async () => {
    const store = createStore()
    const runs = Array.from({ length: 201 }, (_, index) => workflowRun(index))
    const offsets: number[] = []
    withDaemon(store, mock(async (url: string) => {
      const parsed = new URL(url)
      if (parsed.pathname === '/mounts') {
        return jsonResponse({ detail: 'mount service unavailable' }, 503)
      }
      if (parsed.pathname === '/workflow-runs') {
        const offset = Number(parsed.searchParams.get('offset') ?? 0)
        const limit = Number(parsed.searchParams.get('limit') ?? 100)
        offsets.push(offset)
        return jsonResponse(runs.slice(offset, offset + limit))
      }
      return jsonResponse({}, 404)
    }) as never)

    await store.set(hydrateAssetsAtom)

    expect(store.get(assetsHydrationStateAtom)).toBe('error')
    expect(store.get(assetsHydrationErrorAtom)).toContain('用户文件')
    expect(store.get(workflowRunsAtom)).toHaveLength(201)
    expect(offsets).toEqual([0, 200])

    await store.set(hydrateWorkflowsAtom)
    expect(store.get(workflowRunsAtom)).toHaveLength(201)
  })
})
