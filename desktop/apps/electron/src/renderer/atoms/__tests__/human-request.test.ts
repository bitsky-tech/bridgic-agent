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
  clearSessionHumanRequestAtom,
  composeChoiceAnswerItems,
  composeHumanAnswer,
  pendingBySessionAtom,
  nextUnansweredIndex,
  setHumanRequestAtom,
} from '../human-request'

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
