import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { WorkflowRunDetail } from '@/lib/amphiClient'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { ComposerTarget } = await import('@/atoms/amphi')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const {
  DRAFT_SESSION_ID,
  activeSessionIdAtom,
  pendingComposerInsertsAtom,
  pendingComposerSeedAtom,
} = await import('@/atoms/sessions')
const { BackendState } = await import('../../../../main/python-client/types')
const { installApiStub } = await import('@/lib/apiStub')
const { WorkflowRunDetailModal } = await import('../WorkflowRunDetailModal')

installApiStub()

const deletedWorkflowRun: WorkflowRunDetail = {
  id: 'wfr-deleted-source',
  workflow_id: 'wf-deleted',
  workflow_name: '已删除源工作流',
  source_session_id: 'session-source',
  workflow_input: { text: '/已删除源工作流 生成报告', blocks: [] },
  status: 'completed',
  validation_status: 'passed',
  created_at: '2026-07-21T15:27:00Z',
  finished_at: '2026-07-21T15:28:00Z',
  run_dir: '/runs/wf-deleted/wfr-deleted-source',
  files: [
    { path: 'result/report.md', name: 'report.md', size: 10 },
    { path: 'result/failure.md', name: 'failure.md', size: 22 },
  ],
}

let originalFetch: typeof fetch

beforeEach(() => {
  originalFetch = globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function connectStore(fetchImpl: typeof fetch) {
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
  globalThis.fetch = fetchImpl
  return store
}

async function settleEffects(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.resolve()
  })
}

