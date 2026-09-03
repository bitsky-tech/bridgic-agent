import { afterAll, afterEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DEFAULT_SETTINGS } from '@app/shared/types'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const testWindow = window as unknown as { api?: Record<string, unknown> }
testWindow.api = {
  ...testWindow.api,
  settings: {
    get: async () => DEFAULT_SETTINGS,
    set: async () => {},
  },
}

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { BackendState } = await import('../../../../main/python-client/types')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { activeModalAtom } = await import('@/atoms/amphi')
const {
  activeSessionIdAtom,
  pendingComposerInsertsAtom,
  pendingComposerSeedAtom,
} = await import('@/atoms/sessions')
const { WorkflowResultsPanel } = await import('../WorkflowResultsPanel')
const { ScheduleWorkbenchPanel } = await import('../ScheduleWorkbenchPanel')

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' },
  })
}

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
      runtimeFile: null,
    },
    lastError: null,
    compatibility: null,
  } as never)
  return store
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

describe('WorkflowResultsPanel', () => {
  it('separates Session/all results, filters failed runs and references terminal results in place', async () => {
    const store = readyStore()
    store.set(activeSessionIdAtom, 'session-results')
    const completed = {
      id: 'run-completed',
      workflow_id: 'workflow-completed',
      workflow_name: '本会话目录统计',
      source_session_id: 'session-results',
      workflow_input: { text: '统计当前目录', blocks: [] },
      status: 'completed',
      created_at: '2026-08-13T10:00:00Z',
      finished_at: '2026-08-13T10:01:00Z',
    }
    const failed = {
      id: 'run-failed',
      workflow_id: 'workflow-failed',
      workflow_name: '全局失败记录',
      source_session_id: 'another-session',
      workflow_input: { text: '执行高风险任务', blocks: [] },
      status: 'failed',
      created_at: '2026-08-13T11:00:00Z',
      finished_at: '2026-08-13T11:00:30Z',
    }
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const request = new URL(String(input))
      if (request.pathname !== '/workflow-runs') return jsonResponse({})
      return jsonResponse(request.searchParams.get('session_id') ? [completed] : [completed, failed])
    }) as never

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <Provider store={store}>
          <WorkflowResultsPanel />
        </Provider>,
      )
    })
    await flushEffects()

    expect(host.querySelector('[data-testid="workflow-result-run-completed"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="workflow-result-run-failed"]')).toBeNull()

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-result-reference-run-completed"]',
      )?.click()
    })
    expect(store.get(activeSessionIdAtom)).toBe('session-results')
    expect(store.get(pendingComposerInsertsAtom).at(-1)?.[0]).toMatchObject({
      type: 'mention',
      id: 'run-completed',
      group: 'WorkflowRun',
    })

    const scopes = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    await act(async () => scopes[1]?.click())
    expect(host.querySelector('[data-testid="workflow-result-run-failed"]')).not.toBeNull()

    const status = host.querySelector<HTMLSelectElement>('[data-testid="workflow-results-status"]')
    await act(async () => {
      if (!status) return
      status.value = 'failed'
      status.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(host.querySelector('[data-testid="workflow-result-run-completed"]')).toBeNull()
    expect(host.querySelector('[data-testid="workflow-result-run-failed"]')).not.toBeNull()

    await act(async () => {
      host.querySelector<HTMLButtonElement>(
        '[data-testid="workflow-result-reference-run-failed"]',
      )?.click()
    })
    expect(store.get(pendingComposerInsertsAtom).at(-1)?.[0]).toMatchObject({
      type: 'mention',
      id: 'run-failed',
      group: 'WorkflowRun',
    })

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="workflow-result-view-run-failed"]')?.click()
    })
    expect(store.get(activeModalAtom)).toMatchObject({ runId: 'run-failed' })

    await act(async () => root.unmount())
  })
})

describe('ScheduleWorkbenchPanel', () => {
  it('filters schedule cards and inserts create into the current Session composer', async () => {
    const store = readyStore()
    store.set(activeSessionIdAtom, 'session-schedules')
    const activeSchedule = {
      id: 'schedule-active',
      name: '每日目录统计',
      desc: '每天统计工作目录',
      cron: '0 0 9 * * *',
      enabled: true,
      status: 'active',
      running: false,
      // The workbench intentionally ignores approval counts and remains a
      // schedule inventory, so this should still render as an active schedule.
      needs_action: 2,
      refs: [],
      last_run_at: null,
      next_run_at: '2026-08-14T09:00:00Z',
      created_at: '2026-08-13T09:00:00Z',
    }
    const pausedSchedule = {
      ...activeSchedule,
      id: 'schedule-paused',
      name: '暂停的周报',
      enabled: false,
      status: 'paused',
      next_run_at: null,
    }
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      const request = new URL(String(input))
      if (request.pathname === '/schedules') return jsonResponse([activeSchedule, pausedSchedule])
      return jsonResponse({})
    }) as never

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <Provider store={store}>
          <ScheduleWorkbenchPanel />
        </Provider>,
      )
    })
    await flushEffects()

    expect(host.querySelector('[data-testid="schedule-workbench-schedule-active"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="schedule-workbench-schedule-paused"]')).not.toBeNull()
    expect(host.querySelector(
      '[data-testid="schedule-workbench-schedule-active"] [data-schedule-status="active"]',
    )).not.toBeNull()

    const filters = host.querySelectorAll<HTMLButtonElement>('[role="tab"]')
    await act(async () => filters[1]?.click())
    expect(host.querySelector('[data-testid="schedule-workbench-schedule-active"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="schedule-workbench-schedule-paused"]')).toBeNull()

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="schedule-workbench-create"]')?.click()
    })
    expect(store.get(activeSessionIdAtom)).toBe('session-schedules')
    expect(store.get(pendingComposerSeedAtom)).toBeNull()
    expect(store.get(pendingComposerInsertsAtom)).toHaveLength(1)

    await act(async () => root.unmount())
  })
})
