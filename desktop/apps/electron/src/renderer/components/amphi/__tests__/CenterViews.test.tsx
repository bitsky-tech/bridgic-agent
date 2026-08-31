import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createStore, Provider } from 'jotai'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Simulate } = await import('react-dom/test-utils')
const { activeModalAtom, ComposerTarget, ModalKind } = await import('@/atoms/amphi')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const {
  DRAFT_SESSION_ID,
  activeSessionIdAtom,
  pendingComposerSeedAtom,
} = await import('@/atoms/sessions')
const { BackendState } = await import('../../../../main/python-client/types')
const { CenterAssets, CenterWorkflows, filterWorkflows } = await import('../CenterViews')

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

describe('CenterWorkflows', () => {
  it('exposes delete without opening the detail card', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onPick = mock(() => {})
    const onDelete = mock(() => {})

    await act(async () => {
      root.render(
        <CenterWorkflows
          workflows={[{ id: 'wf_1', name: '论文筛选' }]}
          onPickWorkflow={onPick}
          onDeleteWorkflow={onDelete}
        />,
      )
    })
    await act(async () => host.querySelector<HTMLElement>('[data-testid="workflow-delete-wf_1"]')?.click())

    expect(onDelete).toHaveBeenCalledWith({ id: 'wf_1', name: '论文筛选' })
    expect(onPick).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    host.remove()
  })

  it('renames inline without opening the detail card', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onPick = mock(() => {})
    const onRename = mock(async () => true)
    const workflow = { id: 'wf_1', name: '论文筛选' }

    await act(async () => {
      root.render(
        <CenterWorkflows
          workflows={[workflow]}
          onPickWorkflow={onPick}
          onRenameWorkflow={onRename}
        />,
      )
    })
    await act(async () => host.querySelector<HTMLElement>('[data-testid="workflow-rename-wf_1"]')?.click())
    const input = host.querySelector<HTMLInputElement>('[data-testid="workflow-rename-input-wf_1"]')
    expect(input).not.toBeNull()
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      setValue?.call(input, '  论文精选  ')
      Simulate.change(input!)
    })
    await act(async () => host.querySelector<HTMLElement>('[data-testid="workflow-rename-save-wf_1"]')?.click())

    expect(onRename).toHaveBeenCalledWith(workflow, '论文精选')
    expect(onPick).not.toHaveBeenCalled()
    await act(async () => root.unmount())
    host.remove()
  })

  it('exposes a distinct new-conversation run action without opening details', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const onPick = mock(() => {})
    const onRun = mock(() => {})

    await act(async () => {
      root.render(
        <CenterWorkflows
          workflows={[{ id: 'wf_1', name: '论文筛选' }]}
          onPickWorkflow={onPick}
          onRunWorkflow={onRun}
        />,
      )
    })
    await act(async () => host.querySelector<HTMLElement>('[data-testid="workflow-run-wf_1"]')?.click())

    expect(onRun).toHaveBeenCalledWith({ id: 'wf_1', name: '论文筛选' })
    expect(onPick).not.toHaveBeenCalled()
    expect(host.textContent).toContain('新会话运行')

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders a real search box and filters by name or description', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <CenterWorkflows
          workflows={[
            { id: 'wf_1', name: '论文筛选', desc: '按主题相关性排序' },
            { id: 'wf_2', name: '发票归档', desc: '导出台账' },
          ]}
        />,
      )
    })
    // 回归点:这里曾是个纯装饰的 <span>,敲字毫无反应。
    const search = host.querySelector<HTMLInputElement>('input[placeholder="搜索工作流..."]')
    expect(search).not.toBeNull()
    expect(search!.value).toBe('')

    await act(async () => root.unmount())
    host.remove()
  })
})

describe('filterWorkflows', () => {
  const rows = [
    { id: 'wf_1', name: '论文筛选', desc: '按主题相关性排序' },
    { id: 'wf_2', name: '发票归档', desc: '导出台账' },
    { id: 'wf_3', name: 'Weekly Report' },
  ]

  it('filters names and descriptions with normalized query text', () => {
    expect(filterWorkflows(rows, '   ').map((r) => r.id)).toEqual(['wf_1', 'wf_2', 'wf_3'])
    expect(filterWorkflows(rows, '发票').map((r) => r.id)).toEqual(['wf_2'])
    expect(filterWorkflows(rows, '主题相关性').map((r) => r.id)).toEqual(['wf_1'])
    expect(filterWorkflows(rows, '  WEEKLY ').map((r) => r.id)).toEqual(['wf_3'])
    expect(filterWorkflows(rows, '不存在的关键词')).toEqual([])
  })
})

