import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { MessageBlock } from '@shared/types'
import { DEFAULT_SETTINGS } from '@app/shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const testWindow = window as unknown as { api?: Record<string, unknown> }
testWindow.api = {
  workbench: {
    ensure: async () => undefined,
    activate: async () => undefined,
    close: async () => undefined,
  },
  ...testWindow.api,
  settings: {
    set: async () => {},
    get: async () => DEFAULT_SETTINGS,
  },
}
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const {
  activeSessionIdAtom,
  pendingComposerFocusAtom,
  pendingComposerInsertsAtom,
  pendingComposerSeedAtom,
} = await import('@/atoms/sessions')
const { activeModalAtom, activeNavAtom } = await import('@/atoms/amphi')
const { settingsAtom } = await import('@/atoms/settings')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { hydrateWorkflowsAtom } = await import('@/atoms/workflows')
const { BackendState } = await import('../../../../main/python-client/types')
const { NavKey } = await import('../LeftSidebar')
const { CompletedCard } = await import('../RightPanel')
const { WorkflowRunResultCard } = await import('../RightPanel')
const { WorkflowConfirmCard } = await import('../WorkflowConfirmCard')
const { WorkflowResultCard } = await import('../WorkflowResultCard')

afterEach(() => {
  document.body.replaceChildren()
})

