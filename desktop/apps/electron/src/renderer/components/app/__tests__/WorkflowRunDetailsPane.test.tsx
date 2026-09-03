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
const { WorkflowRunDetailsPane } = await import('../WorkflowRunDetailsPane')
const { SESSION_STATUS_BAR_HEIGHT_PX } = await import('../SessionStatusBar')

function WorkflowRunDetailsSurface() {
  return <WorkflowRunDetailsPane />
}

describe('WorkflowRunDetailsPane', () => {
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
          <WorkflowRunDetailsSurface />
        </Provider>,
      )
    })
    await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-waiting'))

    expect(host.textContent).toContain('运行中')
    expect(host.textContent).not.toContain('已停止')

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows step progress in the right pane without restoring a top rail', async () => {
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
          <WorkflowRunDetailsSurface />
        </Provider>,
      )
    })

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
    expect(host.textContent).toContain('筛选新闻')
    const overview = host.querySelector<HTMLElement>('[data-testid="workflow-run-overview"]')!
    expect(overview.textContent).toContain('1/3')
    expect(overview.textContent).toContain('1执行完成')
    expect(overview.textContent).toContain('1工具调用')
    const progress = overview.querySelector<HTMLElement>('[role="progressbar"]')!
    expect(progress.getAttribute('aria-valuenow')).toBe('33')
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
    expect(host.textContent).not.toContain('验证结果')
    expect(host.querySelector('#workflow-execute-details-tab')?.textContent)
      .toContain('当前第 2/3 步')
    expect(
      Array.from(details.querySelectorAll<HTMLElement>('[data-step-state]'))
        .map((step) => step.dataset.stepState),
    ).toEqual(['done', 'active', 'pending'])

    await act(async () => store.set(closeWorkflowRunDetailsAtom))
    expect(host.querySelector('[data-testid="workflow-run-details-pane"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
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
          <WorkflowRunDetailsSurface />
        </Provider>,
      )
    })

    await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-new'))
    expect(host.textContent).toContain('新运行第一步')
    expect(host.textContent).not.toContain('旧运行第一步')
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

  it('renders the execution completion boundary without an extra step', async () => {
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
          <WorkflowRunDetailsSurface />
        </Provider>,
      )
    })

    await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-boundary'))
    expect(host.textContent).toContain('执行阶段已完成，等待结束')
    expect(host.textContent).not.toContain('2/2')
    expect(host.textContent).not.toContain('正在初始化')
    expect(host.querySelector('#workflow-execute-details-tab')?.textContent)
      .toContain('1/1 步完成')

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders completed execution details from the available run blocks', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    const sessionId = 'session-completed-run'
    store.set(activeSessionIdAtom, sessionId)
    store.set(thinkingModeFamily(sessionId), { mode: 'run_workflow', stage: 'execute' })
    store.set(workflowRunFamily(sessionId), {
      workflowId: 'wf-completed-run',
      generation: 'gen-completed-run',
      workflowName: '执行工作流',
      sourceSessionId: sessionId,
      phase: 'execute',
      stepIndex: 1,
      executionSteps: ['生成交付文件'],
    })
    store.set(messageFamily(sessionId), [{
      id: 'completed-run-message',
      turnId: 'turn-completed-run',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'workflow_step',
        workflowId: 'wf-completed-run',
        generation: 'gen-completed-run',
        workflowName: '执行工作流',
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
          <WorkflowRunDetailsSurface />
        </Provider>,
      )
    })

    await act(async () => store.set(openWorkflowRunDetailsAtom, 'gen-completed-run'))

    expect(host.querySelector('#workflow-execute-details-tab')?.textContent)
      .toContain('执行工作流')
    const details = host.querySelector<HTMLElement>('[data-testid="workflow-run-details-pane"]')!
    expect(details.textContent).not.toContain('验证结果')
    expect(details.textContent).not.toContain('验证完成')
    expect(details.textContent).not.toContain('尚未加载阶段步骤')
    expect(details.querySelector('[data-testid="workflow-run-overview"]')?.textContent)
      .toContain('1/1')

    await act(async () => root.unmount())
    host.remove()
  })

})
