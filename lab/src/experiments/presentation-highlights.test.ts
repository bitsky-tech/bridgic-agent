import { describe, expect, test } from 'bun:test'
import { getPresentationHighlights } from './presentation-highlights'
import { getPresentationTrace } from './presentation-trace-data'

describe('presentation highlights', () => {
  test('uses recorded answers and the actual outline trigger without treating agent work as confirmation', () => {
    const { interactions, artifacts } = getPresentationHighlights(getPresentationTrace('zh-CN'), 'zh-CN')
    expect(interactions.map(({ roundId, kind, status }) => ({ roundId, kind, status }))).toEqual([
      { roundId: 'R02', kind: 'human-choice', status: 'answered' },
      { roundId: 'R10', kind: 'presentation-outline', status: 'waiting' },
    ])
    const choice = interactions[0]!
    expect(choice.kind).toBe('human-choice')
    if (choice.kind !== 'human-choice') throw new Error('Expected a human choice')
    expect(choice.questions.map(({ header, options, answer }) => ({ header, options, answer }))).toEqual([
      { header: '受众', options: ['中学生', '成年人'], answer: '中学生' },
      { header: '使用方式', options: ['自主阅读', '课堂讲解'], answer: '自主阅读' },
    ])
    expect(choice.summary).toBe('受众：中学生；使用方式：自主阅读')
    expect(interactions[1]).toMatchObject({ title: '大纲确认', stageLabel: '规划页面', summary: '4 章 · 11 页', toolName: 'report_presentation_step' })
    expect(artifacts.find(item => item.id === 'brief')).toMatchObject({ roundId: 'R03', format: 'file', path: '.presentation/brief.md' })
    expect(artifacts.find(item => item.id === 'outline')).toMatchObject({ roundId: 'R10', format: 'structured', detail: '4 章 · 11 页' })
    expect(artifacts.find(item => item.id === 'sources')).toMatchObject({ roundId: 'R09', format: 'structured', detail: '3 组参考线索 · 0 组已核验' })
    expect(artifacts.filter(item => item.format === 'structured').every(item => item.path === undefined)).toBe(true)
  })

  test('keeps repeated choices in round and call order and retains an unanswered request', () => {
    const trace = getPresentationTrace('en-US')
    const choiceRound = trace.rounds[1]!
    const choiceCall = choiceRound.calls[0]!
    choiceRound.calls.push({ ...choiceCall, id: 'call-follow-up', result: null })
    trace.rounds.splice(2, 0, { ...choiceRound, id: 'R02-follow-up', calls: [{ ...choiceCall, id: 'call-next-round', result: null }] })
    const { interactions } = getPresentationHighlights(trace, 'en-US')
    expect(interactions.map(item => item.id)).toEqual(['R02-call-02', 'R02-call-follow-up', 'R02-follow-up-call-next-round', 'R10-call-17'])
    expect(interactions.map(item => item.status)).toEqual(['answered', 'waiting', 'waiting', 'waiting'])
    const waiting = interactions[1]!
    if (waiting.kind !== 'human-choice') throw new Error('Expected a human choice')
    expect(waiting.questions.map(question => question.answer)).toEqual([null, null])
    expect(waiting.prompt).toContain('Confirm the audience')
    expect(waiting.summary).toBe('Waiting for the user to answer')
  })

  test('does not infer an outline interaction from a report title or payload and excludes failed calls', () => {
    const trace = getPresentationTrace('en-US')
    const outlineCall = trace.rounds[9]!.calls[0]!
    outlineCall.result = { accepted: true, next_step: 'compose' }
    expect(getPresentationHighlights(trace, 'en-US').interactions.map(item => item.kind)).toEqual(['human-choice'])
    outlineCall.result = { accepted: true, status: 'awaiting_outline_confirmation' }
    outlineCall.status = 'error'
    expect(getPresentationHighlights(trace, 'en-US').interactions.map(item => item.kind)).toEqual(['human-choice'])
    trace.rounds[1]!.calls[0]!.status = 'error'
    expect(getPresentationHighlights(trace, 'en-US').interactions).toEqual([])
  })

  test('derives counts and file provenance from successful tool artifacts, not the static snapshot', () => {
    const trace = getPresentationTrace('en-US')
    trace.rounds[2]!.calls[0]!.status = 'error'
    trace.rounds[8]!.calls[0]!.arguments.data = JSON.stringify({ sources: [{ kind: 'web', status: 'available' }] })
    trace.rounds[9]!.calls[0]!.arguments.data = JSON.stringify({ chapters: [{ title: 'Revised opening', slides: [{ id: 'one' }, { id: 'two' }] }] })
    const { interactions, artifacts } = getPresentationHighlights(trace, 'en-US')
    expect(artifacts.some(item => item.id === 'brief')).toBe(false)
    expect(artifacts.find(item => item.id === 'sources')?.detail).toBe('1 reference lead · 1 verified')
    expect(artifacts.find(item => item.id === 'outline')?.detail).toBe('1 chapter · 2 slides')
    expect(interactions[1]?.summary).toBe('1 chapter · 2 slides')
    expect(interactions[1]).toMatchObject({ chapters: [{ title: 'Revised opening', slideCount: 2 }] })
  })
})
