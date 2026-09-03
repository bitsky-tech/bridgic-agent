/**
 * Tests for lib/qaSegments.ts — the pure split/derive logic behind the QA
 * Process-view behavior. Mirrors the bun:test style of turn-translate.test.ts (§4.12).
 */
import { describe, it, expect } from 'bun:test'
import type { MessageBlock } from '@/atoms/agent'
import {
  countConfirmations,
  countMessages,
  countToolCalls,
  countWorkflowSteps,
  splitProcessAndAnswer,
} from '../qaSegments'

const text = (t: string): MessageBlock => ({ type: 'text', text: t })
const thinking = (t: string): MessageBlock => ({ type: 'thinking', text: t })
const tool = (name: string, input: unknown = {}): MessageBlock => ({
  type: 'tool',
  toolUseId: `t-${name}`,
  name,
  input,
})
const taskConfirm: MessageBlock = {
  type: 'task_confirm',
  requestId: 'task-1',
  taskMarkdown: '## Task\nReview me',
  status: 'pending',
}
const buildConfirm: MessageBlock = {
  type: 'build_confirm',
  requestId: 'build-1',
  goal: '每周生成目录报告',
  reason: '这项任务需要稳定复用。',
  status: 'pending',
}
const buildStage: MessageBlock = { type: 'build_stage', stage: 'clarify' }
const workflowStep: MessageBlock = {
  type: 'workflow_step',
  workflowId: 'wf-report',
  generation: 'gen-report',
  workflowName: '生成报告',
  phase: 'execute',
  stepIndex: 0,
  stepCount: 2,
  title: '收集数据',
  status: 'success',
}
const workflowResult: MessageBlock = {
  type: 'workflow_result',
  runId: 'wfr-report',
  workflowId: 'wf-report',
  workflowName: '生成报告',
  status: 'completed',
  createdAt: '2026-08-03T06:00:00Z',
}