describe('CenterAssets', () => {
  it('renders real Session mounts and grouped Workflow Runs, then opens a result', async () => {
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
    globalThis.fetch = mock(async (url: string) => {
      if (new URL(url).pathname === '/mounts') {
        return jsonResponse([{
          id: 'mnt_1',
          session_id: 'session_1',
          session_title: 'Agent 上下文压缩论文',
          name: 'paper.pdf',
          path: '/tmp/paper.pdf',
          kind: 'file',
          size_bytes: 1024,
          item_count: null,
          exists: true,
          created_at: '2026-07-22T08:00:00Z',
        }, {
          // Folder mounts always arrive with item_count null — the daemon
          // refuses to read the directory (macOS TCC). The size cell must
          // stay empty rather than print a fabricated "0 项".
          id: 'mnt_2',
          session_id: 'session_1',
          session_title: 'Agent 上下文压缩论文',
          name: 'Downloads',
          path: '/tmp/Downloads',
          kind: 'folder',
          size_bytes: null,
          item_count: null,
          exists: true,
          created_at: '2026-07-22T08:00:00Z',
        }])
      }
      if (new URL(url).pathname === '/workflow-runs') {
        return jsonResponse([
          {
            id: 'wfr_1',
            workflow_id: 'wf_1',
            workflow_name: '论文发现与主题相关性筛选',
            source_session_id: 'session_1',
            workflow_input: {
              text: '/论文发现与主题相关性筛选 筛选上下文压缩论文',
              blocks: [
                { type: 'slash', id: 'wf_1', label: '论文发现与主题相关性筛选', resource: 'workflow' },
                { type: 'text', value: ' 筛选上下文压缩论文' },
              ],
            },
            status: 'completed',
            validation_status: 'passed',
            created_at: '2026-07-22T08:00:00Z',
            finished_at: '2026-07-22T08:01:00Z',
          },
          {
            id: 'wfr_old_definition',
            workflow_id: 'wf_deleted_then_recreated',
            workflow_name: '论文发现与主题相关性筛选',
            source_session_id: 'session_1',
            workflow_input: { text: '旧定义的运行', blocks: [] },
            status: 'completed',
            validation_status: 'passed',
            created_at: '2026-07-21T08:00:00Z',
            finished_at: '2026-07-21T08:01:00Z',
          },
          {
            id: 'wfr_failed',
            workflow_id: 'wf_1',
            workflow_name: '论文发现与主题相关性筛选',
            source_session_id: 'session_1',
            workflow_input: { text: '失败的筛选运行', blocks: [] },
            status: 'failed',
            validation_status: 'failed',
            created_at: '2026-07-23T08:00:00Z',
            finished_at: '2026-07-23T08:01:00Z',
          },
        ])
      }
      return jsonResponse({})
    }) as never
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(<Provider store={store}><CenterAssets /></Provider>)
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(host.textContent).toContain('paper.pdf')
    expect(host.textContent).toContain('Downloads')
    expect(host.textContent).not.toContain('0 项')
    expect(host.textContent).toContain('—') // folder size cell = placeholder
    expect(host.textContent).toContain('Agent 上下文压缩论文')
    expect(host.textContent).toContain('论文发现与主题相关性筛选')
    expect(host.textContent).toContain('3 次运行')
    expect(host.textContent).not.toContain('用户画像.xlsx')

    const workflowButton = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('论文发现与主题相关性筛选'))
    await act(async () => workflowButton?.click())
    const runButton = Array.from(host.querySelectorAll('button'))
      .find((button) => button.textContent?.includes('筛选上下文压缩论文'))
    expect(runButton?.querySelector('[data-input-token="slash"]')?.textContent)
      .toBe('/论文发现与主题相关性筛选')
    await act(async () => runButton?.click())

    expect(store.get(activeModalAtom)).toEqual({
      type: ModalKind.WorkflowRunDetail,
      runId: 'wfr_1',
      composerTarget: ComposerTarget.NewSession,
    })

    const useFailedResult = host.querySelector<HTMLButtonElement>(
      'button[aria-label="在新会话中使用结果 wfr_failed"]',
    )
    await act(async () => useFailedResult?.click())
    expect(store.get(activeSessionIdAtom)).toBe(DRAFT_SESSION_ID)
    expect(store.get(pendingComposerSeedAtom)?.segments[0]).toMatchObject({
      type: 'mention',
      id: 'wfr_failed',
      group: 'WorkflowRun',
    })
    await act(async () => root.unmount())
    host.remove()
  })
})
