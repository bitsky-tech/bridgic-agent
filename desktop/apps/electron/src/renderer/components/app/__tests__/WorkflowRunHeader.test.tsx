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
const { AgentRole } = await import('@shared/types')
const {
  messageFamily,
  streamingFamily,
  thinkingModeFamily,
  workflowRunFamily,
} = await import('@/atoms/agent')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const {
  closeWorkflowRunDetailsAtom,
  openWorkflowRunDetailsAtom,
} = await import('@/atoms/workflow-run-details')
const {
  WorkflowRunHeader,
  WORKFLOW_RUN_COMPACT_HEADER_WIDTH,
  WORKFLOW_RUN_EXPANDED_HEADER_WIDTH,
  WORKFLOW_RUN_NARROW_HEADER_WIDTH,
  WORKFLOW_RUN_NARROW_RESTORE_WIDTH,
} = await import('../WorkflowRunHeader')
const { WorkflowRunDetailsPane } = await import('../WorkflowRunDetailsPane')
const { SESSION_STATUS_BAR_HEIGHT_PX } = await import('../SessionStatusBar')

function WorkflowRunSurface() {
  return (
    <>
      <WorkflowRunHeader />
      <WorkflowRunDetailsPane />
    </>
  )
}

describe('WorkflowRunHeader', () => {
  it('stays running while the parent Turn is durably waiting for a Child', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'waiting-session')
    store.set(thinkingModeFamily('waiting-session'), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily('waiting-session'), {
      workflowId: 'wf-waiting',
      generation: 'gen-waiting',
      workflowName: '等待子任务的工作流',
      sourceSessionId: 'waiting-session',
      phase: 'execute',
      stepIndex: 0,
      executionSteps: ['委派检查'],
      validationSteps: [],
    })
    store.set(messageFamily('waiting-session'), [{
      id: 'waiting-parent',
      turnId: 'turn-waiting',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_step',
        workflowId: 'wf-waiting',
        generation: 'gen-waiting',
        workflowName: '等待子任务的工作流',
        phase: 'execute',
        stepIndex: 0,
        stepCount: 1,
        title: '委派检查',
        status: 'running',
      }, {
        type: 'subagent',
        invocationId: 'child-completed-before-join',
        goal: '检查结果',
        status: 'completed',
      }],
      done: true,
      turnStatus: 'awaiting_subagents',
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunSurface />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('运行中')
    expect(host.textContent).not.toContain('已停止')
    expect(host.querySelector('[data-testid="workflow-run-details-trigger"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps the full top progress visible and opens step details in the right pane', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-1')
    store.set(thinkingModeFamily('session-1'), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily('session-1'), {
      workflowId: 'wf-report',
      generation: 'gen-current',
      workflowName: 'A股新闻搜索与总结',
      sourceSessionId: 'session-1',
      phase: 'execute',
      stepIndex: 1,
      executionSteps: ['确认新闻范围', '筛选新闻', '生成总结'],
      validationSteps: ['检查条数与来源'],
    })
    store.set(messageFamily('session-1'), [{
      id: 'previous-workflow-message',
      turnId: 'turn-previous',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_step',
        workflowId: 'wf-report',
        generation: 'gen-old',
        workflowName: 'A股新闻搜索与总结',
        phase: 'execute',
        stepIndex: 0,
        stepCount: 1,
        title: '旧运行步骤',
        status: 'success',
        summary: '旧运行结果不应混入当前状态。',
      }, {
        type: 'tool',
        toolUseId: 'old-tool-1',
        name: 'web_fetch',
        input: {},
      }],
      done: true,
      createdAt: 0,
    }, {
      id: 'workflow-message',
      turnId: 'turn-current',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_step',
        workflowId: 'wf-report',
        generation: 'gen-current',
        workflowName: 'A股新闻搜索与总结',
        phase: 'execute',
        stepIndex: 0,
        stepCount: 3,
        title: '确认新闻范围',
        status: 'success',
        summary: '已确认最近三天的三条消息。/Users/daixu/.bridgic/AmphiAgent/sessions/session_with_a_very_long_unbroken_identifier/result/summary.md',
      }, {
        type: 'tool',
        toolUseId: 'tool-1',
        name: 'web_fetch',
        input: {},
      }],
      done: true,
      createdAt: 1,
    }, {
      id: 'unrelated-normal-message',
      turnId: 'turn-unrelated',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'tool',
        toolUseId: 'unrelated-tool',
        name: 'bash',
        input: {},
      }],
      done: true,
      createdAt: 1.5,
    }])
    store.set(streamingFamily('session-1'), {
      messageId: 'streaming-message',
      content: '',
      toolCalls: [],
      blocks: [],
      startedAt: 2,
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunSurface />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('工作流')
    expect(host.textContent).toContain('执行')
    expect(host.textContent).toContain('2/3')
    expect(host.textContent).toContain('筛选新闻')
    expect(host.textContent).not.toContain('1 步完成 · 1 次调用')
    expect(host.textContent).not.toContain('旧运行步骤')
    expect(host.textContent).not.toContain('已确认最近三天的三条消息。')

    const container = host.querySelector('[data-testid="workflow-run-status-bar"]') as HTMLElement
    expect(container.className).toContain('relative')
    expect(container.className).toContain('w-full')
    expect(container.className).not.toContain('absolute')
    expect(container.style.height).toBe(`${SESSION_STATUS_BAR_HEIGHT_PX}px`)
    expect(host.querySelector('[data-testid="workflow-run-details-trigger"]')).toBeNull()
    expect(host.querySelector('[data-testid="workflow-phase-rail"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="workflow-compact-phase-rail"]')).toBeNull()
    await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-current'))

    const details = host.querySelector<HTMLElement>('[data-testid="workflow-run-details-pane"]')!
    const detailsHeader = host.querySelector<HTMLElement>('[data-testid="workflow-run-details-header"]')!
    const detailsScroll = host.querySelector<HTMLElement>('[data-testid="workflow-run-details-scroll"]')!
    expect(details.className).toContain('h-full')
    expect(details.className).toContain('flex-col')
    expect(details.className).toContain('min-w-0')
    expect(details.className).not.toContain('absolute')
    expect(detailsHeader.style.height).toBe(`${SESSION_STATUS_BAR_HEIGHT_PX}px`)
    expect(detailsHeader.nextElementSibling).toBe(detailsScroll)
    expect(detailsScroll.className).toContain('overflow-x-hidden')
    expect(host.querySelector('[data-testid="workflow-compact-phase-rail"]')).toBeNull()
    expect(host.querySelector('[data-testid="workflow-phase-rail"]')).not.toBeNull()
    expect(host.textContent).toContain('筛选新闻')
    const overview = host.querySelector<HTMLElement>('[data-testid="workflow-run-overview"]')!
    expect(overview.textContent).toContain('1/4')
    expect(overview.textContent).toContain('1执行完成')
    expect(overview.textContent).toContain('1工具调用')
    const progress = overview.querySelector<HTMLElement>('[role="progressbar"]')!
    expect(progress.getAttribute('aria-valuenow')).toBe('25')
    expect(host.textContent).toContain('执行工作流')
    expect(host.textContent).toContain('确认新闻范围')
    expect(host.textContent).toContain('已确认最近三天的三条消息。')
    expect(host.textContent).toContain('/Users/daixu/.bridgic/AmphiAgent/sessions/session_with_a_very_long_unbroken_identifier/result/summary.md')
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-testid="workflow-run-step-title"]'))
        .every((element) => element.className.includes('[overflow-wrap:anywhere]')),
    ).toBe(true)
    expect(
      Array.from(host.querySelectorAll<HTMLElement>('[data-testid="workflow-run-step-detail"]'))
        .every((element) => element.className.includes('[overflow-wrap:anywhere]')),
    ).toBe(true)
    expect(host.textContent).not.toContain('旧运行结果不应混入当前状态。')
    expect(host.textContent).toContain('验证结果')

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const executionTab = tabs.find((tab) => tab.textContent?.includes('执行工作流'))!
    const validationTab = tabs.find((tab) => tab.textContent?.includes('验证结果'))!
    expect(executionTab.textContent).toContain('当前第 2/3 步')
    expect(validationTab.textContent).toContain('0/1 项 · 等待执行')
    expect(executionTab.getAttribute('aria-selected')).toBe('true')
    expect(
      Array.from(details.querySelectorAll<HTMLElement>('[data-step-state]'))
        .map((step) => step.dataset.stepState),
    ).toEqual(['done', 'active', 'pending'])

    await act(async () => validationTab.click())

    const panel = host.querySelector<HTMLElement>('[data-testid="workflow-run-steps"]')!
    expect(validationTab.getAttribute('aria-selected')).toBe('true')
    expect(panel.textContent).toContain('检查条数与来源')
    expect(panel.textContent).not.toContain('确认新闻范围')
    expect(panel.getAttribute('role')).toBe('tabpanel')

    await act(async () => store.set(closeWorkflowRunDetailsAtom))
    expect(host.querySelector('[data-testid="workflow-run-details-pane"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('degrades only for a narrow header and keeps that choice independent from details', async () => {
    const OriginalResizeObserver = globalThis.ResizeObserver
    let resizeCallback: ResizeObserverCallback | undefined
    let observedBox: ResizeObserverBoxOptions | undefined
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe(_target: Element, options?: ResizeObserverOptions) {
        observedBox = options?.box
      }
      unobserve() {}
      disconnect() {}
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'responsive-run-header'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily(sessionId), {
      workflowId: 'wf-responsive',
      generation: 'gen-responsive',
      workflowName: '响应式工作流',
      sourceSessionId: sessionId,
      phase: 'execute',
      stepIndex: 0,
      executionSteps: ['执行任务'],
      validationSteps: ['验证结果'],
    })
    const resizeEntry = (borderWidth: number): ResizeObserverEntry => ({
      target: host,
      contentRect: { width: borderWidth - 16 } as DOMRectReadOnly,
      borderBoxSize: [{ inlineSize: borderWidth, blockSize: 0 }],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    })

    try {
      await act(async () => {
        root.render(
          <Provider store={store}>
            <WorkflowRunSurface />
          </Provider>,
        )
      })

      const belowCompact = WORKFLOW_RUN_COMPACT_HEADER_WIDTH - 20
      const inHysteresis = WORKFLOW_RUN_COMPACT_HEADER_WIDTH + 12
      const aboveExpanded = WORKFLOW_RUN_EXPANDED_HEADER_WIDTH + 8
      expect(inHysteresis).toBeLessThan(WORKFLOW_RUN_EXPANDED_HEADER_WIDTH)
      expect(observedBox).toBe('border-box')

      await act(async () => {
        resizeCallback?.([resizeEntry(belowCompact)], {} as ResizeObserver)
      })
      expect(host.querySelector('[data-testid="workflow-compact-phase-rail"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="workflow-phase-rail"]')).toBeNull()

      await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-responsive'))
      expect(host.querySelector('[data-testid="workflow-compact-phase-rail"]')).not.toBeNull()

      await act(async () => {
        resizeCallback?.([resizeEntry(inHysteresis)], {} as ResizeObserver)
      })
      expect(host.querySelector('[data-testid="workflow-compact-phase-rail"]')).not.toBeNull()

      await act(async () => {
        resizeCallback?.([resizeEntry(aboveExpanded)], {} as ResizeObserver)
      })
      expect(host.querySelector('[data-testid="workflow-phase-rail"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="workflow-compact-phase-rail"]')).toBeNull()

      await act(async () => store.set(closeWorkflowRunDetailsAtom))
      expect(host.querySelector('[data-testid="workflow-phase-rail"]')).not.toBeNull()

      await act(async () => {
        resizeCallback?.([resizeEntry(inHysteresis)], {} as ResizeObserver)
      })
      expect(host.querySelector('[data-testid="workflow-phase-rail"]')).not.toBeNull()
    } finally {
      await act(async () => root.unmount())
      host.remove()
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })

  it('uses a non-overlapping narrow composition from 400px and restores compact with hysteresis', async () => {
    const OriginalResizeObserver = globalThis.ResizeObserver
    let resizeCallback: ResizeObserverCallback | undefined
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) {
        resizeCallback = callback
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'very-narrow-run-header'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily(sessionId), {
      workflowId: 'wf-narrow',
      generation: 'gen-narrow',
      workflowName: '很长的响应式工作流名称',
      sourceSessionId: sessionId,
      phase: 'execute',
      stepIndex: 1,
      executionSteps: ['第一步', '第二步', '第三步'],
      validationSteps: ['验证结果'],
    })
    const resizeEntry = (width: number): ResizeObserverEntry => ({
      target: host,
      contentRect: { width } as DOMRectReadOnly,
      borderBoxSize: [{ inlineSize: width, blockSize: 0 }],
      contentBoxSize: [],
      devicePixelContentBoxSize: [],
    })

    try {
      await act(async () => {
        root.render(<Provider store={store}><WorkflowRunHeader /></Provider>)
      })

      await act(async () => {
        resizeCallback?.([resizeEntry(400)], {} as ResizeObserver)
      })
      const bar = host.querySelector<HTMLElement>('[data-testid="workflow-run-status-bar"]')!
      const identity = host.querySelector<HTMLElement>('[data-testid="session-status-identity"]')!
      const rail = host.querySelector<HTMLElement>('[data-testid="session-status-rail"]')!
      const compactRail = host.querySelector<HTMLElement>('[data-testid="workflow-compact-phase-rail"]')!
      expect(bar.dataset.density).toBe('narrow')
      expect(identity.className).toContain('overflow-hidden')
      expect(rail.className).toContain('shrink-0')
      expect(compactRail.dataset.density).toBe('narrow')
      expect(compactRail.className).toContain('w-28')
      expect(compactRail.textContent).toContain('执行 · 2/3')
      expect(host.querySelector<HTMLElement>('[data-testid="session-status-badge"]')?.className)
        .toContain('hidden')
      expect(host.querySelector('[data-testid="session-status-state"]')).toBeNull()
      expect(host.textContent).not.toContain('很长的响应式工作流名称')

      await act(async () => {
        resizeCallback?.([
          resizeEntry(WORKFLOW_RUN_NARROW_HEADER_WIDTH + 8),
        ], {} as ResizeObserver)
      })
      expect(bar.dataset.density).toBe('narrow')

      await act(async () => {
        resizeCallback?.([
          resizeEntry(WORKFLOW_RUN_NARROW_RESTORE_WIDTH),
        ], {} as ResizeObserver)
      })
      expect(bar.dataset.density).toBe('compact')
      expect(host.querySelector<HTMLElement>('[data-testid="workflow-compact-phase-rail"]')?.dataset.density)
        .toBe('compact')
    } finally {
      await act(async () => root.unmount())
      host.remove()
      globalThis.ResizeObserver = OriginalResizeObserver
    }
  })

  it('does not reuse an earlier generation before the current run reports its first step', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-restart')
    store.set(thinkingModeFamily('session-restart'), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily('session-restart'), {
      workflowId: 'wf-repeat',
      generation: 'gen-new',
      workflowName: '重复运行',
      sourceSessionId: 'session-restart',
      phase: 'execute',
      stepIndex: 0,
      executionSteps: ['新运行第一步'],
      validationSteps: [],
    })
    store.set(messageFamily('session-restart'), [{
      id: 'old-run',
      turnId: 'turn-old',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_step',
        workflowId: 'wf-repeat',
        generation: 'gen-old',
        workflowName: '重复运行',
        phase: 'execute',
        stepIndex: 0,
        stepCount: 1,
        title: '旧运行第一步',
        status: 'success',
        summary: '旧运行结果',
      }],
      done: true,
      createdAt: 1,
    }, {
      id: 'current-launch',
      turnId: 'turn-current',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [],
      done: true,
      stopped: true,
      createdAt: 2,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunSurface />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('新运行第一步')
    expect(host.textContent).not.toContain('旧运行第一步')
    await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-new'))
    expect(host.textContent).toContain('当前步')
    expect(host.textContent).not.toContain('旧运行结果')

    await act(async () => {
      store.set(workflowRunFamily('session-restart'), {
        workflowId: 'wf-repeat',
        generation: 'gen-new',
        workflowName: '重复运行',
        sourceSessionId: 'session-restart',
        phase: 'execute',
        stepIndex: 0,
        executionSteps: ['新运行第一步'],
        validationSteps: [],
      })
      store.set(streamingFamily('session-restart'), {
        messageId: 'live-restart',
        content: '',
        toolCalls: [],
        blocks: [{
          type: 'workflow_step',
          workflowId: 'wf-repeat',
          generation: 'gen-new',
          workflowName: '重复运行',
          phase: 'execute',
          stepIndex: 0,
          stepCount: 1,
          title: '新运行第一步',
          status: 'running',
        }],
        startedAt: 3,
      })
    })

    expect(host.textContent).toContain('新运行第一步')
    expect(host.textContent).not.toContain('旧运行第一步')
    expect(host.textContent).not.toContain('旧运行结果')

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders execute and validate completion boundaries without an extra step', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-boundary'
    const completedExecute = {
      type: 'workflow_step' as const,
      workflowId: 'wf-boundary',
      generation: 'gen-boundary',
      workflowName: '边界工作流',
      phase: 'execute' as const,
      stepIndex: 0,
      stepCount: 1,
      title: '唯一执行步骤',
      status: 'success' as const,
      summary: '执行完成',
    }
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily(sessionId), {
      workflowId: 'wf-boundary',
      generation: 'gen-boundary',
      workflowName: '边界工作流',
      sourceSessionId: sessionId,
      phase: 'execute',
      stepIndex: 1,
      executionSteps: ['唯一执行步骤'],
      validationSteps: ['唯一验证步骤'],
    })
    store.set(messageFamily(sessionId), [{
      id: 'boundary-run',
      turnId: 'turn-boundary',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [completedExecute],
      done: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunSurface />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('执行 · 1/1')
    expect(host.textContent).toContain('执行阶段已完成，等待验证')
    expect(host.textContent).not.toContain('2/2')
    expect(host.textContent).not.toContain('正在初始化')

    await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-boundary'))
    let tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs.find((tab) => tab.textContent?.includes('执行工作流'))?.textContent)
      .toContain('1/1 步完成')

    await act(async () => {
      store.set(workflowRunFamily(sessionId), {
        workflowId: 'wf-boundary',
        generation: 'gen-boundary',
        workflowName: '边界工作流',
        sourceSessionId: sessionId,
        phase: 'validate',
        stepIndex: 1,
        executionSteps: ['唯一执行步骤'],
        validationSteps: ['唯一验证步骤'],
      })
      store.set(messageFamily(sessionId), [{
        id: 'boundary-run',
        turnId: 'turn-boundary',
        role: AgentRole.Assistant,
        text: '',
        toolCalls: [],
        blocks: [completedExecute, {
          type: 'workflow_step',
          workflowId: 'wf-boundary',
          generation: 'gen-boundary',
          workflowName: '边界工作流',
          phase: 'validate',
          stepIndex: 0,
          stepCount: 1,
          title: '唯一验证步骤',
          status: 'success',
          summary: '验证完成',
        }],
        done: true,
        createdAt: 1,
      }])
    })

    expect(host.textContent).toContain('验证 · 1/1')
    expect(host.textContent).toContain('验证阶段已完成，等待结束')
    expect(host.querySelector('[data-testid="workflow-run-status-bar"]')?.textContent)
      .not.toContain('2/2')
    tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs.find((tab) => tab.textContent?.includes('验证结果'))?.textContent)
      .toContain('1/1 项完成')

    await act(async () => root.unmount())
    host.remove()
  })

  it('does not fabricate validation UI for an execution-only Workflow', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-execution-only'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily(sessionId), {
      workflowId: 'wf-execution-only',
      generation: 'gen-execution-only',
      workflowName: '仅执行工作流',
      sourceSessionId: sessionId,
      phase: 'execute',
      stepIndex: 1,
      executionSteps: ['生成交付文件'],
      validationSteps: [],
    })
    store.set(messageFamily(sessionId), [{
      id: 'execution-only-run',
      turnId: 'turn-execution-only',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_step',
        workflowId: 'wf-execution-only',
        generation: 'gen-execution-only',
        workflowName: '仅执行工作流',
        phase: 'execute',
        stepIndex: 0,
        stepCount: 1,
        title: '生成交付文件',
        status: 'success',
        summary: '交付文件已生成。',
      }],
      done: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunSurface />
        </Provider>,
      )
    })

    const rail = host.querySelector<HTMLElement>('[data-testid="workflow-phase-rail"]')!
    expect(rail.textContent).toContain('执行')
    expect(rail.textContent).not.toContain('验证')
    expect(host.textContent).toContain('执行阶段已完成，等待结束')

    await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-execution-only'))

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.textContent).toContain('执行工作流')
    const details = host.querySelector<HTMLElement>('[data-testid="workflow-run-details-pane"]')!
    expect(details.textContent).not.toContain('验证结果')
    expect(details.textContent).not.toContain('验证完成')
    expect(details.textContent).not.toContain('尚未加载阶段步骤')
    expect(details.querySelector('[data-testid="workflow-run-overview"]')?.textContent)
      .toContain('1/1')

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows validation steps with the same current-position semantics and keeps both tabs available', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-validate')
    store.set(thinkingModeFamily('session-validate'), { mode: 'run_workflow', stage: 'validate' })
    store.set(workflowRunFamily('session-validate'), {
      workflowId: 'wf-report',
      generation: 'gen-validate',
      workflowName: '目录报告',
      sourceSessionId: 'session-validate',
      phase: 'validate',
      stepIndex: 1,
      executionSteps: ['读取目录', '生成报告', '展示报告'],
      validationSteps: ['检查文件结构', '检查报告内容', '检查异常说明'],
    })
    store.set(messageFamily('session-validate'), [{
      id: 'completed-steps',
      turnId: 'turn-validate',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_step',
        workflowId: 'wf-report',
        generation: 'gen-validate',
        workflowName: '目录报告',
        phase: 'execute',
        stepIndex: 2,
        stepCount: 3,
        title: '展示报告',
        status: 'success',
        summary: '报告已经展示。',
      }, {
        type: 'workflow_step',
        workflowId: 'wf-report',
        generation: 'gen-validate',
        workflowName: '目录报告',
        phase: 'validate',
        stepIndex: 0,
        stepCount: 3,
        title: '检查文件结构',
        status: 'success',
        summary: '结构检查通过。',
      }],
      done: true,
      createdAt: 1,
    }])
    store.set(streamingFamily('session-validate'), {
      messageId: 'streaming-validation',
      content: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_step',
        workflowId: 'wf-report',
        generation: 'gen-validate',
        workflowName: '目录报告',
        phase: 'validate',
        stepIndex: 1,
        stepCount: 3,
        title: '检查报告内容',
        status: 'running',
      }],
      startedAt: 2,
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowRunSurface />
        </Provider>,
      )
    })

    expect(host.textContent).toContain('工作流')
    expect(host.textContent).toContain('验证')
    expect(host.textContent).toContain('2/3')
    await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-validate'))

    const tabs = Array.from(host.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
    const executionTab = tabs.find((tab) => tab.textContent?.includes('执行工作流'))!
    const validationTab = tabs.find((tab) => tab.textContent?.includes('验证结果'))!
    const panel = host.querySelector<HTMLElement>('[role="tabpanel"]')!
    expect(executionTab.textContent).toContain('3/3 步完成')
    expect(validationTab.textContent).toContain('当前第 2/3 项')
    expect(validationTab.getAttribute('aria-selected')).toBe('true')
    expect(panel.textContent).toContain('检查文件结构')
    expect(panel.textContent).toContain('检查报告内容')

    await act(async () => executionTab.click())

    expect(executionTab.getAttribute('aria-selected')).toBe('true')
    expect(panel.textContent).toContain('读取目录')
    expect(panel.textContent).toContain('展示报告')
    expect(panel.textContent).not.toContain('检查报告内容')

    await act(async () => {
      store.set(streamingFamily('session-validate'), {
        messageId: 'streaming-validation',
        content: '',
        toolCalls: [],
        blocks: [{
          type: 'workflow_step',
          workflowId: 'wf-report',
          generation: 'gen-validate',
          workflowName: '目录报告',
          phase: 'validate',
          stepIndex: 1,
          stepCount: 3,
          title: '检查报告内容',
          status: 'failure',
          summary: '报告缺少必要章节。',
        }],
        startedAt: 2,
      })
    })
    await act(async () => validationTab.click())

    const failedStep = host.querySelector<HTMLElement>('[data-step-state="failed"]')
    expect(failedStep?.textContent).toContain('检查报告内容')
    expect(failedStep?.textContent).toContain('报告缺少必要章节。')
    expect(host.querySelector('[data-testid="workflow-run-overview"]')?.textContent)
      .toContain('1验证完成')

    await act(async () => root.unmount())
    host.remove()
  })
})
