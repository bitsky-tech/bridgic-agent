/**
 * Tests for lib/cron.ts::describeCronCN — 6-field cron → 中文人话。
 */
import { describe, it, expect } from 'bun:test'
import { buildCron, CronPeriod, describeCron, pad2, parseCronToState, type CronState } from '../cron'
import { i18n } from '../i18n'

// 中文文案的唯一来源是 zh.json —— cron.ts 里那份手抄的 33 条中文表已删除。
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
  it('每分钟 / 每分钟第 N 秒', () => {
    expect(describeCronCN('0 * * * * *')).toBe('每分钟')
    expect(describeCronCN('30 * * * * *')).toBe('每分钟的第 30 秒')
  })

  it('每小时 / 每小时第 N 分', () => {
    expect(describeCronCN('0 0 * * * *')).toBe('每小时')
    expect(describeCronCN('0 5 * * * *')).toBe('每小时的第 5 分')
  })

  it('step 语法:每秒 / 每 N 秒·分·时', () => {
    expect(describeCronCN('* * * * * *')).toBe('每秒')
    expect(describeCronCN('*/30 * * * * *')).toBe('每 30 秒')
    expect(describeCronCN('0 */5 * * * *')).toBe('每 5 分钟')
    expect(describeCronCN('0 0 */2 * * *')).toBe('每 2 小时')
  })

  it('每 N 小时带非零分钟偏移兜底返回原文,不吞 :MM', () => {
    // 回归:`0 30 */2 * * *` 在每 2 小时的第 30 分触发,描成「每 2 小时」会让人误以为整点跑。
    expect(describeCronCN('0 30 */2 * * *')).toBe('0 30 */2 * * *')
  })

  it('无法归类的语法(range/list)兜底返回原文,不误读', () => {
    // 回归:曾把工作日误读成「每周一」、每 2 小时误读成「每天 00:00」。
    expect(describeCronCN('0 0 9 * * 1-5')).toBe('0 0 9 * * 1-5')
    expect(describeCronCN('0 15,45 * * * *')).toBe('0 15,45 * * * *')
  })

  it('日/月 与 周 同时约束(cron OR 语义)兜底返回原文,不漏读周约束', () => {
    // 「N 日 或 周五」若只描成「每月 N 日」会静默丢掉周约束 —— 违反不误读不变式。
    expect(describeCronCN('0 0 9 15 * 5')).toBe('0 0 9 15 * 5')
    expect(describeCronCN('0 0 9 15 6 5')).toBe('0 0 9 15 6 5')
    expect(describeCronCN('0 0 14 1 1,4,7,10 5')).toBe('0 0 14 1 1,4,7,10 5')
  })

  it('每天 时:分', () => {
    expect(describeCronCN('0 0 9 * * *')).toBe('每天 09:00')
    expect(describeCronCN('0 30 8 * * *')).toBe('每天 08:30')
  })

  it('每周几 时:分', () => {
    expect(describeCronCN('0 0 17 * * 5')).toBe('每周五 17:00')
    expect(describeCronCN('0 0 9 * * 0')).toBe('每周日 09:00')
  })

  it('每月 N 日 时:分', () => {
    expect(describeCronCN('0 0 2 15 * *')).toBe('每月 15 日 02:00')
  })

  it('每季度(月列表) N 日 时:分', () => {
    expect(describeCronCN('0 0 14 1 1,4,7,10 *')).toBe('每季度（1月、4月、7月、10月）1 日 14:00')
  })

  it('每年 月 N 日 时:分', () => {
    expect(describeCronCN('0 0 14 1 1 *')).toBe('每年 1月1 日 14:00')
  })

  it('非 6 字段:原样 / —', () => {
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
  it('分/时/日/周/月', () => {
    expect(buildCron(ST({ period: CronPeriod.Minute, second: '30' }))).toBe('30 * * * * *')
    expect(buildCron(ST({ period: CronPeriod.Hour, minute: '5' }))).toBe('0 5 * * * *')
    expect(buildCron(ST({ period: CronPeriod.Day, hour: '9', minute: '0' }))).toBe('0 0 9 * * *')
    expect(buildCron(ST({ period: CronPeriod.Week, dayOfWeek: '5', hour: '17', minute: '0' }))).toBe('0 0 17 * * 5')
    expect(buildCron(ST({ period: CronPeriod.Month, dayOfMonth: '15', hour: '2', minute: '0' }))).toBe('0 0 2 15 * *')
  })
  it('季度展开成 4 个月列表', () => {
    expect(buildCron(ST({ period: CronPeriod.Quarter, quarterStart: '1', dayOfMonth: '1', hour: '14', minute: '0' }))).toBe('0 0 14 1 1,4,7,10 *')
  })
  it('年 / 自定义', () => {
    expect(buildCron(ST({ period: CronPeriod.Year, month: '1', dayOfMonth: '1', hour: '14', minute: '0' }))).toBe('0 0 14 1 1 *')
    expect(buildCron(ST({ period: CronPeriod.Custom, custom: '0 0 2 * * 1' }))).toBe('0 0 2 * * 1')
  })
})

describe('parseCronToState', () => {
  it('反解析各模式', () => {
    expect(parseCronToState('0 0 17 * * 5')).toMatchObject({ period: CronPeriod.Week, dayOfWeek: '5', hour: '17', minute: '0' })
    expect(parseCronToState('0 30 8 * * *')).toMatchObject({ period: CronPeriod.Day, hour: '8', minute: '30' })
    expect(parseCronToState('30 * * * * *')).toMatchObject({ period: CronPeriod.Minute, second: '30' })
    expect(parseCronToState('0 0 14 1 1,4,7,10 *')).toMatchObject({ period: CronPeriod.Quarter, quarterStart: '1', dayOfMonth: '1' })
  })
  it('非 6 字段 → custom', () => {
    expect(parseCronToState('nonsense')).toMatchObject({ period: CronPeriod.Custom })
  })
  it('round-trip 保 period(分/时/日/周/月/季/年)', () => {
    for (const period of [CronPeriod.Minute, CronPeriod.Hour, CronPeriod.Day, CronPeriod.Week, CronPeriod.Month, CronPeriod.Quarter, CronPeriod.Year]) {
      const cron = buildCron(ST({ period, hour: '3', minute: '7', second: '9', dayOfWeek: '2', dayOfMonth: '4', month: '5', quarterStart: '2' }))
      expect(parseCronToState(cron).period).toBe(period)
    }
  })
})
