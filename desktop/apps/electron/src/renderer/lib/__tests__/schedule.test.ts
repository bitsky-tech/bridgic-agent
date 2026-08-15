/**
 * Tests for lib/schedule.ts — getScheduleStatus 派生 + getPendingRun。
 */
import { describe, it, expect } from 'bun:test'
import {
  getScheduleStatus,
  getPendingRun,
  shouldRefreshSchedulesOnCompletion,
  ScheduleStatus,
  ScheduleType,
  RunStatus,
  type Schedule,
  type ScheduleRun,
} from '../schedule'

const EMPTY_STATS = {
  '7d': { successRate: 1, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 },
  '30d': { successRate: 1, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 },
  all: { successRate: 1, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 },
}

function mk(partial: Partial<Schedule>): Schedule {
  return {
    id: 's1',
    name: '任务',
    type: ScheduleType.NaturalLanguage,
    desc: '',
    skills: [],
    cron: '0 0 9 * * *',
    paused: false,
    running: false,
    lastRun: '尚未运行',
    nextRun: '按计划',
    created: '刚刚',
    stats: EMPTY_STATS,
    runs: [],
    ...partial,
  }
}

const pendingRunRow: ScheduleRun = {
  status: RunStatus.NeedsAction,
  canContinue: false,
  time: '2026-07-13 09:00',
  durationSec: 0,
  tokens: 100,
  sessionId: 'sess-1',
}

describe('getScheduleStatus', () => {
  it('needsAction 优先级最高', () => {
    expect(getScheduleStatus(mk({ needsAction: 1, running: true, paused: true }))).toBe(
      ScheduleStatus.NeedsAction,
    )
  })
  it('running 次之', () => {
    expect(getScheduleStatus(mk({ running: true, paused: true }))).toBe(ScheduleStatus.Running)
  })
  it('paused 再次', () => {
    expect(getScheduleStatus(mk({ paused: true }))).toBe(ScheduleStatus.Paused)
  })
  it('默认 active', () => {
    expect(getScheduleStatus(mk({}))).toBe(ScheduleStatus.Active)
  })
})

describe('getPendingRun', () => {
  it('取 needsAction 那次运行', () => {
    const s = mk({ needsAction: 1, runs: [pendingRunRow] })
    expect(getPendingRun(s)?.sessionId).toBe('sess-1')
  })
  it('无挂起运行时 undefined', () => {
    expect(getPendingRun(mk({}))).toBeUndefined()
  })
})

describe('shouldRefreshSchedulesOnCompletion', () => {
  it('有待审批(needsAction>0)→ 应重拉', () => {
    expect(shouldRefreshSchedulesOnCompletion([mk({ needsAction: 1 })])).toBe(true)
  })
  it('有运行中 → 应重拉(等 run 落地成 completed)', () => {
    expect(shouldRefreshSchedulesOnCompletion([mk({ running: true })])).toBe(true)
  })
  it('既无待审批也无运行中 → 不重拉(普通聊天完成不触发 listSchedules)', () => {
    expect(shouldRefreshSchedulesOnCompletion([mk({}), mk({ id: 's2', paused: true })])).toBe(false)
  })
  it('空列表 → 不重拉', () => {
    expect(shouldRefreshSchedulesOnCompletion([])).toBe(false)
  })
})
