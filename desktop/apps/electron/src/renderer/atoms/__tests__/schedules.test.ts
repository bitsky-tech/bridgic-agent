/**
 * Tests for the schedule backend→frontend mapping + status derivations
 * (lib/schedule.ts). The atoms in atoms/schedules.ts are thin API wrappers over
 * these mappers + the daemon REST (covered by backend pytest + manual e2e), so
 * the deterministic logic worth unit-testing lives in the pure mappers —— 例外是
 * `toggleScheduleAtom` 的可切换门禁,它曾静默拦掉运行中任务的暂停(见底部回归)。
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

// toggleScheduleAtom 用例会覆写 globalThis.fetch;测完还原,避免 mock 泄漏到后续测试。
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
    // 回归:曾用 `status === 'running'` 派生 running。status 是互斥优先级串,一条既有
    // 挂起审批又有在飞运行的调度只会报 needsAction —— 于是「有 17 个 run 在跑」被静默
    // 抹成 running=false,详情页的「停止全部运行」入口消失。
    const s = summaryToSchedule(summary({ status: 'needsAction', needs_action: 10, running: true }))
    expect(s.running).toBe(true)
    // 展示状态仍按优先级取 needsAction —— 两者各司其职,互不覆盖。
    expect(getScheduleStatus(s)).toBe(ScheduleStatus.NeedsAction)
  })
})

describe('detailToSchedule', () => {
  it('maps runs; running → Running, awaiting → NeedsAction, finish → neutral Finished', () => {
    const detail: ScheduleDetail = {
      ...summary({ needs_action: 1, status: 'needsAction' }),
      runs: [
        // running=true 优先(即使 session 状态是 finish 默认态,也算运行中)。
        { session_id: 's_run', status: 'finish', running: true, can_continue: false, created_at: '2026-07-20T09:00:00', last_answer: null },
        { session_id: 's_await', status: 'awaiting', running: false, can_continue: false, created_at: '2026-07-19T09:00:00', last_answer: null },
        { session_id: 's_done', status: 'finish', running: false, can_continue: true, created_at: '2026-07-18T09:00:00', last_answer: 'ok' },
      ],
    }
    const s = detailToSchedule(detail)
    expect(s.runs).toHaveLength(3)
    expect(s.runs[0]?.status).toBe(RunStatus.Running)
    expect(s.runs[1]?.status).toBe(RunStatus.NeedsAction)
    // 后端无法区分成/败,finish 一律映射中性 Finished —— 绝不谎报 Success。
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
  /** 建一个已 hydrate 好该 schedule 的 store,并记录发出的 PATCH body。 */
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
    // 回归:守卫曾含 `|| target.running` 直接 return,而列表页把 Running 折叠成 Active
    // 显示,于是用户看到正常的「暂停」按钮、点了却毫无反应(不发请求也不弹 toast)。
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
