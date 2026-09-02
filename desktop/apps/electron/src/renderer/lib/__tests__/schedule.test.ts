/**
 * Tests for lib/schedule.ts — getScheduleStatus derivation and getPendingRun.
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
  it('按 needsAction、running、paused、active 的优先级派生', () => {
    expect(getScheduleStatus(mk({ needsAction: 1, running: true, paused: true }))).toBe(
      ScheduleStatus.NeedsAction,
    )
    expect(getScheduleStatus(mk({ running: true, paused: true }))).toBe(ScheduleStatus.Running)
    expect(getScheduleStatus(mk({ paused: true }))).toBe(ScheduleStatus.Paused)
    expect(getScheduleStatus(mk({}))).toBe(ScheduleStatus.Active)
  })
})

describe('getPendingRun', () => {
  it('只返回 needsAction 的运行', () => {
    const s = mk({ needsAction: 1, runs: [pendingRunRow] })
    expect(getPendingRun(s)?.sessionId).toBe('sess-1')
    expect(getPendingRun(mk({}))).toBeUndefined()
  })
})

describe('shouldRefreshSchedulesOnCompletion', () => {
  it('只在存在待审批或运行中的计划时重拉', () => {
    expect(shouldRefreshSchedulesOnCompletion([mk({ needsAction: 1 })])).toBe(true)
    expect(shouldRefreshSchedulesOnCompletion([mk({ running: true })])).toBe(true)
    expect(shouldRefreshSchedulesOnCompletion([mk({}), mk({ id: 's2', paused: true })])).toBe(false)
    expect(shouldRefreshSchedulesOnCompletion([])).toBe(false)
  })
})
