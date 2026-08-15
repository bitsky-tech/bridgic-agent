import { describe, expect, it } from 'bun:test'
import { demoteUnavailableHelp, isStructuredHelpAvailable } from '../helpCommand'
import { segmentsToBlocks, type Segment } from '../segments'

describe('structured /help mode policy', () => {
  it('is available for Main and unknown state, but not Build or Workflow Run', () => {
    expect(isStructuredHelpAvailable(null)).toBe(true)
    expect(isStructuredHelpAvailable({ mode: 'normal', stage: 'main' })).toBe(true)
    expect(isStructuredHelpAvailable({ mode: 'build', stage: 'clarify' })).toBe(false)
    expect(isStructuredHelpAvailable({ mode: 'run_workflow', stage: 'execute' })).toBe(false)
  })

  it('keeps Main help structured', () => {
    const segments: Segment[] = [{ type: 'slash', id: 'help', label: '帮助' }]

    expect(demoteUnavailableHelp(segments, true)).toBe(segments)
    expect(segmentsToBlocks(demoteUnavailableHelp(segments, true))).toEqual([
      { type: 'slash', id: 'help', label: '帮助' },
    ])
  })

  it('submits a stale help token as ordinary text in a special mode', () => {
    const segments: Segment[] = [
      { type: 'text', value: '看看 ' },
      { type: 'slash', id: 'help', label: '帮助' },
      { type: 'text', value: ' 怎么用' },
    ]

    expect(segmentsToBlocks(demoteUnavailableHelp(segments, false))).toEqual([
      { type: 'text', value: '看看 ' },
      { type: 'text', value: '/help' },
      { type: 'text', value: ' 怎么用' },
    ])
  })

  it('does not demote a Workflow or Schedule resource whose id happens to be help', () => {
    const resource: Segment[] = [
      { type: 'slash', id: 'help', label: '同名工作流', resource: 'workflow' },
    ]

    expect(demoteUnavailableHelp(resource, false)).toBe(resource)
  })
})
