import { describe, expect, test } from 'bun:test'
import { createToolArgumentDraft, updateToolArgumentDraft, validateToolArgumentDraft } from './tool-argument-draft'

describe('tool argument form drafts', () => {
  test('round-trips object order and recorded primitive/complex types without coercing strings', () => {
    const original = { text: 'false', count: 0, enabled: false, optional: null, settings: { scale: 2 }, items: [1, 'two'] }
    const draft = createToolArgumentDraft(original)
    expect(draft.shape).toBe('object')
    expect(draft.fields.map(field => [field.label, field.kind])).toEqual([
      ['text', 'string'], ['count', 'number'], ['enabled', 'boolean'], ['optional', 'null'], ['settings', 'object'], ['items', 'array'],
    ])
    const parsed = validateToolArgumentDraft(draft)
    expect(parsed.valid).toBe(true)
    expect(parsed.value).toEqual(original)
    expect(Object.keys(parsed.value as object)).toEqual(Object.keys(original))
  })

  test('keeps repeated names, array order, extra metadata and value types for name/value arguments', () => {
    const original = [{ name: 'same', value: '1', note: 'first' }, { name: 'same', value: 2, note: 'second' }, { name: '', value: false }]
    const draft = createToolArgumentDraft(original)
    expect(draft.shape).toBe('named-list')
    const edited = updateToolArgumentDraft(updateToolArgumentDraft(draft, '0', '42'), '1', '3.5')
    expect(validateToolArgumentDraft(edited)).toEqual({ valid: true, errors: {}, value: [
      { name: 'same', value: '42', note: 'first' }, { name: 'same', value: 3.5, note: 'second' }, { name: '', value: false },
    ] })
    expect(original[0]!.value).toBe('1')
    expect(draft.fields[0]!.input).toBe('1')
  })

  test('owns an immutable snapshot for resetting rather than following later source mutations', () => {
    const input = { settings: { nested: ['original'] } }
    const draft = createToolArgumentDraft(input)
    input.settings.nested[0] = 'later poll'
    const edited = updateToolArgumentDraft(draft, '0', '{"nested":["draft"]}')
    expect(validateToolArgumentDraft(edited).value).toEqual({ settings: { nested: ['draft'] } })
    expect(validateToolArgumentDraft(createToolArgumentDraft(edited.original)).value).toEqual({ settings: { nested: ['original'] } })
    expect(draft.original).not.toBe(input)
  })

  test('validates numbers without silently turning empty/invalid text into zero', () => {
    const draft = createToolArgumentDraft({ count: 0 })
    for (const input of ['', ' ', 'NaN', 'Infinity', '0x10', '1e999', '-']) {
      expect(validateToolArgumentDraft(updateToolArgumentDraft(draft, '0', input))).toEqual({ valid: false, value: undefined, errors: { '0': 'invalid_number' } })
    }
    expect(validateToolArgumentDraft(updateToolArgumentDraft(draft, '0', '-2.5e2')).value).toEqual({ count: -250 })
  })

  test('validates complex values against their recorded container type and preserves null/boolean', () => {
    const draft = createToolArgumentDraft({ object: {}, array: [], empty: null, flag: false })
    expect(validateToolArgumentDraft(updateToolArgumentDraft(draft, '0', '{')).errors).toEqual({ '0': 'invalid_json' })
    expect(validateToolArgumentDraft(updateToolArgumentDraft(draft, '0', '[]')).errors).toEqual({ '0': 'expected_object' })
    expect(validateToolArgumentDraft(updateToolArgumentDraft(draft, '1', '{}')).errors).toEqual({ '1': 'expected_array' })
    expect(validateToolArgumentDraft(updateToolArgumentDraft(draft, '2', '0')).errors).toEqual({ '2': 'expected_null' })
    expect(validateToolArgumentDraft(updateToolArgumentDraft(draft, '3', '0')).errors).toEqual({ '3': 'invalid_boolean' })
    expect(validateToolArgumentDraft(updateToolArgumentDraft(draft, '3', 'true')).value).toEqual({ object: {}, array: [], empty: null, flag: true })
  })

  test('keeps irregular arrays and root primitives intact and does not fabricate missing arguments', () => {
    const values: unknown[] = [[{ name: 'only-name' }, 0, null, false], [], '', false, 0, null, {}]
    for (const value of values) {
      const draft = createToolArgumentDraft(value)
      expect(validateToolArgumentDraft(draft)).toEqual({ valid: true, value, errors: {} })
    }
    const missing = createToolArgumentDraft(undefined)
    expect(missing.fields[0]!.kind).toBe('missing')
    expect(validateToolArgumentDraft(missing)).toEqual({ valid: false, value: undefined, errors: { '0': 'missing' } })
  })

  test('preserves special property names as ordinary object fields', () => {
    const input = JSON.parse('{"__proto__":{"safe":true},"constructor":"recorded"}') as unknown
    const parsed = validateToolArgumentDraft(createToolArgumentDraft(input))
    expect(parsed.value).toEqual(input)
    expect(Object.hasOwn(parsed.value as object, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(parsed.value)).toBe(Object.prototype)
  })
})
