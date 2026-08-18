import { describe, expect, it } from 'bun:test'
import { sanitizeForLogging } from '../sanitize'

describe('sanitizeForLogging', () => {
  it('passes primitives through unchanged', () => {
    expect(sanitizeForLogging(42)).toBe(42)
    expect(sanitizeForLogging(true)).toBe(true)
    expect(sanitizeForLogging(null)).toBe(null)
    expect(sanitizeForLogging(undefined)).toBe(undefined)
    expect(sanitizeForLogging('short')).toBe('short')
  })

  it('truncates strings longer than 500 chars and appends original length', () => {
    const long = 'a'.repeat(700)
    const out = sanitizeForLogging(long) as string
    expect(out.length).toBeLessThan(long.length)
    expect(out).toContain('…(700)')
    expect(out.startsWith('aaaa')).toBe(true)
  })

  it('stringifies bigint to avoid JSON serialization errors', () => {
    expect(sanitizeForLogging(9007199254740993n)).toBe('9007199254740993')
  })

  it('truncates arrays to the first 10 elements and marks the remainder', () => {
    const arr = Array.from({ length: 25 }, (_, i) => i)
    const out = sanitizeForLogging(arr) as unknown[]
    // 10 real elements + the remainder marker: a silently shortened array
    // reads as "that was all of it".
    expect(out).toHaveLength(11)
    expect(out[0]).toBe(0)
    expect(out[9]).toBe(9)
    expect(out[10]).toBe('…(+15 more)')
  })

  it('truncates objects after 20 keys with a remainder marker', () => {
    const obj: Record<string, number> = {}
    for (let i = 0; i < 30; i += 1) obj[`k${i}`] = i
    const out = sanitizeForLogging(obj) as Record<string, unknown>
    // 20 real keys + the "…" remainder key
    expect(Object.keys(out)).toHaveLength(21)
    expect(out['…']).toBe('+10 more')
  })

  it('stops descending after depth 3 and replaces with ellipsis', () => {
    const deep = { a: { b: { c: { d: { e: 'too deep' } } } } }
    const out = sanitizeForLogging(deep) as { a: { b: { c: { d: unknown } } } }
    expect(out.a.b.c.d).toBe('…')
  })

  it('recurses into nested objects up to the depth limit', () => {
    const nested = { user: { name: 'alice', age: 30 } }
    const out = sanitizeForLogging(nested) as { user: { name: string; age: number } }
    expect(out.user.name).toBe('alice')
    expect(out.user.age).toBe(30)
  })

  it('truncates strings inside nested structures', () => {
    const long = 'x'.repeat(600)
    const out = sanitizeForLogging({ payload: long }) as { payload: string }
    expect(out.payload).toContain('…(600)')
  })
})
