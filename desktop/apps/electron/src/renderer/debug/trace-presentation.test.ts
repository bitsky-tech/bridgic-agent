import { describe, expect, test } from 'bun:test'
import type { DesktopDebugTurn } from '../../shared/debug-types'
import { buildTraceRecords } from './trace-records'
import { groupRoundsByTurn, roundPreview, userInputText } from './trace-presentation'

function turn(id: string, ordinal: number, userInput: unknown, bodies: (string | null)[] = ['Response']): DesktopDebugTurn {
  return { id, sessionId: 'session', sessionOrdinal: ordinal, status: 'completed', createdAt: '', userInput,
    finalAnswer: null, error: null, executionMode: null, maxRounds: null, model: null, durationMs: null,
    otaRecords: bodies.map(body => ({ think_result: { step_content: body, tool_calls: [] } })),
    otaContext: null, otaContextSource: 'unavailable', agentState: null, contextUsage: null }
}

describe('userInputText', () => {
  test('prefers the actual stored text without duplicating its structured text blocks', () => {
    const input = { text: '  Summarize the report\nthen list actions.  ', blocks: [
      { type: 'text', value: 'Summarize the report' }, { type: 'mention', label: 'Budget', path: '/private/budget.xlsx' },
    ] }
    expect(userInputText(input)).toBe(input.text)
    expect(userInputText('Direct user task')).toBe('Direct user task')
  })

  test('falls back to actual text block values but never mention/slash metadata', () => {
    expect(userInputText({ text: '', blocks: [
      { type: 'text', value: 'Prepare the slides.' },
      { type: 'mention', id: 'doc', label: 'Budget', path: '/private/budget.xlsx' },
      { type: 'slash', id: 'workflow', label: 'Run workflow', resource: 'workflow' },
      { type: 'text', value: 'Include an appendix.' },
    ] })).toBe('Prepare the slides.\nInclude an appendix.')
  })

  test('supports explicit legacy text/content/input shapes and authored content arrays', () => {
    expect(userInputText({ content: 'Content task' })).toBe('Content task')
    expect(userInputText({ input: 'Legacy task' })).toBe('Legacy task')
    expect(userInputText([{ name: 'irrelevant', text: 'First' }, { content: 'Second' }])).toBe('First\nSecond')
    expect(userInputText({ role: 'user', content: [{ type: 'input_text', text: 'Use this text' }, { type: 'image_url', image_url: 'private' }] })).toBe('Use this text')
  })

  test('does not serialize metadata, non-user messages, or absent input as the user task', () => {
    for (const value of [null, undefined, 0, false, '', ' \n ', {}, [],
      { id: 'private', name: 'Internal task', path: '/private/file' },
      [{ name: 'Internal field', value: 'Not authored text' }],
      { type: 'tool', text: 'Tool result' }, { role: 'system', content: 'Internal prompt' },
      { blocks: [{ type: 'mention', label: 'Metadata' }] },
    ]) expect(userInputText(value)).toBeNull()
  })
})

describe('groupRoundsByTurn', () => {
  test('separates the R01 of two actual Turns and orders latest Turns first with rounds ascending', () => {
    const earlier = turn('first-turn', 0, { text: 'First task' }, ['First R01', 'First R02'])
    const later = turn('second-turn', 1, { text: 'Second task' }, ['Second R01', 'Second R02'])
    const rounds = buildTraceRecords([earlier, later]).rounds
    const unordered = [rounds[3]!, rounds[1]!, rounds[2]!, rounds[0]!]
    const before = JSON.stringify({ turns: [earlier, later], rounds: unordered })
    const groups = groupRoundsByTurn([earlier, later], unordered)
    expect(groups.map(group => group.turnId)).toEqual(['second-turn', 'first-turn'])
    expect(groups.map(group => group.rounds.map(round => round.ordinal))).toEqual([[1, 2], [1, 2]])
    expect(groups.map(group => userInputText(group.turn?.userInput))).toEqual(['Second task', 'First task'])
    expect(groups[0]!.rounds[0]!.id).not.toBe(groups[1]!.rounds[0]!.id)
    expect(groups[0]!.turn).toBe(later)
    expect(JSON.stringify({ turns: [earlier, later], rounds: unordered })).toBe(before)
  })

  test('retains orphan rounds without inventing user input and keeps metadata ordinal zero', () => {
    const known = turn('known', 0, null)
    const missing = turn('orphan', 4, 'Not supplied to grouping')
    const rounds = buildTraceRecords([known, missing]).rounds
    const groups = groupRoundsByTurn([known], rounds)
    expect(groups.map(group => [group.turnId, group.turnOrdinal])).toEqual([['orphan', 4], ['known', 0]])
    expect(groups[0]!.turn).toBeUndefined()
    expect(userInputText(groups[0]!.turn?.userInput)).toBeNull()
    expect(userInputText(groups[1]!.turn?.userInput)).toBeNull()
    expect(groups[0]!.rounds[0]).toBe(rounds[1])
  })

  test('uses actual IDs for equal ordinals and leaves Turns without recorded rounds out of the list', () => {
    const first = turn('a', 0, 'A')
    const second = turn('b', 0, 'B')
    const empty = turn('empty', 99, 'No round yet', [])
    const groups = groupRoundsByTurn([first, second, empty], buildTraceRecords([first, second, empty]).rounds)
    expect(groups.map(group => group.turnId)).toEqual(['b', 'a'])
    expect(groupRoundsByTurn([first], [])).toEqual([])
  })
})

describe('roundPreview', () => {
  test('uses only real body text and collapses whitespace without altering the saved output', () => {
    const rawBody = '  Prepared\n\n  the report.\t[File](file:///tmp/report.txt)  '
    const record = buildTraceRecords([turn('body', 0, '', [rawBody])]).rounds[0]!
    expect(roundPreview(record)).toEqual({ body: 'Prepared the report. [File](file:///tmp/report.txt)', toolNames: [], hasThinking: false })
    expect(record.body).toBe(rawBody)
  })

  test('exposes tool names and an actual thinking marker for localized fallback selection', () => {
    const input = turn('tools', 0, '')
    input.otaRecords = [{ reasoning_content: 'Recorded thinking', think_result: { step_content: '', tool_calls: [
      { tool: 'read_file', call_id: 'one' }, { tool: 'read_file', call_id: 'two' }, { tool: 'write_file', call_id: 'three' },
    ] } }]
    const record = buildTraceRecords([input]).rounds[0]!
    expect(roundPreview(record)).toEqual({ body: null, toolNames: ['read_file', 'write_file'], hasThinking: true })
  })

  test('does not substitute stage/model/metadata or encrypted reasoning for missing content', () => {
    const input = turn('empty', 0, '')
    input.otaRecords = [{ think_scope: { stage: 'main' }, model: 'provider-model', summary: 'Not model output',
      reasoning_items: [{ encrypted_content: 'opaque' }], think_result: { step_content: null, tool_calls: [] } }]
    expect(roundPreview(buildTraceRecords([input]).rounds[0]!)).toEqual({ body: null, toolNames: [], hasThinking: false })
  })
})
