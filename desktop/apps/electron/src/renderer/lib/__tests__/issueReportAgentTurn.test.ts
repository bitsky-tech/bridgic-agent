import { describe, expect, it } from 'bun:test'
import { serializeIssueReportAgentTurn } from '../issueReportAgentTurn'

describe('serializeIssueReportAgentTurn', () => {
  it('puts the final reply first and preserves the visible execution order without repeating it', () => {
    const report = serializeIssueReportAgentTurn({
      blocks: [
        { type: 'thinking', text: 'Inspect the environment first.' },
        { type: 'text', text: 'I will compare the two environments.' },
        {
          type: 'tool',
          toolUseId: 'tool-1',
          name: 'bash',
          input: { command: 'env' },
          result: { output: 'PATH=/usr/bin', isError: false, durationMs: 62 },
        },
        {
          type: 'workflow_step',
          workflowId: 'workflow-1',
          generation: 'generation-1',
          workflowName: 'Diagnose',
          phase: 'execute',
          stepIndex: 0,
          stepCount: 1,
          title: 'Inspect',
          status: 'success',
        },
        { type: 'text', text: 'The PATH values are different.' },
      ],
      finalAnswer: 'The PATH values are different.',
    })

    expect(report.indexOf('[Agent final reply]')).toBeLessThan(report.indexOf('[Displayed reasoning]'))
    expect(report.indexOf('[Displayed reasoning]')).toBeLessThan(report.indexOf('[Agent process message]'))
    expect(report.indexOf('[Agent process message]')).toBeLessThan(report.indexOf('[Tool call: bash]'))
    expect(report.indexOf('[Tool call: bash]')).toBeLessThan(report.indexOf('[Event: workflow_step]'))
    expect(report).toContain('"command": "env"')
    expect(report).toContain('Status: Succeeded')
    expect(report).toContain('Duration: 62 ms')
    expect(report).toContain('PATH=/usr/bin')
    expect(report.match(/The PATH values are different\./g)).toHaveLength(1)
  })

  it('serializes legacy thinking, failed tool calls, and fallback text', () => {
    const report = serializeIssueReportAgentTurn({
      blocks: [],
      fallbackText: 'Legacy final reply',
      thinking: 'Legacy visible reasoning',
      toolCalls: [{
        toolUseId: 'legacy-tool',
        name: 'bash',
        input: { command: 'false' },
        result: { output: 'exit 1', isError: true, durationMs: 4 },
      }],
      stopped: true,
    })

    expect(report.indexOf('Legacy final reply')).toBeLessThan(report.indexOf('Legacy visible reasoning'))
    expect(report).toContain('[Tool call: bash]')
    expect(report).toContain('Status: Failed')
    expect(report).toContain('Result:\nexit 1')
    expect(report).toContain('[Status]\nStopped')
  })

  it('does not reuse fallback text as an answer when authoritative blocks contain only process', () => {
    const report = serializeIssueReportAgentTurn({
      blocks: [
        { type: 'thinking', text: 'Still working' },
        { type: 'text', text: 'Process message' },
        {
          type: 'tool',
          toolUseId: 'pending-tool',
          name: 'bash',
          input: {},
        },
      ],
      finalAnswer: '',
      fallbackText: 'Process message',
    })

    expect(report).not.toContain('[Agent final reply]')
    expect(report.match(/Process message/g)).toHaveLength(1)
    expect(report).toContain('Status: Pending')
  })

  it('does not reuse legacy fallback text when an empty final answer is authoritative', () => {
    expect(serializeIssueReportAgentTurn({
      blocks: [],
      finalAnswer: '',
      fallbackText: 'Legacy text must not become a final reply',
    })).toBe('')
  })
})
