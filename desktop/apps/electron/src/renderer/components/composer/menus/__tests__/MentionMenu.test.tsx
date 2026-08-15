import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { Provider, createStore } from 'jotai'
import { backendSnapshotAtom } from '@/atoms/backend'
import { hydrateWorkflowsAtom } from '@/atoms/workflows'
import type { WorkflowRunSummary, WorkflowSummary } from '@/lib/amphiClient'
import { BackendState } from '../../../../../main/python-client/types'
import type { MentionMenuState } from '../useMentionMenuState'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { MentionMenu } = await import('../MentionMenu')
const { useMentionMenuState } = await import('../useMentionMenuState')

const run: WorkflowRunSummary = {
  id: 'wfr_report_1',
  workflow_id: 'wf_report',
  workflow_name: '目录统计',
  source_session_id: 'session_1',
  workflow_input: { text: '/目录统计 统计桌面 paper 文件夹', blocks: [] },
  status: 'completed',
  validation_status: 'passed',
  created_at: '2026-07-20T10:11:12',
  finished_at: '2026-07-20T10:12:00',
}

const workflow: WorkflowSummary = {
  id: 'wf_report',
  name: '目录统计',
  workflow_dir: '/workflows/wf_report',
  desc: '统计指定目录的文件。',
}

describe('MentionMenu', () => {
  it('groups references and exposes a readable Workflow Run preview', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const setScope = mock(() => {})
    const pick = mock(() => {})
    const previewRun = mock(() => {})
    const previewWorkflow = mock(() => {})
    const resultScopeLink = { kind: 'scope-link' as const, scope: 'workflow-runs' as const, total: 4 }
    const state: MentionMenuState = {
      mode: 'browse',
      scope: 'all',
      setScope,
      rows: [
        {
          kind: 'tree',
          key: 'mount_1:',
          mountId: 'mount_1',
          nodeKind: 'folder',
          name: 'paper',
          relPath: '',
          depth: 0,
          expandable: true,
          expanded: false,
          loadingChildren: false,
          sizeBytes: null,
          unreadable: false,
        },
        { kind: 'workflow', workflow },
        { kind: 'workflow-run', run },
        resultScopeLink,
        {
          kind: 'schedule',
          schedule: {
            id: 'sched_report',
            name: '每日汇总',
            desc: '每天汇总目录变化',
          } as never,
        },
      ],
      toggleExpand: () => {},
      showMore: () => {},
      workflowRunTotal: 4,
      workflowTotal: 1,
      scheduleTotal: 1,
      sessionFileTotal: 1,
      searchPartial: false,
      loading: false,
      empty: false,
    }

    await act(async () => {
      root.render(
        <MentionMenu
          state={state}
          filter=""
          selectedIndex={0}
          style={{ position: 'fixed', left: 0, top: 0 }}
          onToggleExpand={() => {}}
          onPick={pick}
          onPreviewWorkflowRun={previewRun}
          onPreviewWorkflow={previewWorkflow}
        />,
      )
    })

    expect(host.textContent).toContain('引用内容')
    expect(host.textContent).toContain('会话文件')
    expect(host.textContent).toContain('运行结果')
    expect(host.textContent).toContain('工作流')
    expect(host.textContent).toContain('目录统计')
    expect(host.textContent).toContain('可编辑')
    expect(host.textContent).toContain('查看全部 4 个运行结果')
    expect(host.textContent).toContain('2026-07-20 10:11:12')
    expect(host.textContent).toContain('统计桌面 paper 文件夹')
    expect(host.textContent).not.toContain('/目录统计')
    expect(host.textContent).toContain('执行完毕')
    expect(host.textContent).toContain('每日汇总')
    const workflowIcon = host.querySelector('[data-resource-kind="workflow"] svg')
    const workflowRunIcon = host.querySelector('[data-resource-kind="workflow-run"] svg')
    expect(workflowIcon?.innerHTML).not.toBe(workflowRunIcon?.innerHTML)
    expect(workflowRunIcon?.parentElement?.classList.contains('text-entity-workflow-run')).toBe(true)

    const labels = Array.from(host.querySelectorAll('[data-mention-section]'))
      .map((element) => element.textContent)
    expect(labels).toEqual(['会话文件', '工作流', '运行结果', '调度'])

    const workflowScope = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes('运行结果'))
    await act(async () => workflowScope?.click())
    expect(setScope).toHaveBeenCalledWith('workflow-runs')
    const scheduleScope = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      .find((button) => button.textContent?.includes('调度'))
    expect(host.querySelectorAll('[role="tab"]')).toHaveLength(5)
    await act(async () => scheduleScope?.click())
    expect(setScope).toHaveBeenCalledWith('schedules')

    const allResults = host.querySelector<HTMLElement>('[data-resource-kind="workflow-run-scope-link"]')
    await act(async () => allResults?.click())
    expect(pick).toHaveBeenCalledWith(resultScopeLink)

    const preview = host.querySelector<HTMLButtonElement>('button[aria-label="预览 目录统计 的本次运行"]')
    await act(async () => preview?.click())
    expect(previewRun).toHaveBeenCalledWith(run)

    const workflowPreview = host.querySelector<HTMLButtonElement>('button[aria-label="预览工作流 目录统计"]')
    await act(async () => workflowPreview?.click())
    expect(previewWorkflow).toHaveBeenCalledWith(workflow)

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps Workflow definitions ahead of a paged Run history', async () => {
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
    const runs = Array.from({ length: 25 }, (_, index): WorkflowRunSummary => ({
      ...run,
      id: `wfr_report_${index}`,
      created_at: `2026-07-${String(25 - index).padStart(2, '0')}T10:11:12`,
    }))
    globalThis.fetch = mock(async (url: string) => {
      const path = new URL(url).pathname
      if (path === '/workflows') return new Response(JSON.stringify([workflow]))
      if (path === '/workflow-runs') return new Response(JSON.stringify(runs))
      return new Response(JSON.stringify([]))
    }) as never
    await store.set(hydrateWorkflowsAtom)

    function MentionStateProbe() {
      const state = useMentionMenuState(true, '', null)
      const more = state.rows.find((row) => row.kind === 'more')
      return (
        <>
          <button type="button" data-action="runs" onClick={() => state.setScope('workflow-runs')} />
          <button type="button" data-action="more" onClick={() => more && state.showMore(more.key)} />
          {state.rows.map((row, index) => (
            <span key={index} data-row-kind={row.kind} />
          ))}
        </>
      )
    }

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <Provider store={store}>
          <MentionStateProbe />
        </Provider>,
      )
      await Promise.resolve()
    })

    const rowKinds = () => Array.from(host.querySelectorAll('[data-row-kind]'))
      .map((element) => element.getAttribute('data-row-kind'))
    expect(rowKinds()).toEqual([
      'workflow',
      'workflow-run',
      'workflow-run',
      'workflow-run',
      'scope-link',
    ])

    await act(async () => host.querySelector<HTMLButtonElement>('[data-action="runs"]')?.click())
    expect(rowKinds().filter((kind) => kind === 'workflow-run')).toHaveLength(20)
    expect(rowKinds().at(-1)).toBe('more')

    await act(async () => host.querySelector<HTMLButtonElement>('[data-action="more"]')?.click())
    expect(rowKinds().filter((kind) => kind === 'workflow-run')).toHaveLength(25)
    expect(rowKinds()).not.toContain('more')

    await act(async () => root.unmount())
    host.remove()
  })
})
