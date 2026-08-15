/**
 * Tests for atoms/human-request.ts — answer composition for the choose banner.
 *
 * The composed text becomes the suspended ask's tool_result on the daemon, so
 * it must keep the question → answer mapping readable for the model
 * (`question: answer` per line, unanswered entries dropped).
 */
import { describe, it, expect } from 'bun:test'
import { createStore } from 'jotai'
import {
  acceptanceRuleQuestions,
  clearSessionHumanRequestAtom,
  composeChoiceAnswerItems,
  composeHumanAnswer,
  confirmedAcceptanceRules,
  pendingBySessionAtom,
  nextUnansweredIndex,
  resolveAcceptanceReviewSubmission,
  setHumanRequestAtom,
} from '../human-request'

describe('acceptanceRuleQuestions', () => {
  it('asks one final-outcome question in user-facing language', () => {
    const questions = acceptanceRuleQuestions(['报告存在并包含所需摘要'])

    expect(questions.map((question) => question.header)).toEqual(['最终结果'])
    expect(questions[0]?.options.map((option) => option.label)).toEqual(['采用', '不采用'])
    expect(questions[0]?.options.map((option) => option.id)).toEqual(['accept', 'reject'])
    expect(questions[0]?.allowOther).toBe(true)
  })

  it('keeps two independently recognizable outcomes as two review tabs', () => {
    const questions = acceptanceRuleQuestions(['报告已交付', '分享链接已返回'])

    expect(questions.map((question) => question.header)).toEqual(['标准 1', '标准 2'])
    expect(questions.every((question) => question.options.length === 2)).toBe(true)
  })

  it('does not expose premature AC ids in the review card', () => {
    const questions = acceptanceRuleQuestions(['AC-001: 报告存在', 'AC-002：报告包含摘要'])

    expect(questions[0]?.question).toBe('报告存在')
    expect(questions[1]?.question).toBe('报告包含摘要')
  })

  it('aligns accepted candidates with system AC ids', () => {
    expect(confirmedAcceptanceRules(
      ['报告存在', '报告包含摘要', '报告使用中文'],
      ['accept', 'reject', 'accept'],
    )).toEqual([
      { id: 'AC-001', text: '报告存在' },
      { id: 'AC-002', text: '报告使用中文' },
    ])
  })

  it('uses per-rule feedback as a replacement acceptance standard', () => {
    expect(confirmedAcceptanceRules(
      ['报告存在', '报告包含摘要'],
      ['accept', 'reject'],
      ['', '摘要必须包含来源链接'],
    )).toEqual([
      { id: 'AC-001', text: '报告存在' },
      { id: 'AC-002', text: '摘要必须包含来源链接' },
    ])
  })

  it('keeps adopted or replacement rules and drops individually rejected rules', () => {
    expect(resolveAcceptanceReviewSubmission(
      ['报告存在', '报告包含摘要', '报告使用中文'],
      [
        { question: '报告存在', answer: '采用' },
        { question: '报告包含摘要', answer: '不采用' },
        { question: '报告使用中文', answer: '报告需要同时提供中英文版本' },
      ],
    )).toEqual({
      mode: 'criteria',
      decisions: ['accept', 'reject', 'reject'],
      feedback: ['', '', '报告需要同时提供中英文版本'],
      rules: [
        { id: 'AC-001', text: '报告存在' },
        { id: 'AC-002', text: '报告需要同时提供中英文版本' },
      ],
    })
  })

  it('uses the stable option id instead of a localized acceptance label', () => {
    expect(resolveAcceptanceReviewSubmission(
      ['A completed report exists'],
      [{ question: 'A completed report exists', answer: 'Adopt', optionId: 'accept' }],
    )).toEqual({
      mode: 'criteria',
      decisions: ['accept'],
      feedback: [''],
      rules: [{ id: 'AC-001', text: 'A completed report exists' }],
    })
  })

  it('recognizes free-typed English labels the same as the Chinese ones', () => {
    expect(resolveAcceptanceReviewSubmission(
      ['A completed report exists', 'The report has a summary'],
      [
        // Typed into the Other field — no optionId travels, only the text.
        { question: 'A completed report exists', answer: 'Adopt' },
        { question: 'The report has a summary', answer: 'Do not adopt' },
      ],
    )).toEqual({
      mode: 'criteria',
      decisions: ['accept', 'reject'],
      feedback: ['', ''],
      rules: [{ id: 'AC-001', text: 'A completed report exists' }],
    })
  })

  it('turns an all-rejected review without replacements into execution-only mode', () => {
    expect(resolveAcceptanceReviewSubmission(
      ['报告存在', '报告包含摘要'],
      [
        { question: '报告存在', answer: '不采用' },
        { question: '报告包含摘要', answer: '不采用' },
      ],
    )).toEqual({
      mode: 'execution_only',
      decisions: [],
      feedback: [],
      rules: [],
    })
  })
})