describe('Workflow output cards', () => {
  it('shows an answered create confirmation as saving until the daemon returns its id', async () => {
    const block: Extract<MessageBlock, { type: 'workflow_confirm' }> = {
      type: 'workflow_confirm',
      requestId: 'confirm-saving',
      defaultName: '目录统计',
      workflowId: null,
      name: '目录统计',
      status: 'continued',
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <WorkflowConfirmCard block={block} />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('保存中')
    expect(host.textContent).toContain('正在保存工作流')
    expect(host.textContent).not.toContain('构建成功')
    expect(host.textContent).not.toContain('立即运行')

    await act(async () => root.unmount())
  })

  it('labels a saved Workflow as built and inserts its executable Slash token', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-1')
    const block: Extract<MessageBlock, { type: 'workflow_confirm' }> = {
      type: 'workflow_confirm',
      requestId: 'confirm-1',
      defaultName: '目录统计',
      workflowId: 'wf-directory',
      name: '目录统计',
      status: 'confirmed',
      summary: '已完成代表性验证。',
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowConfirmCard block={block} />
        </Provider>,
      )
    })

    const receipt = host.querySelector<HTMLElement>('section[role="status"]')
    expect(receipt?.getAttribute('aria-label')).toBe('工作流构建成功')
    expect(receipt?.className).toContain('border-status-success')
    expect(receipt?.className).toContain('bg-status-success-bg')
    expect(receipt?.className).toContain('max-w-3xl')
    expect(host.textContent).toContain('工作流构建成功')
    expect(host.textContent).toContain('“目录统计”已保存，可立即运行')
    expect(host.textContent).toContain('已完成代表性验证')
    expect(host.textContent).toContain('可重复运行')
    expect(host.textContent).not.toContain('验证通过')
    expect(host.querySelector('input')).toBeNull()
    const view = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('查看工作流'))
    const run = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('立即运行'))
    expect(view?.className).not.toContain('bg-brand-blue')
    expect(run?.className).not.toContain('bg-brand-blue')

    await act(async () => view?.click())
    expect(store.get(activeModalAtom)).toMatchObject({
      type: 'workflowDetail',
      workflowId: 'wf-directory',
    })

    await act(async () => run?.click())
    expect(store.get(pendingComposerInsertsAtom)).toEqual([[
      {
        type: 'slash',
        id: 'wf-directory',
        label: '目录统计',
        resource: 'workflow',
      },
      { type: 'text', value: ' ' },
    ]])

    await act(async () => root.unmount())
  })

  it('shows a saved Workflow current name while preserving the message snapshot', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-1')
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
    globalThis.fetch = (async (url: string) => {
      if (new URL(url).pathname === '/workflows') {
        return new Response(JSON.stringify([{
          id: 'wf-directory',
          name: '目录整理',
          workflow_dir: '/workflows/wf-directory',
        }]), { headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify([]), { headers: { 'content-type': 'application/json' } })
    }) as typeof fetch
    await store.set(hydrateWorkflowsAtom)
    const block: Extract<MessageBlock, { type: 'workflow_confirm' }> = {
      type: 'workflow_confirm',
      requestId: 'confirm-renamed',
      defaultName: '目录统计',
      workflowId: 'wf-directory',
      name: '目录统计',
      status: 'confirmed',
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowConfirmCard block={block} />
        </Provider>,
      )
    })

    expect(host.querySelector('input')).toBeNull()
    expect(host.textContent).toContain('目录整理')
    expect(host.textContent).not.toContain('“目录统计”已保存')
    const run = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('立即运行'))
    await act(async () => run?.click())
    expect(store.get(pendingComposerInsertsAtom)[0]?.[0]).toEqual({
      type: 'slash',
      id: 'wf-directory',
      label: '目录整理',
      resource: 'workflow',
    })

    await act(async () => root.unmount())
  })

  it('renders a saved edit as a compact Workflow update receipt', async () => {
    const block: Extract<MessageBlock, { type: 'workflow_confirm' }> = {
      type: 'workflow_confirm',
      requestId: 'confirm-edit',
      defaultName: '目录统计',
      workflowId: 'wf-directory',
      name: '目录统计',
      operation: 'edit',
      status: 'confirmed',
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <WorkflowConfirmCard block={block} />
        </Provider>,
      )
    })

    expect(host.querySelector('section[role="status"]')?.getAttribute('aria-label'))
      .toBe('工作流更新成功')
    expect(host.textContent).toContain('原有引用和历史运行结果保持不变')
    expect(host.querySelector('input')).toBeNull()

    await act(async () => root.unmount())
  })

  it('offers overwrite and localized save-as-new choices for a pending edit', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-edit-confirm')
    const block: Extract<MessageBlock, { type: 'workflow_confirm' }> = {
      type: 'workflow_confirm',
      requestId: 'confirm-edit-pending',
      defaultName: '目录统计',
      workflowId: 'wf-directory',
      operation: 'edit',
      status: 'pending',
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowConfirmCard block={block} />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('原工作流')
    expect(host.textContent).toContain('目录统计')
    expect(host.textContent).not.toContain('新工作流名称')
    expect(host.querySelector('input')).toBeNull()
    const initialButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
    expect(initialButtons.map((button) => button.textContent?.trim()))
      .toEqual(['继续修改', '另存为新工作流', '覆盖原工作流'])

    const saveAsNew = initialButtons.find((button) =>
      button.textContent?.includes('另存为新工作流'))
    await act(async () => saveAsNew?.click())

    expect(host.textContent).toContain('为新工作流命名。原工作流不会被修改。')
    expect(host.textContent).toContain('新工作流名称')
    const nameInput = host.querySelector<HTMLInputElement>('input')
    expect(nameInput?.value).toBe('目录统计 副本')
    expect(nameInput?.disabled).toBe(false)
    expect(document.activeElement).toBe(nameInput)
    const expandedButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .map((button) => button.textContent?.trim())
    expect(expandedButtons).toEqual(['返回', '创建新工作流'])

    const back = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('返回'))
    await act(async () => back?.click())
    expect(host.querySelector('input')).toBeNull()
    expect(host.textContent).not.toContain('新工作流名称')

    await act(async () => root.unmount())
  })

  it('inserts the completed Workflow into the current conversation', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-existing')
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, lastNav: NavKey.Workflows },
    })
    let previewCount = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <CompletedCard
            id="wf-directory"
            name="目录统计"
            onPreview={() => {
              previewCount += 1
            }}
          />
        </Provider>,
      )
    })

    const run = host.querySelector<HTMLButtonElement>(
      'button[aria-label="运行工作流 目录统计"]',
    )
    expect(run).toBeDefined()
    await act(async () => run?.click())

    expect(previewCount).toBe(0)
    expect(store.get(activeNavAtom)).toBe(NavKey.Home)
    expect(store.get(activeSessionIdAtom)).toBe('session-existing')
    expect(store.get(pendingComposerFocusAtom)).toBe(false)
    expect(store.get(pendingComposerSeedAtom)).toBeNull()
    expect(store.get(pendingComposerInsertsAtom)).toEqual([[
        {
          type: 'slash',
          id: 'wf-directory',
          label: '目录统计',
          resource: 'workflow',
        },
        { type: 'text', value: ' ' },
      ]])

    await act(async () => root.unmount())
  })

  it('uses completed and failed right-panel results in the current conversation', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-existing')
    let previewCount = 0
    const run = {
      id: 'wfr-report',
      workflow_id: 'wf-report',
      workflow_name: '生成报告',
      source_session_id: 'session-existing',
      workflow_input: { text: '/生成报告', blocks: [] },
      status: 'completed' as const,
      validation_status: 'passed' as const,
      created_at: '2026-08-03T06:00:00Z',
      finished_at: '2026-08-03T06:01:00Z',
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunResultCard run={run} onPreview={() => { previewCount += 1 }} />
        </Provider>,
      )
    })

    const useResult = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('使用结果'))
    await act(async () => useResult?.click())

    expect(previewCount).toBe(0)
    expect(store.get(activeSessionIdAtom)).toBe('session-existing')
    expect(store.get(pendingComposerInsertsAtom)[0]?.[0]).toMatchObject({
      type: 'mention',
      id: 'wfr-report',
      group: 'WorkflowRun',
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunResultCard
            run={{
              ...run,
              id: 'wfr-report-failed',
              status: 'failed',
              validation_status: 'failed',
            }}
            onPreview={() => { previewCount += 1 }}
          />
        </Provider>,
      )
    })
    const useFailedResult = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('使用结果'))
    await act(async () => useFailedResult?.click())

    expect(previewCount).toBe(0)
    expect(store.get(pendingComposerInsertsAtom)[1]?.[0]).toMatchObject({
      type: 'mention',
      id: 'wfr-report-failed',
      group: 'WorkflowRun',
    })

    await act(async () => root.unmount())
  })

  it('renders a completed Workflow as a terminal receipt with optional result actions', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-existing')
    const completed: Extract<MessageBlock, { type: 'workflow_result' }> = {
      type: 'workflow_result',
      runId: 'wfr-report',
      workflowId: 'wf-report',
      workflowName: '生成报告',
      status: 'completed',
      validationStatus: 'passed',
      createdAt: '2026-08-03T06:00:00Z',
      resultFileCount: 1,
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(<Provider store={store}><WorkflowResultCard block={completed} /></Provider>)
    })
    const receipt = host.querySelector<HTMLElement>('section[role="status"]')
    expect(receipt?.getAttribute('aria-label')).toBe('工作流执行完成')
    expect(receipt?.className).toContain('border-status-success')
    expect(receipt?.className).toContain('bg-status-success-bg')
    expect(receipt?.className).toContain('max-w-3xl')
    expect(receipt?.className).toContain('py-3')
    expect(host.textContent).toContain('工作流执行完成')
    expect(host.textContent).toContain('所有执行和验证步骤均已完成')
    expect(host.textContent).toContain('本次运行已结束，无需继续处理')
    expect(host.textContent).toContain('生成报告')
    expect(host.textContent).toContain('1 个结果文件')
    expect(host.textContent).toContain('查看结果')
    expect(host.textContent).toContain('引用结果')
    const completedButtons = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
    const viewResult = completedButtons.find((button) => button.textContent?.includes('查看结果'))
    const reuseResult = completedButtons.find((button) => button.textContent?.includes('引用结果'))
    expect(completedButtons.every((button) => !button.className.includes('bg-brand-blue'))).toBe(true)
    expect(completedButtons.indexOf(viewResult!)).toBeLessThan(completedButtons.indexOf(reuseResult!))

    await act(async () => viewResult?.click())
    expect(store.get(activeModalAtom)).toMatchObject({
      type: 'workflowRunDetail',
      runId: 'wfr-report',
    })

    await act(async () => reuseResult?.click())
    expect(store.get(pendingComposerInsertsAtom)[0]?.[0]).toMatchObject({
      type: 'mention',
      id: 'wfr-report',
      group: 'WorkflowRun',
    })

    await act(async () => root.unmount())
  })

  it('keeps execution-only, empty, legacy, and failed terminal receipts accurate', async () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-existing')
    const completed: Extract<MessageBlock, { type: 'workflow_result' }> = {
      type: 'workflow_result',
      runId: 'wfr-report',
      workflowId: 'wf-report',
      workflowName: '生成报告',
      status: 'completed',
      validationStatus: 'not_required',
      createdAt: '2026-08-03T06:00:00Z',
      resultFileCount: 0,
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowResultCard block={completed} />
        </Provider>,
      )
    })
    expect(host.textContent).toContain('所有执行步骤均已完成')
    expect(host.textContent).not.toContain('所有执行和验证步骤均已完成')
    expect(host.textContent).toContain('查看结果')
    expect(host.textContent).not.toContain('引用结果')

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowResultCard block={{ ...completed, resultFileCount: undefined }} />
        </Provider>,
      )
    })
    expect(host.textContent).toContain('引用结果')

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowResultCard
            block={{ ...completed, status: 'failed', validationStatus: 'failed' }}
          />
        </Provider>,
      )
    })
    const failure = host.querySelector<HTMLElement>('section[role="status"]')
    expect(failure?.getAttribute('aria-label')).toBe('工作流执行失败')
    expect(failure?.className).toContain('border-status-error')
    expect(failure?.className).toContain('bg-status-error-bg')
    expect(host.textContent).toContain('工作流执行失败')
    expect(host.textContent).toContain('本次运行已结束')
    expect(host.textContent).toContain('查看失败详情')
    expect(host.textContent).toContain('引用结果')

    const reuseFailedResult = Array.from(host.querySelectorAll<HTMLButtonElement>('button'))
      .find((button) => button.textContent?.includes('引用结果'))
    await act(async () => reuseFailedResult?.click())
    expect(store.get(pendingComposerInsertsAtom)[0]?.[0]).toMatchObject({
      type: 'mention',
      id: 'wfr-report',
      group: 'WorkflowRun',
    })

    await act(async () => root.unmount())
  })
})
