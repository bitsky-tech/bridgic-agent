import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

window.api = {
  backend: {
    getClients: mock(async () => ({ ok: true, clients: [] })),
  },
} as never

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { BackendState } = await import('../../../../main/python-client/types')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { activeSessionIdAtom, hydrateSessionsFromDaemonAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { subagentsAtom } = await import('@/atoms/subagents')
const { issueReportRequestAtom } = await import('@/atoms/issue-report')
const { i18n } = await import('@/lib/i18n')
const { DEFAULT_SETTINGS } = await import('@app/shared/types')
const { SidebarContainer } = await import('../SidebarContainer')
// Resolve NavKey after SidebarContainer because atoms/amphi and LeftSidebar form a cycle.
// Entering through LeftSidebar first hits the TDZ of module-scope `Object.values(NavKey)` in amphi.ts.
const { NavKey } = await import('@/components/amphi/LeftSidebar')

beforeAll(async () => {
  await i18n.changeLanguage('zh')
})

describe('SidebarContainer global feedback', () => {
  it('opens a renderer report without attaching the active conversation', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    store.set(activeSessionIdAtom, 'active-conversation')

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const feedback = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-feedback"]')
    expect(feedback?.tagName).toBe('BUTTON')
    expect(feedback?.getAttribute('aria-label')).toBe('反馈问题')
    expect(feedback?.className).toContain('hover:bg-bg-hover')
    expect(feedback?.className).toContain('focus-visible:ring-2')
    expect(host.querySelector('[data-testid="approval-bell"]')).not.toBeNull()
    const settings = host.querySelector<HTMLButtonElement>('[data-testid="open-settings-gear"]')
    expect(settings?.tagName).toBe('BUTTON')
    expect(settings?.getAttribute('aria-label')).toBe('设置')

    await act(async () => feedback?.click())

    const request = store.get(issueReportRequestAtom)
    expect(request?.source).toBe('renderer')
    expect(request?.sessionId).toBeUndefined()
    expect(request?.messageId).toBeUndefined()
    expect(Object.keys(request ?? {}).sort()).toEqual(['openedAt', 'source'])

    await act(async () => root.unmount())
    host.remove()
  })
})

function setDaemonSessions(
  store: ReturnType<typeof createStore>,
  sessions: unknown[],
): void {
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
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify(sessions), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  ) as never
}