describe('composeHumanAnswer', () => {
  it('composes answered questions in order and drops only empty answers', () => {
    const cases = [
      {
        input: [{ question: 'Skill or code?', answer: 'code' }],
        expected: 'Skill or code?: code',
      },
      {
        input: [
          { question: '爬虫目标?', answer: '电商网站' },
          { question: '技术栈?', answer: 'Python' },
          { question: '跳过的', answer: '' },
        ],
        expected: '爬虫目标?: 电商网站\n技术栈?: Python',
      },
      {
        input: [{ question: 'q', answer: '' }],
        expected: '',
      },
      {
        input: [
          { question: '请选择', answer: 'A' },
          { question: '请选择', answer: 'B' },
        ],
        expected: '请选择: A\n请选择: B',
      },
    ]

    for (const { input, expected } of cases) {
      expect(composeHumanAnswer(input)).toBe(expected)
    }
  })
})

describe('nextUnansweredIndex', () => {
  it('selects the next unanswered question across forward, wrap, and terminal cases', () => {
    const cases: Array<[boolean[], number, number]> = [
      [[true, false, false], 0, 1],
      [[false, true, false], 1, 2],
      [[false, true, true], 2, 0],
      [[true, true, true], 1, 1],
      [[true], 0, 0],
    ]

    for (const [answered, current, expected] of cases) {
      expect(nextUnansweredIndex(answered, current)).toBe(expected)
    }
  })
})

describe('composeChoiceAnswerItems', () => {
  it('sends a clean pick as its stable option id, never its label', () => {
    expect(composeChoiceAnswerItems([
      { question: '如何处理？', answer: '删除并新建', optionId: 'replace_new' },
    ])).toEqual([{ index: 0, option_id: 'replace_new' }])
  })

  it('sends typed text as text and keeps question alignment for multi-question asks', () => {
    expect(composeChoiceAnswerItems([
      { question: 'first?', answer: 'yes', optionId: 'opt_yes' },
      { question: 'second?', answer: '' },
      { question: 'third?', answer: '先备份再说' },
    ])).toEqual([
      { index: 0, option_id: 'opt_yes' },
      { index: 2, text: '先备份再说' },
    ])
  })
})

describe('human request state', () => {
  it('keeps one pending request per session and clears it with the session', () => {
    const store = createStore()
    store.set(setHumanRequestAtom, {
      sessionId: 'session-1',
      questions: [{ question: 'first?', options: [{ label: 'yes' }] }],
    })
    store.set(setHumanRequestAtom, {
      sessionId: 'session-1',
      questions: [{ question: 'second?', options: [{ label: 'yes' }] }],
    })

    expect(store.get(pendingBySessionAtom).get('session-1')?.questions[0]?.question).toBe('second?')
    store.set(clearSessionHumanRequestAtom, 'session-1')
    expect(store.get(pendingBySessionAtom).has('session-1')).toBe(false)
  })
})
