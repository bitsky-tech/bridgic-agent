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
  it('compares ISO stamps and treats missing values as non-newer', () => {
    expect(isNewer('2026-06-20T09:05:00', '2026-03-12T14:20:00')).toBe(true)
    expect(isNewer('2026-03-12T14:20:00', '2026-06-20T09:05:00')).toBe(false)
    expect(isNewer('2026-06-20T09:05:00', '2026-06-20T09:05:00')).toBe(false)
    expect(isNewer(null, '2026-06-20T09:05:00')).toBe(false)
    expect(isNewer('2026-06-20T09:05:00', null)).toBe(false)
    expect(isNewer(null, null)).toBe(false)
  })
})

describe('hasDescChanged', () => {
  it('detects meaningful description changes', () => {
    expect(hasDescChanged('new text', 'old text')).toBe(true)
    expect(hasDescChanged('text', null)).toBe(true)
    expect(hasDescChanged('same', 'same')).toBe(false)
    expect(hasDescChanged(null, null)).toBe(false)
  })
})

describe('formatUpdatedAt', () => {
  it('formats ISO stamps without seconds and handles null', () => {
    expect(formatUpdatedAt('2026-06-20T09:05:00')).toBe('2026-06-20 09:05')
    expect(formatUpdatedAt('2026-06-20T09:05:42Z')).toBe('2026-06-20 09:05')
    expect(formatUpdatedAt(null)).toBe('—')
  })
})
