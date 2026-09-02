/**
 * Regression: Stop This Run in history must stop only that run.
 *
 * Each row once called schedule-level `POST /schedules/{id}/kill`; backend `_scheduler.kill`
 * cancels **all** active runs for that schedule. Under overlap, stopping one history row also
 * killed others. The correct run-level endpoint is `POST /sessions/{sessionId}/stop`, whose
 * `_invocation.cancel` affects only that Session tree and its child agents.
 *
 * Render with happy-dom and assert the **actual requested URL** through mocked fetch because the
 * bug was at the call site, passing schedule ID instead of the run's sessionId, beyond atom-level coverage.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RunStatus, ScheduleType, type Schedule } from '@/lib/schedule'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { backendSnapshotAtom } = await import('@/atoms/backend')
const { hydrateSchedulesAtom } = await import('@/atoms/schedules')
const { BackendState } = await import('../../../../main/python-client/types')
const { ScheduleDetail } = await import('../ScheduleDetail')

const EMPTY_KPI = { successRate: 0, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 }

/** Schedule with two active runs under overlap, which starts on time without waiting for the prior run. */
const schedule: Schedule = {
  id: 'sched_1',
  name: '测试子Agent调度',
  type: ScheduleType.NaturalLanguage,
  desc: '起两个子 Agent 各 sleep 100',
  skills: [],
  cron: '0 */5 * * * *',
  paused: false,
  running: true,
  lastRun: '2026-07-24 11:30:00',
  nextRun: '2026-07-24 11:35:00',
  created: '2026-07-23 11:37:05',
  stats: { '7d': EMPTY_KPI, '30d': EMPTY_KPI, all: EMPTY_KPI },
  runs: [
    { status: RunStatus.Running, canContinue: false, time: '2026-07-24 11:30:00', durationSec: 0, tokens: 0, sessionId: 'sess_b' },
    { status: RunStatus.Running, canContinue: false, time: '2026-07-24 11:25:00', durationSec: 0, tokens: 0, sessionId: 'sess_a' },
    { status: RunStatus.Finished, canContinue: false, time: '2026-07-24 11:22:00', durationSec: 0, tokens: 0, sessionId: 'sess_joining' },
    { status: RunStatus.Finished, canContinue: true, time: '2026-07-24 11:20:00', durationSec: 0, tokens: 0, sessionId: 'sess_done' },
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

/** Render the detail page and return the root plus requested pathnames. */
async function render() {
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
  const posted: string[] = []
  globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString()
    const { pathname } = new URL(url)
    if (init?.method === 'POST') posted.push(pathname)
    // Seed the list summary so atoms can find the target; killScheduleAtom checks target.running.
    const body =
      pathname === '/schedules'
        ? [{
            id: schedule.id,
            name: schedule.name,
            desc: schedule.desc,
            cron: schedule.cron,
            enabled: true,
            // status reports needsAction because pending approval wins, while running remains independently
            // true. This reproduces active runs coexisting with ten pending approvals.
            status: 'needsAction',
            running: true,
            needs_action: 10,
            refs: [],
            last_run_at: '2026-07-24T11:30:00',
            next_run_at: '2026-07-24T11:35:00',
            created_at: '2026-07-23T11:37:05',
          }]
        : { stopped: true }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }) as unknown as typeof fetch
  await store.set(hydrateSchedulesAtom)

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Provider store={store}>
        <ScheduleDetail s={schedule} />
      </Provider>,
    )
  })
  return { root, posted }
}

describe('ScheduleDetail 运行历史', () => {
  it('「停止本次运行」只停该行的 run(POST /sessions/{sessionId}/stop)', async () => {
    const { root, posted } = await render()
    const stop = document.querySelector<HTMLButtonElement>(
      '[data-testid="run-row-sess_a"] button.text-status-error',
    )
    expect(stop).not.toBeNull()

    await act(async () => {
      stop?.click()
      await Promise.resolve()
    })

    expect(posted).toContain('/sessions/sess_a/stop')
    // The other active run, sess_b, remains unaffected and no schedule-level stop is issued.
    expect(posted).not.toContain('/sessions/sess_b/stop')
    expect(posted).not.toContain('/schedules/sched_1/kill')

    await act(async () => root.unmount())
  })

  it('顶部「停止全部运行」才是 schedule 级(POST /schedules/{id}/kill)', async () => {
    const { root, posted } = await render()
    // Btn renders as <div> in Primitives.tsx, so locate the innermost node by exact text.
    const killAll = Array.from(document.querySelectorAll('div')).find(
      (el) => el.textContent?.trim() === '停止全部运行',
    ) as HTMLElement | undefined
    expect(killAll).toBeDefined()

    await act(async () => {
      killAll?.click()
      await Promise.resolve()
    })

    expect(posted).toContain('/schedules/sched_1/kill')

    await act(async () => root.unmount())
  })

  it('只有已结束的 run 才显示「继续对话」', async () => {
    const { root, posted } = await render()

    expect(document.querySelector('[data-testid="continue-run-sess_a"]')).toBeNull()
    expect(document.querySelector('[data-testid="continue-run-sess_b"]')).toBeNull()
    expect(document.querySelector('[data-testid="continue-run-sess_joining"]')).toBeNull()
    const continueDone = document.querySelector<HTMLButtonElement>(
      '[data-testid="continue-run-sess_done"]',
    )
    expect(continueDone).not.toBeNull()

    await act(async () => {
      continueDone?.click()
      await Promise.resolve()
    })

    expect(posted).toContain('/sessions/sess_done/duplicate')
    expect(posted).not.toContain('/sessions/sess_a/duplicate')
    expect(posted).not.toContain('/sessions/sess_b/duplicate')

    await act(async () => root.unmount())
  })
})