describe('SidebarContainer Child Session statuses', () => {
  it('renders a hydrated blocking Child join as running, never as待回答', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent', title: '父会话', tokens: 0, status: 'running' },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const parent = host.querySelector('[data-testid="session-parent"]')
    expect(parent?.querySelector('[aria-label="Agent 正在运行"]')).not.toBeNull()
    expect(parent?.querySelector('[aria-label="待回答"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('projects a live blocking Child interaction onto the running parent Session', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent-live-wait', title: '父会话', tokens: 0, status: 'running' },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    store.set(subagentsAtom, new Map([['blocking-child', {
      invocationId: 'blocking-child',
      parentSessionId: 'parent-live-wait',
      mode: 'blocking',
      goal: '询问用户',
      status: 'awaiting_human',
    }]]))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const parent = host.querySelector('[data-testid="session-parent-live-wait"]')
    expect(parent?.querySelector('[aria-label="子 Agent：等待你的回答"]')).not.toBeNull()
    expect(parent?.querySelector('[aria-label="Agent 正在运行"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps an RPC Child interaction on the parent while Background children are expanded', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent-mixed', title: '父会话', tokens: 0, status: 'running' },
      {
        id: 'background-child',
        title: '后台子任务',
        tokens: 0,
        status: 'finish',
        parent_session_id: 'parent-mixed',
        subagent_mode: 'background',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    store.set(subagentsAtom, new Map([
      ['background-child', {
        invocationId: 'background-child',
        parentSessionId: 'parent-mixed',
        mode: 'background',
        goal: '后台分析',
        status: 'running',
      }],
      ['rpc-child', {
        invocationId: 'rpc-child',
        parentSessionId: 'parent-mixed',
        mode: 'rpc',
        goal: '通过 Bash 调用的子任务',
        status: 'awaiting_permission',
      }],
    ]))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const parent = host.querySelector('[data-testid="session-parent-mixed"]')
    const background = host.querySelector('[data-testid="session-background-child"]')
    expect(parent?.querySelector('[aria-label="子 Agent：等待工具审批"]')).not.toBeNull()
    expect(parent?.querySelector('[aria-label="Agent 正在运行"]')).toBeNull()
    expect(background?.querySelector('[aria-label="Agent 正在运行"]')).not.toBeNull()
    expect(parent?.querySelector('[aria-label="收起子会话"]')).not.toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('keeps Child status icon semantics and surfaces hidden running descendants', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent', title: '父会话', tokens: 0, status: 'finish' },
      {
        id: 'child',
        title: '后台子任务',
        tokens: 0,
        status: 'finish',
        parent_session_id: 'parent',
        subagent_mode: 'background',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    store.set(subagentsAtom, new Map([['child', {
      invocationId: 'child',
      parentSessionId: 'parent',
      mode: 'background',
      goal: '后台分析',
      status: 'awaiting_subagents',
    }]]))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const child = host.querySelector('[data-testid="session-child"]')
    expect(child?.querySelector('[aria-label="Agent 正在运行"]')).not.toBeNull()
    expect(child?.textContent).not.toContain('运行中')
    expect(host.querySelector('[data-testid="session-parent"] [aria-label="子 Agent 正在运行"]')).toBeNull()

    const collapse = host.querySelector<HTMLButtonElement>(
      '[data-testid="session-parent"] [aria-label="收起子会话"]',
    )
    await act(async () => collapse?.click())

    const parent = host.querySelector('[data-testid="session-parent"]')
    expect(host.querySelector('[data-testid="session-child"]')).toBeNull()
    const childWait = parent?.querySelector('[aria-label="子 Agent 正在等待子任务"]')
    expect(childWait?.querySelectorAll('.agent-activity-wave > span')).toHaveLength(3)

    await act(async () => root.unmount())
    host.remove()
  })

  it('renders a completed Child like an ordinary unread Session without a status subtitle', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent-complete', title: '父会话', tokens: 0, status: 'finish' },
      {
        id: 'child-complete',
        title: '已结束的子任务',
        tokens: 0,
        status: 'completed',
        parent_session_id: 'parent-complete',
        subagent_mode: 'background',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    store.set(subagentsAtom, new Map([['child-complete', {
      invocationId: 'child-complete',
      parentSessionId: 'parent-complete',
      mode: 'background',
      goal: '后台分析',
      status: 'completed',
    }]]))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const child = host.querySelector('[data-testid="session-child-complete"]')
    expect(child?.querySelector('[aria-label="有新完成内容"]')).not.toBeNull()
    expect(child?.textContent).not.toContain('已完成')

    const collapse = host.querySelector<HTMLButtonElement>(
      '[data-testid="session-parent-complete"] [aria-label="收起子会话"]',
    )
    await act(async () => collapse?.click())

    const parent = host.querySelector('[data-testid="session-parent-complete"]')
    expect(parent?.querySelector('[aria-label="子 Agent 有新完成内容"]')).not.toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('surfaces a failed background Child beside the collapsed child count', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent-failed', title: '父会话', tokens: 0, status: 'finish' },
      {
        id: 'child-failed',
        title: '失败的子任务',
        tokens: 0,
        status: 'completed',
        turn_status: 'failed',
        parent_session_id: 'parent-failed',
        subagent_mode: 'background',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const child = host.querySelector('[data-testid="session-child-failed"]')
    expect(child?.querySelector('[aria-label="Agent 执行失败"]')).not.toBeNull()
    expect(child?.querySelector('[aria-label="有新完成内容"]')).toBeNull()

    const collapse = host.querySelector<HTMLButtonElement>(
      '[data-testid="session-parent-failed"] [aria-label="收起子会话"]',
    )
    await act(async () => collapse?.click())

    const failure = host.querySelector(
      '[data-testid="session-parent-failed"] [aria-label="子 Agent 执行失败"]',
    )
    expect(failure?.className).toContain('text-status-error')

    await act(async () => root.unmount())
    host.remove()
  })

  it('maps a Child human wait to the ordinary pending-interaction icon', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent-wait', title: '父会话', tokens: 0, status: 'finish' },
      {
        id: 'child-wait',
        title: '等待回复的子任务',
        tokens: 0,
        status: 'finish',
        parent_session_id: 'parent-wait',
        subagent_mode: 'background',
      },
      {
        id: 'child-wait-sibling-running',
        title: '运行中的兄弟子任务',
        tokens: 0,
        status: 'running',
        parent_session_id: 'parent-wait',
        subagent_mode: 'background',
      },
      {
        id: 'child-wait-sibling-failed',
        title: '失败的兄弟子任务',
        tokens: 0,
        status: 'completed',
        turn_status: 'failed',
        parent_session_id: 'parent-wait',
        subagent_mode: 'background',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    store.set(subagentsAtom, new Map([['child-wait', {
      invocationId: 'child-wait',
      parentSessionId: 'parent-wait',
      mode: 'background',
      goal: '后台分析',
      status: 'awaiting_human',
    }]]))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const child = host.querySelector('[data-testid="session-child-wait"]')
    expect(child?.querySelector('[aria-label="等待你的回答"]')).not.toBeNull()
    expect(child?.querySelector('[aria-label="Agent 正在运行"]')).toBeNull()

    const collapse = host.querySelector<HTMLButtonElement>(
      '[data-testid="session-parent-wait"] [aria-label="收起子会话"]',
    )
    await act(async () => collapse?.click())

    const parent = host.querySelector('[data-testid="session-parent-wait"]')
    expect(host.querySelector('[data-testid="session-child-wait"]')).toBeNull()
    expect(parent?.querySelector('[aria-label="子 Agent：等待你的回答"]')).not.toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('restores the exact Child permission wait without a live lifecycle event', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent-permission', title: '父会话', tokens: 0, status: 'finish' },
      {
        id: 'child-permission',
        title: '等待审批的子任务',
        tokens: 0,
        status: 'awaiting',
        turn_status: 'awaiting_permission',
        parent_session_id: 'parent-permission',
        subagent_mode: 'background',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const child = host.querySelector('[data-testid="session-child-permission"]')
    expect(child?.querySelector('[aria-label="等待工具审批"]')).not.toBeNull()
    expect(child?.querySelector('[aria-label="Agent 正在运行"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('does not infer a Child interaction from the coarse awaiting projection', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent-coarse', title: '父会话', tokens: 0, status: 'finish' },
      {
        id: 'child-coarse',
        title: '缺少精确状态的子任务',
        tokens: 0,
        status: 'awaiting',
        parent_session_id: 'parent-coarse',
        subagent_mode: 'background',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const child = host.querySelector('[data-testid="session-child-coarse"]')
    expect(child?.querySelector('[aria-label="待回答"]')).toBeNull()
    expect(child?.querySelector('[aria-label="等待你的回答"]')).toBeNull()
    expect(child?.querySelector('[aria-label="等待工具审批"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('lets a live exact Child status override stale execution projections', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent-live', title: '父会话', tokens: 0, status: 'finish' },
      {
        id: 'child-live',
        title: '实时状态子任务',
        tokens: 0,
        status: 'running',
        turn_status: 'completed',
        parent_session_id: 'parent-live',
        subagent_mode: 'background',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    store.set(subagentsAtom, new Map([['child-live', {
      invocationId: 'child-live',
      parentSessionId: 'parent-live',
      mode: 'background',
      goal: '等待审批',
      status: 'awaiting_permission',
    }]]))

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const child = host.querySelector('[data-testid="session-child-live"]')
    expect(child?.querySelector('[aria-label="等待工具审批"]')).not.toBeNull()
    expect(child?.querySelector('[aria-label="Agent 正在运行"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })
})

/**
 * Unread marks versus navigation: activeSessionId is independent of nav. Selecting Schedules
 * or Assets changes only the center pane and leaves the prior session active. If it completes,
 * the unread mark must still appear so users waiting elsewhere can see the completion signal.
 */
describe('SidebarContainer unread ✓ vs. the nav the user is on', () => {
  it('shows the ✓ on the active session once the user left Home nav', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'sess-a', title: '会话 A', tokens: 0, status: 'completed' },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    // The user asked in A, making it active, then switched to Schedules to await the result.
    store.set(activeSessionIdAtom, 'sess-a')
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, lastNav: NavKey.Schedules },
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const row = host.querySelector('[data-testid="session-sess-a"]')
    expect(row?.querySelector('[aria-label="有新完成内容"]')).not.toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('hides the ✓ on the session actually on screen (Home nav)', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'sess-home', title: '会话 A', tokens: 0, status: 'completed' },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    store.set(activeSessionIdAtom, 'sess-home')
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, lastNav: NavKey.Home },
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    const row = host.querySelector('[data-testid="session-sess-home"]')
    expect(row?.querySelector('[aria-label="有新完成内容"]')).toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })

  it('rolls a finished Background child up to its parent on a non-Home nav', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const store = createStore()
    setDaemonSessions(store, [
      { id: 'parent-bg', title: '父会话', tokens: 0, status: 'finish' },
      {
        id: 'child-bg',
        title: '后台子任务',
        tokens: 0,
        status: 'completed',
        parent_session_id: 'parent-bg',
        subagent_mode: 'background',
      },
    ])
    await store.set(hydrateSessionsFromDaemonAtom)
    // The user last opened this background child session and has since switched to Schedules.
    store.set(activeSessionIdAtom, 'child-bg')
    store.set(settingsAtom, {
      ...DEFAULT_SETTINGS,
      ui: { ...DEFAULT_SETTINGS.ui, lastNav: NavKey.Schedules },
    })

    await act(async () => {
      root.render(
        <Provider store={store}>
          <SidebarContainer />
        </Provider>,
      )
    })

    // completed is not prominent and does not project onto the parent row. It appears in the child
    // count button after collapsing children, so collapse before asserting.
    const collapse = host.querySelector<HTMLButtonElement>(
      '[data-testid="session-parent-bg"] [aria-label="收起子会话"]',
    )
    await act(async () => collapse?.click())

    const parent = host.querySelector('[data-testid="session-parent-bg"]')
    expect(parent?.querySelector('[aria-label="子 Agent 有新完成内容"]')).not.toBeNull()

    await act(async () => root.unmount())
    host.remove()
  })
})
