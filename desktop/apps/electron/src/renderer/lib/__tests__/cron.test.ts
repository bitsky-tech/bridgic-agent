/**
 * Tests for lib/cron.ts::describeCronCN — six-field cron to readable Chinese.
 */
import { describe, it, expect } from 'bun:test'
import { buildCron, CronPeriod, describeCron, pad2, parseCronToState, type CronState } from '../cron'
import { i18n } from '../i18n'

// zh.json is the single source of Chinese copy; the duplicated 33-entry table was removed from cron.ts.
const describeCronCN = (cron: string): string =>
  describeCron(cron, (key, options) => String(i18n.getFixedT('zh')(key, options)))

describe('pad2', () => {
  it('两位补零', () => {
    expect(pad2(0)).toBe('00')
    expect(pad2(9)).toBe('09')
    expect(pad2(17)).toBe('17')
  })
})

describe('describeCronCN', () => {
  it('描述常用周期，并对可能误读的表达式保守回退', () => {
    expect(describeCronCN('0 * * * * *')).toBe('每分钟')
    expect(describeCronCN('30 * * * * *')).toBe('每分钟的第 30 秒')
    expect(describeCronCN('0 0 * * * *')).toBe('每小时')
    expect(describeCronCN('0 5 * * * *')).toBe('每小时的第 5 分')
    expect(describeCronCN('* * * * * *')).toBe('每秒')
    expect(describeCronCN('*/30 * * * * *')).toBe('每 30 秒')
    expect(describeCronCN('0 */5 * * * *')).toBe('每 5 分钟')
    expect(describeCronCN('0 0 */2 * * *')).toBe('每 2 小时')

    // Regression: `0 30 */2 * * *` runs at minute 30 every two hours; omitting the minute implies an on-the-hour run.
    expect(describeCronCN('0 30 */2 * * *')).toBe('0 30 */2 * * *')
    // Regression: weekdays were once read as Mondays, and every two hours as daily at midnight.
    expect(describeCronCN('0 0 9 * * 1-5')).toBe('0 0 9 * * 1-5')
    expect(describeCronCN('0 15,45 * * * *')).toBe('0 15,45 * * * *')
    // Describing "day N or Friday" as only "day N monthly" silently drops the weekday constraint.
    expect(describeCronCN('0 0 9 15 * 5')).toBe('0 0 9 15 * 5')
    expect(describeCronCN('0 0 9 15 6 5')).toBe('0 0 9 15 6 5')
    expect(describeCronCN('0 0 14 1 1,4,7,10 5')).toBe('0 0 14 1 1,4,7,10 5')

    expect(describeCronCN('0 0 9 * * *')).toBe('每天 09:00')
    expect(describeCronCN('0 30 8 * * *')).toBe('每天 08:30')
    expect(describeCronCN('0 0 17 * * 5')).toBe('每周五 17:00')
    expect(describeCronCN('0 0 9 * * 0')).toBe('每周日 09:00')
    expect(describeCronCN('0 0 2 15 * *')).toBe('每月 15 日 02:00')
    expect(describeCronCN('0 0 14 1 1,4,7,10 *')).toBe('每季度（1月、4月、7月、10月）1 日 14:00')
    expect(describeCronCN('0 0 14 1 1 *')).toBe('每年 1月1 日 14:00')
    expect(describeCronCN('abc')).toBe('abc')
    expect(describeCronCN('')).toBe('—')
  })
})

const ST = (o: Partial<CronState>): CronState => ({
  period: CronPeriod.Day,
  second: '0',
  minute: '0',
  hour: '9',
  dayOfWeek: '1',
  dayOfMonth: '1',
  month: '1',
  quarterStart: '1',
  custom: '0 0 9 * * *',
  ...o,
})

describe('buildCron', () => {
  it('构造所有内置周期和自定义表达式', () => {
    expect(buildCron(ST({ period: CronPeriod.Minute, second: '30' }))).toBe('30 * * * * *')
    expect(buildCron(ST({ period: CronPeriod.Hour, minute: '5' }))).toBe('0 5 * * * *')
    expect(buildCron(ST({ period: CronPeriod.Day, hour: '9', minute: '0' }))).toBe('0 0 9 * * *')
    expect(buildCron(ST({ period: CronPeriod.Week, dayOfWeek: '5', hour: '17', minute: '0' }))).toBe('0 0 17 * * 5')
    expect(buildCron(ST({ period: CronPeriod.Month, dayOfMonth: '15', hour: '2', minute: '0' }))).toBe('0 0 2 15 * *')
    expect(buildCron(ST({ period: CronPeriod.Quarter, quarterStart: '1', dayOfMonth: '1', hour: '14', minute: '0' }))).toBe('0 0 14 1 1,4,7,10 *')
    expect(buildCron(ST({ period: CronPeriod.Year, month: '1', dayOfMonth: '1', hour: '14', minute: '0' }))).toBe('0 0 14 1 1 *')
    expect(buildCron(ST({ period: CronPeriod.Custom, custom: '0 0 2 * * 1' }))).toBe('0 0 2 * * 1')
  })
})

describe('parseCronToState', () => {
  it('反解析、回退并保持内置周期 round-trip', () => {
    expect(parseCronToState('0 0 17 * * 5')).toMatchObject({ period: CronPeriod.Week, dayOfWeek: '5', hour: '17', minute: '0' })
    expect(parseCronToState('0 30 8 * * *')).toMatchObject({ period: CronPeriod.Day, hour: '8', minute: '30' })
    expect(parseCronToState('30 * * * * *')).toMatchObject({ period: CronPeriod.Minute, second: '30' })
    expect(parseCronToState('0 0 14 1 1,4,7,10 *')).toMatchObject({ period: CronPeriod.Quarter, quarterStart: '1', dayOfMonth: '1' })
    expect(parseCronToState('nonsense')).toMatchObject({ period: CronPeriod.Custom })
    for (const period of [CronPeriod.Minute, CronPeriod.Hour, CronPeriod.Day, CronPeriod.Week, CronPeriod.Month, CronPeriod.Quarter, CronPeriod.Year]) {
      const cron = buildCron(ST({ period, hour: '3', minute: '7', second: '9', dayOfWeek: '2', dayOfMonth: '4', month: '5', quarterStart: '2' }))
      expect(parseCronToState(cron).period).toBe(period)
    }
  })
})
