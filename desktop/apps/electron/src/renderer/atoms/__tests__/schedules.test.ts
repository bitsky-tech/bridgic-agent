/**
 * Tests for the schedule backend→frontend mapping + status derivations
 * (lib/schedule.ts). The atoms in atoms/schedules.ts are thin API wrappers over
 * these mappers + the daemon REST (covered by backend pytest + manual e2e), so
 * the deterministic logic worth unit-testing lives in the pure mappers. The exception is
 * the toggle gate in `toggleScheduleAtom`, which once silently blocked pausing active runs.
 */
import { describe, it, expect, mock, afterEach } from 'bun:test'
import { createStore } from 'jotai'
import {
  detailToSchedule,
  formatWhen,
  getPendingRun,
  getScheduleStatus,
  RunStatus,
  ScheduleStatus,
  summaryToSchedule,
} from '@/lib/schedule'
import type { ScheduleDetail, ScheduleSummary } from '@/lib/amphiClient'
import { hydrateSchedulesAtom, toggleScheduleAtom } from '../schedules'
import { backendSnapshotAtom } from '../backend'
import { BackendState } from '../../../main/python-client/types'

// toggleScheduleAtom tests replace globalThis.fetch; restore it to prevent mock leakage.
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const summary = (over: Partial<ScheduleSummary> = {}): ScheduleSummary => ({
  id: 'sched_1',
  name: '竞品监控',
  desc: '每天9点抓价格',
  cron: '0 0 9 * * *',
  enabled: true,
  status: 'active',
  running: false,
  needs_action: 0,
  refs: ['browser'],
  last_run_at: null,
  next_run_at: '2026-07-19T09:00:00',
  created_at: '2026-07-18T10:00:00',
  ...over,
})

describe('summaryToSchedule', () => {
  it('maps an enabled active schedule', () => {
    const s = summaryToSchedule(summary())
    expect(s.paused).toBe(false)
    expect(s.running).toBe(false)
    expect(s.skills).toEqual(['browser'])
    expect(s.nextRun).toBe('2026-07-19\u00A009:00:00')
    expect(s.lastRun).toBe('—')
    expect(getScheduleStatus(s)).toBe(ScheduleStatus.Active)
  })

  it('disabled → paused + nextRun 已暂停', () => {
    const s = summaryToSchedule(summary({ enabled: false, status: 'paused' }))
    expect(s.paused).toBe(true)
    expect(s.nextRun).toBe('已暂停')
    expect(getScheduleStatus(s)).toBe(ScheduleStatus.Paused)
  })

  it('running status → running', () => {
    const s = summaryToSchedule(summary({ status: 'running', running: true }))
    expect(s.running).toBe(true)
    expect(getScheduleStatus(s)).toBe(ScheduleStatus.Running)
  })

  it('needs_action → needsAction highest-priority status', () => {
    const s = summaryToSchedule(summary({ needs_action: 2, status: 'needsAction' }))
    expect(s.needsAction).toBe(2)
    expect(getScheduleStatus(s)).toBe(ScheduleStatus.NeedsAction)
  })

  it('needsAction 盖住 status 时,running 仍从独立字段读到', () => {
    // Regression: running once derived from `status === 'running'`. status is an exclusive,
    // prioritized label, so a schedule with pending approval and active runs reports only
    // needsAction. That incorrectly erased 17 active runs and hid the stop-all action.
    const s = summaryToSchedule(summary({ status: 'needsAction', needs_action: 10, running: true }))
    expect(s.running).toBe(true)
    // Display status still prioritizes needsAction; display and activity remain independent.
    expect(getScheduleStatus(s)).toBe(ScheduleStatus.NeedsAction)
  })
})

describe('detailToSchedule', () => {
  it('maps runs; running → Running, awaiting → NeedsAction, finish → neutral Finished', () => {
    const detail: ScheduleDetail = {
      ...summary({ needs_action: 1, status: 'needsAction' }),
      runs: [
        // running=true wins even when the session status is the default finish state.
        { session_id: 's_run', status: 'finish', running: true, can_continue: false, created_at: '2026-07-20T09:00:00', last_answer: null },
        { session_id: 's_await', status: 'awaiting', running: false, can_continue: false, created_at: '2026-07-19T09:00:00', last_answer: null },
        { session_id: 's_done', status: 'finish', running: false, can_continue: true, created_at: '2026-07-18T09:00:00', last_answer: 'ok' },
      ],
    }
    const s = detailToSchedule(detail)
    expect(s.runs).toHaveLength(3)
    expect(s.runs[0]?.status).toBe(RunStatus.Running)
    expect(s.runs[1]?.status).toBe(RunStatus.NeedsAction)
    // The backend cannot distinguish success from failure, so finish maps to neutral Finished, never Success.
    expect(s.runs[2]?.status).toBe(RunStatus.Finished)
    expect(s.runs[2]?.canContinue).toBe(true)
    expect(getPendingRun(s)?.sessionId).toBe('s_await')
  })
})

describe('formatWhen', () => {
  it('ISO → "YYYY-MM-DD HH:mm"; null → "—"', () => {
    expect(formatWhen('2026-07-19T09:00:00')).toBe('2026-07-19\u00A009:00:00')
    expect(formatWhen(null)).toBe('—')
  })
})

describe('toggleScheduleAtom', () => {
  /** Build a store hydrated with the schedule and capture the emitted PATCH body. */
  async function setup(over: Partial<ScheduleSummary>) {
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
    const patches: unknown[] = []
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        patches.push(JSON.parse(String(init.body)))
        return json(summary(over))
      }
      return json([summary(over)])
    }) as never
    await store.set(hydrateSchedulesAtom)
    return { store, patches }
  }

  it('运行中的任务也能暂停 —— 暂停只关未来触发,在飞那次交给 kill', async () => {
    // Regression: the guard once returned on `|| target.running`, while the list rendered Running
    // as Active. Users saw a normal Pause button that neither sent a request nor showed a toast.
    const { store, patches } = await setup({ status: 'running', enabled: true })
    await store.set(toggleScheduleAtom, 'sched_1')
    expect(patches).toEqual([{ enabled: false }])
  })

  it('已暂停 → 恢复(enabled=true)', async () => {
    const { store, patches } = await setup({ status: 'paused', enabled: false })
    await store.set(toggleScheduleAtom, 'sched_1')
    expect(patches).toEqual([{ enabled: true }])
  })
})
