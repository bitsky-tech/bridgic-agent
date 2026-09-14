import { describe, expect, test } from 'bun:test'
import { toolCallPreview } from './tool-call-preview'
import type { TraceToolCall } from './types'

function call(overrides: Partial<TraceToolCall> = {}): TraceToolCall {
  return { id: 'call', roundId: 'round', turnId: 'turn', turnOrdinal: 0, ordinal: 1, sourceCallId: 'source',
    name: 'tool', arguments: undefined, result: undefined, error: undefined, hasResult: false,
    pairing: 'missing', status: 'unknown', durationMs: null, rawCall: null, rawResult: null, ...overrides }
}

describe('toolCallPreview', () => {
  test('previews the first three object entries in recorded order and reports the remainder', () => {
    const argumentsValue = Object.freeze({ path: ' report.txt ', count: 0, enabled: false, options: null, text: '' })
    expect(toolCallPreview(call({ arguments: argumentsValue }))).toEqual({
      arguments: [{ name: 'path', value: 'report.txt' }, { name: 'count', value: '0' }, { name: 'enabled', value: 'false' }],
      remainingArgumentCount: 2, argumentState: 'recorded', outcomeKind: 'missing', outcome: '',
    })
    expect(argumentsValue.path).toBe(' report.txt ')
  })

  test('retains repeated names and empty names in named argument arrays without mutating their values', () => {
    const nested = Object.freeze({ values: Object.freeze([false, 0, null, '']) })
    const argumentsValue = Object.freeze([
      Object.freeze({ name: 'item', value: '', metadata: 'retained' }),
      Object.freeze({ name: 'item', value: nested }),
      Object.freeze({ name: '', value: null }),
      Object.freeze({ name: 'fourth', value: false }),
    ])
    const source = call({ arguments: argumentsValue })
    const before = JSON.stringify(source)
    const result = toolCallPreview(source)
    expect(result.arguments).toEqual([
      { name: 'item', value: '""' }, { name: 'item', value: '{"values":[false,0,null,""]}' }, { name: '', value: 'null' },
    ])
    expect(result.remainingArgumentCount).toBe(1)
    expect(result.argumentState).toBe('recorded')
    expect(JSON.stringify(source)).toBe(before)
    expect(source.arguments).toBe(argumentsValue)
  })

  test('distinguishes missing and empty objects from actual null, false, zero, empty strings and arrays', () => {
    expect(toolCallPreview(call()).argumentState).toBe('missing')
    expect(toolCallPreview(call()).arguments).toEqual([])
    for (const value of [{}, Object.create(null)]) {
      const result = toolCallPreview(call({ arguments: value }))
      expect(result.argumentState).toBe('empty')
      expect(result.arguments).toEqual([])
      expect(result.remainingArgumentCount).toBe(0)
    }
    for (const [value, expected] of [[null, 'null'], [false, 'false'], [0, '0'], ['', '""'], [[], '[]']] as const) {
      const result = toolCallPreview(call({ arguments: value }))
      expect(result.argumentState).toBe('recorded')
      expect(result.arguments).toEqual([{ name: '', value: expected }])
    }
  })

  test('keeps irregular arrays as one raw value instead of silently discarding unnamed or absent values', () => {
    const values = [
      [{ name: 'one', value: 1 }, { name: 'two' }],
      [{ name: 1, value: 0 }, { name: 'one', value: 1 }],
      ['first', false, 0, null],
    ]
    for (const value of values) {
      const result = toolCallPreview(call({ arguments: value }))
      expect(result.arguments).toEqual([{ name: '', value: JSON.stringify(value) }])
      expect(result.remainingArgumentCount).toBe(0)
    }
  })

  test('shows any explicit error before results, including falsy errors, without inventing a summary', () => {
    for (const [error, expected] of [[false, 'false'], [0, '0'], ['', '""'], [{ code: 'E_FAIL' }, '{"code":"E_FAIL"}']] as const) {
      const result = toolCallPreview(call({ error, hasResult: true, result: 'Do not show this result', status: 'success' }))
      expect(result.outcomeKind).toBe('error')
      expect(result.outcome).toBe(expected)
    }
  })

  test('requires recorded result presence and never treats actual empty results as missing', () => {
    for (const error of [undefined, null]) {
      for (const [value, expected] of [[null, 'null'], [false, 'false'], [0, '0'], ['', '""'], [[], '[]'], [{}, '{}']] as const) {
        const result = toolCallPreview(call({ error, hasResult: true, result: value }))
        expect(result.outcomeKind).toBe('result')
        expect(result.outcome).toBe(expected)
      }
    }
    for (const source of [call({ hasResult: false, result: 'Unpaired' }), call({ hasResult: true, status: 'error' })]) {
      const result = toolCallPreview(source)
      expect(result.outcomeKind).toBe('missing')
      expect(result.outcome).toBe('')
    }
  })

  test('collapses whitespace, limits argument and outcome previews, and leaves recorded text untouched', () => {
    const argumentsValue = { text: '  first\n\n second\t third  ', exact: 'x'.repeat(240), long: '😀'.repeat(241) }
    const source = call({ arguments: argumentsValue, hasResult: true, result: 'a'.repeat(801) })
    const result = toolCallPreview(source)
    expect(result.arguments.map(item => item.value)).toEqual(['first second third', 'x'.repeat(240), `${'😀'.repeat(239)}…`])
    expect(Array.from(result.arguments[2]!.value)).toHaveLength(240)
    expect(result.outcome).toBe(`${'a'.repeat(799)}…`)
    expect(result.outcome).toHaveLength(800)
    expect(source.result).toBe('a'.repeat(801))
    expect(argumentsValue.text).toBe('  first\n\n second\t third  ')
    expect(toolCallPreview(call({ error: 'e'.repeat(801) })).outcome).toBe(`${'e'.repeat(799)}…`)
    expect(toolCallPreview(call({ hasResult: true, result: 'r'.repeat(800) })).outcome).toBe('r'.repeat(800))
  })

  test('renders text literally without parsing JSON or executing content', () => {
    const text = '{ "instruction": "run()", "count": 0 }'
    expect(toolCallPreview(call({ arguments: text, hasResult: true, result: text })).arguments).toEqual([{ name: '', value: text }])
    expect(toolCallPreview(call({ hasResult: true, result: text })).outcome).toBe(text)
  })
})
