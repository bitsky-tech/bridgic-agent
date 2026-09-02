/**
 * buildSlashRows derivation tests: group order, filtering, per-group caps, and overflow placement.
 *
 * The key contract is per-group capping with overflow attached to the last row. SlashMenu renders
 * "N more" below that row; attaching it elsewhere silently moves the hint to the group top.
 */
import { describe, expect, it } from 'bun:test'
import { buildSlashRows, SlashGroup, SlashRowKind, type SlashRowSources } from '../slashRows'

/** Create n skills named `skill-1..n` with unique skill_id values. */
function makeSkills(n: number, prefix = 'skill'): SlashRowSources['skills'] {
  return Array.from({ length: n }, (_, i) => ({
    skill_id: i + 1,
    name: `${prefix}-${i + 1}`,
    description: `desc-${i + 1}`,
  }))
}

function sources(over: Partial<SlashRowSources> = {}): SlashRowSources {
  return { skills: [], workflows: [], schedules: [], filter: '', ...over }
}

describe('buildSlashRows — 分组与顺序', () => {
  it('无过滤时四组按 命令 → 技能 → 工作流 → 调度 排列,同组行连续', () => {
    const rows = buildSlashRows(
      sources({
        skills: makeSkills(2),
        workflows: [{ id: 'wf-1', name: '工作流甲', desc: 'w' }],
        schedules: [{ id: 'sc-1', name: '调度甲', desc: 's' }],
      }),
    )
    // Contiguous groups mean the deduplicated group sequence equals the group count; SlashMenu derives headings from transitions.
    const groupRuns = rows.map((r) => r.group).filter((g, i, a) => g !== a[i - 1])
    expect(groupRuns).toEqual([
      SlashGroup.Command,
      SlashGroup.Skill,
      SlashGroup.Workflow,
      SlashGroup.Schedule,
    ])
  })

  it('空组不产出任何行', () => {
    const rows = buildSlashRows(sources({ skills: makeSkills(1) }))
    expect(rows.some((r) => r.group === SlashGroup.Workflow)).toBe(false)
    expect(rows.some((r) => r.group === SlashGroup.Schedule)).toBe(false)
  })

  it('技能行的 id 取 skill_id 而非 name —— 同名技能不冲突', () => {
    const rows = buildSlashRows(
      sources({
        skills: [
          { skill_id: 7, name: '同名', description: null },
          { skill_id: 9, name: '同名', description: null },
        ],
      }),
    )
    const skillRows = rows.filter((r) => r.group === SlashGroup.Skill)
    expect(skillRows.map((r) => r.id)).toEqual(['7', '9'])
  })

  it('调度行明确表示立即执行一次', () => {
    const rows = buildSlashRows(sources({
      schedules: [{ id: 'sched-1', name: '每日汇总', desc: '生成汇总报告' }],
    }))
    const schedule = rows.find((row) => row.kind === SlashRowKind.Schedule)

    expect(schedule?.description).toBe('立即执行一次 · 生成汇总报告')
  })
})

