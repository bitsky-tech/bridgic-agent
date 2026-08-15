import { afterAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const cancelledSessions: string[] = []
const subscribedSessions: string[] = []
const unsubscribedSessions: string[] = []
const permissionResponses: Array<{
  sessionId: string
  payload: {
    request_id: string
    answers: Array<{ call_index: number; decision: 'allow' | 'deny'; instruction?: string }>
  }
}> = []
mock.module('@/lib/amphiWsConnection', () => ({
  getAmphiWsConnection: () => ({
    subscribe: (sessionId: string) => subscribedSessions.push(sessionId),
    unsubscribe: (sessionId: string) => unsubscribedSessions.push(sessionId),
    cancel: (sessionId: string) => cancelledSessions.push(sessionId),
    respondPermission: (
      sessionId: string,
      payload: {
        request_id: string
        answers: Array<{ call_index: number; decision: 'allow' | 'deny'; instruction?: string }>
      },
    ) => permissionResponses.push({ sessionId, payload }),
  }),
}))

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { messageFamily, streamingFamily } = await import('@/atoms/agent')
const { pendingBySessionAtom, setHumanRequestAtom } = await import('@/atoms/human-request')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { subagentsAtom } = await import('@/atoms/subagents')
const { AgentRole } = await import('@shared/types')
const { i18n } = await import('@/lib/i18n')
const { SubagentModal } = await import('../SubagentModal')

describe('SubagentModal', () => {
  it('shows the running task before blocking and RPC Child Turns persist', async () => {
    const cases = [
      {
        invocationId: 'blocking-task',
        mode: 'blocking',
        stateGoal: '检查阻塞子任务',
        modalGoal: undefined,
      },
      {
        invocationId: 'rpc-task',
        mode: 'rpc',
        stateGoal: '',
        modalGoal: '检查 RPC 子任务',
      },
    ] as const

    for (const child of cases) {
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const store = createStore()
      store.set(subagentsAtom, new Map([[child.invocationId, {
        invocationId: child.invocationId,
        parentSessionId: 'parent',
        mode: child.mode,
        goal: child.stateGoal,
        status: 'running',
      }]]))
      store.set(streamingFamily(child.invocationId), {
        messageId: `${child.invocationId}:stream`,
        content: '',
        toolCalls: [],
        blocks: [],
        startedAt: 0,
      })

      await act(async () => {
        root.render(
          <Provider store={store}>
            <SubagentModal invocationId={child.invocationId} goal={child.modalGoal} />
          </Provider>,
        )
      })

      const userBubbles = document.body.querySelectorAll('.bg-msg-user-bg')
      expect(userBubbles).toHaveLength(1)
      expect(userBubbles[0]?.textContent?.trim()).toBe(child.stateGoal || child.modalGoal)

      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('hands the provisional task to the persisted user message without duplication', async () => {
    const invocationId = 'persisted-task'
    const provisionalGoal = '临时子任务'
    const persistedGoal = '权威子任务'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(subagentsAtom, new Map([[invocationId, {
      invocationId,
      parentSessionId: 'parent',
      mode: 'blocking',
      goal: provisionalGoal,
      status: 'running',
    }]]))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SubagentModal invocationId={invocationId} />
        </Provider>,
      )
    })
    let userBubbles = document.body.querySelectorAll('.bg-msg-user-bg')
    expect(userBubbles).toHaveLength(1)
    expect(userBubbles[0]?.textContent?.trim()).toBe(provisionalGoal)

    await act(async () => {
      store.set(messageFamily(invocationId), [{
        id: `${invocationId}:u0`,
        role: AgentRole.User,
        text: persistedGoal,
        toolCalls: [],
        done: true,
        createdAt: 1,
      }])
    })
    userBubbles = document.body.querySelectorAll('.bg-msg-user-bg')
    expect(userBubbles).toHaveLength(1)
    expect(userBubbles[0]?.textContent?.trim()).toBe(persistedGoal)
    expect(document.body.textContent).not.toContain(provisionalGoal)

    await act(async () => root.unmount())
    host.remove()
  })

  it('does not release the Child stream when the view closes', async () => {
    subscribedSessions.length = 0
    unsubscribedSessions.length = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(subagentsAtom, new Map([['running-child', {
      invocationId: 'running-child',
      parentSessionId: 'parent',
      mode: 'blocking',
      goal: '继续运行',
      status: 'running',
    }]]))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SubagentModal invocationId="running-child" />
        </Provider>,
      )
    })
    await act(async () => root.unmount())

    expect(subscribedSessions).toEqual(['running-child'])
    expect(unsubscribedSessions).toEqual([])
    host.remove()
  })

  it('shows a Child join as execution progress without requesting user action', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(subagentsAtom, new Map([['joining-child', {
      invocationId: 'joining-child',
      parentSessionId: 'parent',
      mode: 'blocking',
      goal: '等待下级任务',
      status: 'awaiting_subagents',
    }]]))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SubagentModal invocationId="joining-child" />
        </Provider>,
      )
    })

    expect(document.body.textContent).toContain(i18n.t('status.subagent.awaitingSubagents'))
    expect(document.body.textContent).not.toContain(i18n.t('status.subagent.awaitingHuman'))

    await act(async () => root.unmount())
    host.remove()
  })

  it('removes Child approval actions as soon as stopping starts', async () => {
    cancelledSessions.length = 0
    permissionResponses.length = 0
    const invocationId = 'stopping-permission-child'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(subagentsAtom, new Map([[invocationId, {
      invocationId,
      parentSessionId: 'parent',
      mode: 'rpc',
      goal: '等待删除审批',
      status: 'awaiting_permission',
    }]]))
    store.set(messageFamily(invocationId), [{
      id: `${invocationId}:assistant`,
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'permission',
        requestId: 'request-stopping-child',
        items: [{
          callIndex: 0,
          tool: 'bash',
          arguments: { command: 'rm /Users/example/outside.txt' },
          capability: 'delete',
          boundary: 'out_of_bounds',
          label: '删除工作区外文件',
        }],
        questions: [],
      }],
      done: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SubagentModal invocationId={invocationId} />
        </Provider>,
      )
    })

    const findAction = (label: string) => [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === label,
    )
    expect(findAction(i18n.t('permission.action.allow'))).toBeDefined()
    await act(async () => findAction(i18n.t('subagent.modal.stop'))?.click())

    expect(cancelledSessions).toEqual([invocationId])
    expect(findAction(i18n.t('permission.action.allow'))).toBeUndefined()
    expect(permissionResponses).toEqual([])

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders a Child permission gate and sends the decision to the Child Session', async () => {
    permissionResponses.length = 0
    const invocationId = 'permission-child'
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'active-parent')
    store.set(subagentsAtom, new Map([[invocationId, {
      invocationId,
      parentSessionId: 'active-parent',
      mode: 'rpc',
      goal: '删除工作区外文件',
      status: 'awaiting_permission',
    }]]))
    store.set(messageFamily(invocationId), [{
      id: `${invocationId}:assistant`,
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'permission',
        requestId: 'request-child',
        items: [{
          callIndex: 0,
          tool: 'bash',
          arguments: { command: 'rm /Users/example/outside.txt' },
          capability: 'delete',
          boundary: 'out_of_bounds',
          label: '删除工作区外文件',
        }],
        questions: [{
          question: '允许删除该文件吗？',
          options: [{ label: 'allow' }, { label: 'deny' }],
        }],
      }],
      done: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SubagentModal invocationId={invocationId} />
        </Provider>,
      )
    })

    expect(document.body.textContent).toContain('bash')
    const allow = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === i18n.t('permission.action.allow'),
    )
    expect(allow).toBeDefined()
    await act(async () => allow?.click())

    expect(permissionResponses).toEqual([{
      sessionId: invocationId,
      payload: {
        request_id: 'request-child',
        answers: [{ call_index: 0, decision: 'allow', instruction: undefined }],
      },
    }])
    expect(permissionResponses[0]?.sessionId).not.toBe('active-parent')

    await act(async () => root.unmount())
    host.remove()
  })

  it('lets the user stop a blocking Child even while it awaits interaction', async () => {
    cancelledSessions.length = 0
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(subagentsAtom, new Map([['child-session', {
      invocationId: 'child-session',
      parentSessionId: 'parent',
      mode: 'blocking',
      goal: '等待确认的子任务',
      status: 'awaiting_human',
    }]]))
    store.set(setHumanRequestAtom, {
      sessionId: 'child-session',
      questions: [{
        question: '继续吗？',
        options: [{ label: '继续' }, { label: '停止' }],
      }],
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SubagentModal invocationId="child-session" />
        </Provider>,
      )
    })

    const stop = [...document.body.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === i18n.t('subagent.modal.stop'),
    )
    expect(stop).toBeDefined()
    await act(async () => stop?.click())

    expect(cancelledSessions).toEqual(['child-session'])
    expect(store.get(pendingBySessionAtom).has('child-session')).toBe(false)
    expect(document.body.textContent).toContain(i18n.t('subagent.modal.stopping'))

    await act(async () => root.unmount())
    host.remove()
  })

  it('shows a cancelled Child as stopped without another stop action', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(subagentsAtom, new Map([['cancelled-child', {
      invocationId: 'cancelled-child',
      parentSessionId: 'parent',
      mode: 'blocking',
      goal: '已停止子任务',
      status: 'cancelled',
    }]]))
    store.set(messageFamily('cancelled-child'), [{
      id: 'cancelled-child:assistant',
      role: AgentRole.Assistant,
      text: '',
      toolCalls: [],
      blocks: [{
        type: 'permission',
        requestId: 'stale-cancelled-request',
        items: [{
          callIndex: 0,
          tool: 'bash',
          arguments: { command: 'rm /Users/example/outside.txt' },
          capability: 'delete',
          boundary: 'out_of_bounds',
          label: '旧审批',
        }],
        questions: [],
      }],
      done: true,
      createdAt: 1,
    }])

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SubagentModal invocationId="cancelled-child" />
        </Provider>,
      )
    })

    expect(document.body.textContent).toContain(i18n.t('status.subagent.stopped'))
    expect([...document.body.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === i18n.t('subagent.modal.stop'),
    )).toBe(false)
    expect([...document.body.querySelectorAll('button')].some(
      (button) => button.textContent?.trim() === i18n.t('permission.action.allow'),
    )).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })
})
