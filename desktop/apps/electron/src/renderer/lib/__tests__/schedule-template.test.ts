/**
 * Tests for lib/scheduleTemplate.ts — Doubao-style template segments (description/name fields and frequency widget).
 */
import { describe, it, expect } from 'bun:test'
import { buildScheduleTemplateSegments, ScheduleTemplateMode } from '../scheduleTemplate'
import { segmentsToText } from '@/components/composer/segments'
import { ScheduleType, type Schedule } from '../schedule'
import { i18n } from '../i18n'

const mkSchedule = (o: Partial<Schedule>): Schedule => ({
  id: 's1',
  name: '飞书日报生成',
  type: ScheduleType.NaturalLanguage,
  desc: '每天早上汇总当日数据生成日报',
  skills: [],
  cron: '0 0 9 * * *',
  paused: false,
  running: false,
  lastRun: '',
  nextRun: '',
  created: '',
  stats: {
    '7d': { successRate: 1, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 },
    '30d': { successRate: 1, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 },
    all: { successRate: 1, runs: 0, avgTok: 0, avgSec: 0, totalTok: 0 },
  },
  runs: [],
  ...o,
})

describe('buildScheduleTemplateSegments', () => {
  it('create: 空描述 field(带占位) + 空名称槽 + 默认频率 widget;聚焦描述 field', () => {
    const { segments, focusFieldId } = buildScheduleTemplateSegments({ mode: ScheduleTemplateMode.Create })
    expect(focusFieldId).toBe('sched-desc')
    const field = segments.find((s) => s.type === 'field')
    expect(field).toMatchObject({ type: 'field', id: 'sched-desc', value: '' })
    expect(segments.find((s) => s.type === 'field' && s.id === 'sched-name')).toMatchObject({ id: 'sched-name', value: '' })
    expect(segments.find((s) => s.type === 'widget' && s.kind === 'sched-freq')).toMatchObject({ value: '0 0 9 * * *', flat: '每天 09:00' })
  })

  it('create with workflow: 描述 field 预置意图文本', () => {
    const { segments } = buildScheduleTemplateSegments({
      mode: ScheduleTemplateMode.Create,
      workflow: { id: 'wf1', name: '飞书日报生成器' },
    })
    const field = segments.find((s) => s.type === 'field')
    expect(field).toMatchObject({ type: 'field', value: '运行工作流「飞书日报生成器」' })
  })

  it('edit: 回填名称/频率/描述', () => {
    const { segments } = buildScheduleTemplateSegments({
      mode: ScheduleTemplateMode.Edit,
      schedule: mkSchedule({ name: '周报汇总', cron: '0 0 17 * * 5', desc: '每周五汇总' }),
    })
    expect(segments.find((s) => s.type === 'field' && s.id === 'sched-desc')).toMatchObject({ value: '每周五汇总' })
    expect(segments.find((s) => s.type === 'field' && s.id === 'sched-name')).toMatchObject({ id: 'sched-name', value: '周报汇总' })
    expect(segments.find((s) => s.type === 'widget' && s.kind === 'sched-freq')).toMatchObject({ value: '0 0 17 * * 5', flat: '每周五 17:00' })
  })

  it('发送扁平化:field/widget → 文本,拼成完整指令句', () => {
    const { segments } = buildScheduleTemplateSegments({
      mode: ScheduleTemplateMode.Edit,
      schedule: mkSchedule({ name: '日报', cron: '0 0 9 * * *', desc: '汇总数据' }),
    })
    const text = segmentsToText(segments)
    expect(text).toContain('汇总数据')
    expect(text).toContain('命名为: 日报')
    expect(text).toContain('调度频率 每天 09:00')
  })
})

describe('从工作流发起时的标点', () => {
  // The runWorkflow intent is immediately followed by nameLead (", named: "). If both sides
  // include a comma, the composed text contains a visible double comma as soon as scheduling opens.
  const flatten = async (lng: string) => {
    await i18n.changeLanguage(lng)
    const { segments } = buildScheduleTemplateSegments({
      mode: ScheduleTemplateMode.Create,
      workflow: { id: 'wf1', name: 'Count Common Han Characters' },
    })
    return segmentsToText(segments)
  }

  it('zh: 描述与名称之间只有一个逗号', async () => {
    try {
      expect(await flatten('zh')).toBe(
        '帮我创建一个定时任务，内容: 运行工作流「Count Common Han Characters」，命名为: ，调度频率 每天 09:00。',
      )
    } finally {
      await i18n.changeLanguage('zh')
    }
  })

  it('en: 描述与名称之间只有一个逗号', async () => {
    try {
      expect(await flatten('en')).toBe(
        'Help me create a scheduled task. Task: Run workflow “Count Common Han Characters”, name it: , schedule: Daily at 09:00.',
      )
    } finally {
      await i18n.changeLanguage('zh')
    }
  })
})

describe('频率 widget 的 flat 值', () => {
  // flat is the value sent **on the wire** unchanged by segmentsToBlocks, while the widget
  // renders through t(). Hard-coded Chinese would show English on screen but send Chinese to
  // the daemon. This appears only before the user edits frequency, because onChange rewrites flat through t().
  it('跟随界面语言,而不是写死中文', async () => {
    await i18n.changeLanguage('en')
    try {
      const { segments } = buildScheduleTemplateSegments({ mode: ScheduleTemplateMode.Create })
      const widget = segments.find((s) => s.type === 'widget' && s.kind === 'sched-freq')
      expect(widget).toMatchObject({ value: '0 0 9 * * *', flat: 'Daily at 09:00' })
    } finally {
      await i18n.changeLanguage('zh')
    }
  })
})