describe('buildSlashRows — 每组封顶与溢出', () => {
  it('技能不超过 10 条时全列,且无 overflow', () => {
    const rows = buildSlashRows(sources({ skills: makeSkills(10) }))
    const skillRows = rows.filter((r) => r.group === SlashGroup.Skill)
    expect(skillRows).toHaveLength(10)
    expect(skillRows.every((r) => r.kind !== SlashRowKind.Command && r.overflow === undefined)).toBe(true)
  })

  it('技能超过 10 条时截到 10 条,overflow 落在该组末行且等于被隐藏条数', () => {
    const rows = buildSlashRows(sources({ skills: makeSkills(25) }))
    const skillRows = rows.filter((r) => r.group === SlashGroup.Skill)
    expect(skillRows).toHaveLength(10)

    const last = skillRows[skillRows.length - 1]!
    expect(last.kind !== SlashRowKind.Command && last.overflow).toBe(15)

    // The first and other non-final rows carry no overflow; render the hint once at the group end.
    const nonLast = skillRows.slice(0, -1)
    expect(nonLast.every((r) => r.kind !== SlashRowKind.Command && r.overflow === undefined)).toBe(true)
  })

  it('恰好 11 条时 overflow 为 1', () => {
    const rows = buildSlashRows(sources({ skills: makeSkills(11) }))
    const skillRows = rows.filter((r) => r.group === SlashGroup.Skill)
    const last = skillRows[skillRows.length - 1]!
    expect(last.kind !== SlashRowKind.Command && last.overflow).toBe(1)
  })

  it('封顶按组独立结算 —— 技能溢出不影响工作流', () => {
    const rows = buildSlashRows(
      sources({
        skills: makeSkills(12),
        workflows: Array.from({ length: 3 }, (_, i) => ({
          id: `wf-${i}`,
          name: `工作流-${i}`,
          desc: null,
        })),
      }),
    )
    expect(rows.filter((r) => r.group === SlashGroup.Skill)).toHaveLength(10)
    const wfRows = rows.filter((r) => r.group === SlashGroup.Workflow)
    expect(wfRows).toHaveLength(3)
    expect(wfRows.every((r) => r.kind !== SlashRowKind.Command && r.overflow === undefined)).toBe(true)
  })

  it('命令组不封顶也不带 overflow', () => {
    const rows = buildSlashRows(sources())
    const cmdRows = rows.filter((r) => r.group === SlashGroup.Command)
    expect(cmdRows.length).toBeGreaterThan(0)
    expect(cmdRows.every((r) => r.kind === SlashRowKind.Command)).toBe(true)
  })

  it('特殊模式从命令组移除 /help，其他命令保持不变', () => {
    const normalCommands = buildSlashRows(sources()).filter((r) => r.kind === SlashRowKind.Command)
    const specialCommands = buildSlashRows(sources({ includeHelp: false })).filter(
      (r) => r.kind === SlashRowKind.Command,
    )

    expect(normalCommands.some((r) => r.id === 'help')).toBe(true)
    expect(specialCommands.some((r) => r.id === 'help')).toBe(false)
    expect(specialCommands.map((r) => r.id)).toEqual(
      normalCommands.filter((r) => r.id !== 'help').map((r) => r.id),
    )
  })
})

describe('buildSlashRows — 过滤', () => {
  it('filter 先收窄再封顶 —— 过滤后不足 10 条则无 overflow', () => {
    // If only skill-7 matches among 25 skills, filtering leaves one and must not report 24 more.
    const rows = buildSlashRows(sources({ skills: makeSkills(25), filter: 'skill-7' }))
    const skillRows = rows.filter((r) => r.group === SlashGroup.Skill)
    expect(skillRows).toHaveLength(1)
    expect(skillRows[0]!.kind !== SlashRowKind.Command && skillRows[0]!.overflow).toBe(undefined)
  })

  it('filter 大小写不敏感', () => {
    const rows = buildSlashRows(sources({ skills: makeSkills(3, 'Alpha'), filter: 'ALPHA' }))
    expect(rows.filter((r) => r.group === SlashGroup.Skill)).toHaveLength(3)
  })

  it('工作流同时按 name 与 id 过滤(技能只按 name)', () => {
    const workflows = [
      { id: 'deploy-prod', name: '甲', desc: null },
      { id: 'wf-2', name: '乙', desc: null },
    ]
    const byId = buildSlashRows(sources({ workflows, filter: 'deploy' }))
    expect(byId.filter((r) => r.group === SlashGroup.Workflow)).toHaveLength(1)

    const byName = buildSlashRows(sources({ workflows, filter: '乙' }))
    expect(byName.filter((r) => r.group === SlashGroup.Workflow)).toHaveLength(1)
  })

  it('过滤命中为空的组整体消失', () => {
    const rows = buildSlashRows(sources({ skills: makeSkills(5), filter: '不存在的关键字' }))
    expect(rows.filter((r) => r.group === SlashGroup.Skill)).toHaveLength(0)
  })
})