describe('splitProcessAndAnswer', () => {
  it('treats a plain text-only reply as all answer (no process container)', () => {
    const blocks = [text('你好,这是答案')]
    expect(splitProcessAndAnswer(blocks)).toEqual({ process: [], answer: blocks })
  })

  it('treats a thinking-only message as process with no answer', () => {
    const blocks = [thinking('在想')]
    expect(splitProcessAndAnswer(blocks)).toEqual({ process: [thinking('在想')], answer: [] })
  })

  it('peels the trailing text run as the answer, rest is process', () => {
    const blocks = [thinking('想'), text('叙述'), tool('bash'), text('最终答案')]
    const { process, answer } = splitProcessAndAnswer(blocks)
    expect(process).toEqual([thinking('想'), text('叙述'), tool('bash')])
    expect(answer).toEqual([text('最终答案')])
  })

  it('peels multiple trailing text blocks together', () => {
    const blocks = [tool('grep'), text('第一段'), text('第二段')]
    const { process, answer } = splitProcessAndAnswer(blocks)
    expect(process).toEqual([tool('grep')])
    expect(answer).toEqual([text('第一段'), text('第二段')])
  })

  it('returns empty answer when the message ends on a tool (HITL / no answer yet)', () => {
    const blocks = [thinking('想'), tool('write_file')]
    const { process, answer } = splitProcessAndAnswer(blocks)
    expect(process).toEqual(blocks)
    expect(answer).toEqual([])
  })

  it('authoritative empty finalAnswer forces all-process even if trailing is text', () => {
    // The heuristic treats trailing text as an answer, but the backend says this turn has
    // no final answer (for example, a closing ask), so keep everything in the process view
    // and do not duplicate intermediate text outside the container.
    const blocks = [thinking('想'), text('我先问你一个问题')]
    expect(splitProcessAndAnswer(blocks, '')).toEqual({ process: blocks, answer: [] })
    expect(splitProcessAndAnswer(blocks, '   ')).toEqual({ process: blocks, answer: [] })
  })

  it('non-empty finalAnswer still peels the trailing text as the answer', () => {
    const blocks = [thinking('想'), tool('bash'), text('最终答案')]
    const { process, answer } = splitProcessAndAnswer(blocks, '最终答案')
    expect(process).toEqual([thinking('想'), tool('bash')])
    expect(answer).toEqual([text('最终答案')])
  })

  it('finalAnswer undefined (streaming) falls back to the heuristic', () => {
    const blocks = [tool('bash'), text('流式末尾文本')]
    expect(splitProcessAndAnswer(blocks, undefined).answer).toEqual([text('流式末尾文本')])
  })

  it('keeps a task confirmation card visible outside the process timeline', () => {
    const blocks = [thinking('整理需求'), tool('write_file'), taskConfirm]
    expect(splitProcessAndAnswer(blocks, '')).toEqual({
      process: [thinking('整理需求'), tool('write_file')],
      answer: [taskConfirm],
    })
  })

  it('keeps a pending Build proposal visible and folds it after the decision', () => {
    const before = [thinking('判断复用价值'), buildConfirm]
    expect(splitProcessAndAnswer(before, '')).toEqual({
      process: [thinking('判断复用价值')],
      answer: [buildConfirm],
    })

    const confirmed = { ...buildConfirm, status: 'confirmed' as const }
    const answer = text('开始构建')
    expect(splitProcessAndAnswer([thinking('判断复用价值'), confirmed, answer], '开始构建')).toEqual({
      process: [thinking('判断复用价值'), confirmed],
      answer: [answer],
    })
  })

  it('folds a resolved task confirmation into process and leaves the final answer visible', () => {
    const confirmed = { ...taskConfirm, status: 'confirmed' as const }
    const answer = text('工作流已保存')
    expect(splitProcessAndAnswer([thinking('整理需求'), confirmed, answer], '工作流已保存')).toEqual({
      process: [thinking('整理需求'), confirmed],
      answer: [answer],
    })
  })

  it('keeps a saved Workflow card beside the final answer instead of folding it', () => {
    const saved: MessageBlock = {
      type: 'workflow_confirm',
      requestId: 'workflow-1',
      defaultName: '目录统计',
      workflowId: 'wf-directory',
      name: '目录统计',
      status: 'confirmed',
    }
    const answer = text('工作流已经准备好了')
    expect(splitProcessAndAnswer([thinking('构建'), saved, answer], '工作流已经准备好了')).toEqual({
      process: [thinking('构建')],
      answer: [saved, answer],
    })
    expect(splitProcessAndAnswer([thinking('构建'), saved], '')).toEqual({
      process: [thinking('构建')],
      answer: [saved],
    })
  })

  it('keeps Workflow steps in process and the final summary outside', () => {
    const answer = text('报告已生成并验证通过')
    expect(splitProcessAndAnswer([workflowStep, answer], '报告已生成并验证通过')).toEqual({
      process: [workflowStep],
      answer: [answer],
    })
  })

  it('keeps Build stage boundaries in process and the final answer outside', () => {
    const answer = text('任务说明书已经准备好')
    expect(splitProcessAndAnswer([buildStage, answer], '任务说明书已经准备好')).toEqual({
      process: [buildStage],
      answer: [answer],
    })
  })

  it('keeps a terminal Workflow result card outside the process after reload', () => {
    expect(splitProcessAndAnswer([workflowStep, workflowResult], '')).toEqual({
      process: [workflowStep],
      answer: [workflowResult],
    })
    const answer = text('报告已生成')
    expect(splitProcessAndAnswer([workflowStep, workflowResult, answer], '报告已生成')).toEqual({
      process: [workflowStep],
      answer: [workflowResult, answer],
    })
  })
})

describe('counts', () => {
  it('counts tools, messages, confirmations, and workflow steps by category', () => {
    const confirmation: MessageBlock = { type: 'confirmation', question: 'Q?', response: 'A' }
    expect(countToolCalls([thinking('a'), tool('x'), text('b'), tool('y')])).toBe(2)
    expect(countMessages([thinking('a'), tool('x'), text('b'), confirmation, buildConfirm, taskConfirm])).toBe(2)
    expect(countMessages([tool('x'), tool('y')])).toBe(0)
    expect(countConfirmations([thinking('a'), confirmation, buildConfirm, taskConfirm])).toBe(3)
    expect(countWorkflowSteps([workflowStep, text('done')])).toBe(1)
    expect(countMessages([buildStage, text('done')])).toBe(1)
    expect(countMessages([workflowStep, text('done')])).toBe(1)
    expect(countMessages([workflowResult, text('done')])).toBe(1)
  })
})
