/**
 * Tests for `SkillConflictRow` pure helpers — newer-than / desc-changed / time format.
 *
 * Pure-logic only (no React render), mirroring the composer/__tests__ pure-fn style.
 * These back the conflict row's "较新" tag, "描述有改动" tag, and the modal's
 * `newerSkipped` count, so the null/ISO edge cases are the load-bearing part.
 */
import { describe, it, expect } from 'bun:test'

import { formatUpdatedAt, hasDescChanged, isNewer } from '../SkillConflictRow'

describe('isNewer', () => {
  it('returns true when a is lexically after b (ISO-8601)', () => {
    expect(isNewer('2026-06-20T09:05:00', '2026-03-12T14:20:00')).toBe(true)
  })

  it('returns false when a is older or equal', () => {
    expect(isNewer('2026-03-12T14:20:00', '2026-06-20T09:05:00')).toBe(false)
    expect(isNewer('2026-06-20T09:05:00', '2026-06-20T09:05:00')).toBe(false)
  })

  it('returns false when either side is null (a missing stamp never wins)', () => {
    expect(isNewer(null, '2026-06-20T09:05:00')).toBe(false)
    expect(isNewer('2026-06-20T09:05:00', null)).toBe(false)
    expect(isNewer(null, null)).toBe(false)
  })
})

describe('hasDescChanged', () => {
  it('detects a differing description', () => {
    expect(hasDescChanged('new text', 'old text')).toBe(true)
  })

  it('treats a null existing description as a change when incoming has text', () => {
    expect(hasDescChanged('text', null)).toBe(true)
  })

  it('returns false when both sides are identical', () => {
    expect(hasDescChanged('same', 'same')).toBe(false)
    expect(hasDescChanged(null, null)).toBe(false)
  })
})

describe('formatUpdatedAt', () => {
  it('renders an ISO stamp as YYYY-MM-DD HH:mm', () => {
    expect(formatUpdatedAt('2026-06-20T09:05:00')).toBe('2026-06-20 09:05')
  })

  it('drops seconds and any trailing timezone', () => {
    expect(formatUpdatedAt('2026-06-20T09:05:42Z')).toBe('2026-06-20 09:05')
  })

  it('renders an em dash for null', () => {
    expect(formatUpdatedAt(null)).toBe('—')
  })
})