describe('WorkflowRunDetailModal', () => {
  it('previews a durable Run after its source Workflow was deleted', async () => {
    const requested: string[] = []
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      requested.push(url)
      const parsed = new URL(url)
      if (parsed.pathname === `/workflow-runs/${deletedWorkflowRun.id}`) {
        return jsonResponse(deletedWorkflowRun)
      }
      if (parsed.pathname === `/workflow-runs/${deletedWorkflowRun.id}/file`) {
        return jsonResponse({
          path: 'result/failure.md',
          name: 'failure.md',
          size: 22,
          content: '# 失败原因\n\n三次修复后仍未通过。',
          truncated: false,
        })
      }
      return jsonResponse({ detail: 'not found' }, 404)
    }) as unknown as typeof fetch
    const store = connectStore(fetchMock)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunDetailModal
            runId={deletedWorkflowRun.id}
            initialFilePath="result/failure.md"
          />
        </Provider>,
      )
    })
    await settleEffects()
    await settleEffects()

    expect(document.body.textContent).toContain('已删除源工作流')
    expect(document.body.textContent).toContain('三次修复后仍未通过')
    expect(document.querySelector('[data-input-token="slash"]')?.textContent).toBe('/已删除源工作流')
    expect(requested.some((url) => new URL(url).pathname === `/workflows/${deletedWorkflowRun.workflow_id}`)).toBe(false)
    expect(requested.some((url) => url.includes('path=result%2Ffailure.md'))).toBe(true)
    expect(document.body.textContent).toContain('执行完毕')
    expect(document.body.textContent).toContain('使用结果')
    expect(document.body.textContent).not.toContain('再次运行')

    await act(async () => root.unmount())
  })

  it('groups intermediate work files after final results and previews both', async () => {
    const run: WorkflowRunDetail = {
      ...deletedWorkflowRun,
      id: 'wfr-with-work-files',
      files: [
        {
          path: 'background/work/message_idempotency_key.txt',
          name: 'message_idempotency_key.txt',
          size: 14,
        },
        { path: 'result/report.md', name: 'report.md', size: 10 },
      ],
    }
    const requestedFiles: string[] = []
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const parsed = new URL(typeof input === 'string' ? input : input.toString())
      if (parsed.pathname === `/workflow-runs/${run.id}`) return jsonResponse(run)
      if (parsed.pathname === `/workflow-runs/${run.id}/file`) {
        const path = parsed.searchParams.get('path') ?? ''
        requestedFiles.push(path)
        return jsonResponse({
          path,
          name: path.split('/').at(-1),
          size: 14,
          content: path.startsWith('result/') ? '# Report\n' : 'retry-safe-key\n',
          truncated: false,
        })
      }
      return jsonResponse({ detail: 'not found' }, 404)
    }) as unknown as typeof fetch
    const store = connectStore(fetchMock)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunDetailModal runId={run.id} />
        </Provider>,
      )
    })
    await settleEffects()
    await settleEffects()

    expect(document.body.textContent).toContain('结果文件 · 1')
    expect(document.body.textContent).toContain('中间文件 · 1')
    expect(document.body.textContent).toContain('Report')
    expect(requestedFiles[0]).toBe('result/report.md')

    const workFile = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('message_idempotency_key.txt'))
    await act(async () => workFile?.click())
    await settleEffects()

    expect(requestedFiles).toContain('background/work/message_idempotency_key.txt')
    expect(document.body.textContent).toContain('retry-safe-key')

    await act(async () => root.unmount())
  })

  it('inserts a Workflow Run reference for continuing the conversation', async () => {
    const run = { ...deletedWorkflowRun, id: 'wfr-live-source', workflow_id: 'wf-live', workflow_name: '可用工作流', files: [] }
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      const pathname = new URL(url).pathname
      if (pathname === `/workflow-runs/${run.id}`) return jsonResponse(run)
      return jsonResponse({ detail: 'not found' }, 404)
    }) as unknown as typeof fetch
    const store = connectStore(fetchMock)
    store.set(activeSessionIdAtom, 'session-current')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunDetailModal runId={run.id} />
        </Provider>,
      )
    })
    await settleEffects()
    await settleEffects()

    const continueButton = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('使用结果'))
    await act(async () => continueButton?.click())

    expect(store.get(activeSessionIdAtom)).toBe('session-current')
    expect(store.get(pendingComposerInsertsAtom)).toHaveLength(1)
    expect(store.get(pendingComposerInsertsAtom)[0]?.[0]).toMatchObject({
      type: 'mention',
      id: run.id,
      group: 'WorkflowRun',
    })
    expect(store.get(pendingComposerInsertsAtom)[0]?.[0]).toMatchObject({
      label: expect.stringContaining('可用工作流 · '),
    })

    await act(async () => root.unmount())
  })

  it('opens a guided new conversation when used from the Assets center', async () => {
    const run = { ...deletedWorkflowRun, id: 'wfr-new-session', files: [] }
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const pathname = new URL(typeof input === 'string' ? input : input.toString()).pathname
      if (pathname === `/workflow-runs/${run.id}`) return jsonResponse(run)
      return jsonResponse({ detail: 'not found' }, 404)
    }) as unknown as typeof fetch
    const store = connectStore(fetchMock)
    store.set(activeSessionIdAtom, 'session-current')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunDetailModal
            runId={run.id}
            composerTarget={ComposerTarget.NewSession}
          />
        </Provider>,
      )
    })
    await settleEffects()
    await settleEffects()

    const useResult = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('在新会话中使用'))
    await act(async () => useResult?.click())

    expect(store.get(activeSessionIdAtom)).toBe(DRAFT_SESSION_ID)
    expect(store.get(pendingComposerSeedAtom)?.segments[0]).toMatchObject({
      type: 'mention',
      id: run.id,
      group: 'WorkflowRun',
    })

    await act(async () => root.unmount())
  })

  it('exports every run result through the native ZIP save flow', async () => {
    const run: WorkflowRunDetail = {
      ...deletedWorkflowRun,
      id: 'wfr-export',
      files: [{ path: 'result/archive.bin', name: 'archive.bin', size: 4 }],
    }
    const originalSave = window.api.dialog.save
    const originalWriteArchive = window.api.fs.writeWorkflowRunArchive
    const save = mock(async () => ({ canceled: false, filePath: '/exports/run-result' }))
    const writeArchive = mock(async (_path: string, _content: Uint8Array) => {})
    window.api.dialog.save = save
    window.api.fs.writeWorkflowRunArchive = writeArchive
    const requested: string[] = []
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      requested.push(url)
      const parsed = new URL(url)
      if (parsed.pathname === `/workflow-runs/${run.id}` && !parsed.searchParams.has('archive')) {
        return jsonResponse(run)
      }
      if (parsed.pathname === `/workflow-runs/${run.id}` && parsed.searchParams.get('archive') === 'true') {
        return new Response(new Uint8Array([80, 75, 3, 4]), {
          headers: { 'content-type': 'application/zip' },
        })
      }
      return jsonResponse({ detail: 'not found' }, 404)
    }) as unknown as typeof fetch
    const store = connectStore(fetchMock)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <WorkflowRunDetailModal runId={run.id} />
          </Provider>,
        )
      })
      await settleEffects()
      await settleEffects()

      const exportResult = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('导出执行结果'))
      await act(async () => exportResult?.click())
      await settleEffects()

      expect(save).toHaveBeenCalledWith({
        title: '导出执行结果',
        defaultPath: '已删除源工作流-wfr-expo.zip',
        filters: [{ name: 'ZIP', extensions: ['zip'] }],
      })
      expect(requested.some((url) => url.endsWith(`/workflow-runs/${run.id}?archive=true`))).toBe(true)
      expect(writeArchive).toHaveBeenCalledWith(
        '/exports/run-result.zip',
        new Uint8Array([80, 75, 3, 4]),
      )
    } finally {
      await act(async () => root.unmount())
      window.api.dialog.save = originalSave
      window.api.fs.writeWorkflowRunArchive = originalWriteArchive
    }
  })

  it('labels truncated text previews and offers to open the source file', async () => {
    const run: WorkflowRunDetail = {
      ...deletedWorkflowRun,
      id: 'wfr-truncated',
      workflow_id: 'wf-live',
      files: [{ path: 'result/large.txt', name: 'large.txt', size: 400_000 }],
    }
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const parsed = new URL(typeof input === 'string' ? input : input.toString())
      if (parsed.pathname === `/workflow-runs/${run.id}`) return jsonResponse(run)
      if (parsed.pathname === `/workflows/${run.workflow_id}`) {
        return jsonResponse({ id: run.workflow_id, name: run.workflow_name, fields: {} })
      }
      if (parsed.pathname === `/workflow-runs/${run.id}/file`) {
        return jsonResponse({
          ...run.files[0],
          content: 'partial content',
          truncated: true,
        })
      }
      return jsonResponse({ detail: 'not found' }, 404)
    }) as unknown as typeof fetch
    const store = connectStore(fetchMock)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunDetailModal runId={run.id} />
        </Provider>,
      )
    })
    await settleEffects()
    await settleEffects()

    expect(document.body.textContent).toContain(
      '文件较大，当前仅预览前 200,000 个字符；请打开源文件查看完整内容。',
    )
    expect(document.body.textContent).toContain('partial content')
    expect(document.body.textContent).toContain('打开源文件')
    const previewScroll = document.querySelector('[data-testid="workflow-run-file-preview-scroll"]')
    const truncatedFooter = document.querySelector('[data-testid="workflow-run-truncated-footer"]')
    expect(truncatedFooter?.textContent).toContain(
      '预览到此结束，后续内容未显示；请打开源文件查看完整内容。',
    )
    expect(previewScroll?.lastElementChild).toBe(truncatedFooter)

    await act(async () => root.unmount())
  })

  it('previews image results from the raw endpoint and opens the local source file', async () => {
    const run: WorkflowRunDetail = {
      ...deletedWorkflowRun,
      id: 'wfr-image',
      workflow_id: 'wf-live',
      files: [{ path: 'result/chart.png', name: 'chart.png', size: 4 }],
    }
    const originalCreateObjectURL = URL.createObjectURL
    const originalRevokeObjectURL = URL.revokeObjectURL
    const originalOpenPath = window.api.shell.openPath
    const objectUrls = ['blob:preview']
    const createObjectURL = mock(() => objectUrls.shift() ?? 'blob:extra')
    const revokeObjectURL = mock(() => undefined)
    const openPath = mock(async (_path: string) => {})
    URL.createObjectURL = createObjectURL
    URL.revokeObjectURL = revokeObjectURL
    window.api.shell.openPath = openPath
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const parsed = new URL(typeof input === 'string' ? input : input.toString())
      if (parsed.pathname === `/workflow-runs/${run.id}`) return jsonResponse(run)
      if (parsed.pathname === `/workflows/${run.workflow_id}`) {
        return jsonResponse({ id: run.workflow_id, name: run.workflow_name, fields: {} })
      }
      if (parsed.pathname === `/workflow-runs/${run.id}/file` && parsed.searchParams.get('raw') === 'true') {
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { 'content-type': 'image/png' },
        })
      }
      return jsonResponse({ detail: 'not found' }, 404)
    }) as unknown as typeof fetch
    const store = connectStore(fetchMock)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <WorkflowRunDetailModal runId={run.id} />
          </Provider>,
        )
      })
      await settleEffects()
      await settleEffects()

      const preview = document.querySelector<HTMLImageElement>('img[alt="chart.png"]')
      expect(preview?.src).toBe('blob:preview')
      const openSource = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('打开源文件'))
      await act(async () => openSource?.click())

      expect(openPath).toHaveBeenCalledWith('/runs/wf-deleted/wfr-deleted-source/result/chart.png')
      expect(createObjectURL).toHaveBeenCalledTimes(1)
      await act(async () => root.unmount())
      expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview')
    } finally {
      URL.createObjectURL = originalCreateObjectURL
      URL.revokeObjectURL = originalRevokeObjectURL
      window.api.shell.openPath = originalOpenPath
    }
  })

  it('shows a visible error when the source file cannot be opened', async () => {
    const run: WorkflowRunDetail = {
      ...deletedWorkflowRun,
      id: 'wfr-open-failed',
      files: [{ path: 'result/archive.bin', name: 'archive.bin', size: 4 }],
    }
    const originalOpenPath = window.api.shell.openPath
    window.api.shell.openPath = mock(async () => {
      throw new Error('Failed to open local path')
    })
    const fetchMock = mock(async (input: RequestInfo | URL) => {
      const pathname = new URL(typeof input === 'string' ? input : input.toString()).pathname
      if (pathname === `/workflow-runs/${run.id}`) return jsonResponse(run)
      return jsonResponse({ detail: 'not found' }, 404)
    }) as unknown as typeof fetch
    const store = connectStore(fetchMock)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <WorkflowRunDetailModal runId={run.id} />
          </Provider>,
        )
      })
      await settleEffects()
      await settleEffects()

      const openSource = Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
        .find((button) => button.textContent?.includes('打开源文件'))
      await act(async () => openSource?.click())

      expect(document.body.textContent).toContain('打开源文件失败：Failed to open local path')
    } finally {
      await act(async () => root.unmount())
      window.api.shell.openPath = originalOpenPath
    }
  })
})
