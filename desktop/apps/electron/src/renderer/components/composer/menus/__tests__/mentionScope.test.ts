/**
 * Pure cycleMentionScope tests verify ←/→ wrapping across five category tabs so keyboard
 * navigation matches header rendering order (§4.11 single source of truth).
 */
import { describe, expect, it } from 'bun:test'
import { MENTION_SCOPES, cycleMentionScope } from '../mentionScope'

describe('cycleMentionScope', () => {
  it('cycles through the canonical scope order in both directions with wrapping', () => {
    expect(MENTION_SCOPES).toEqual([
      'all',
      'session-files',
      'workflows',
      'workflow-runs',
      'schedules',
    ])
    for (let index = 0; index < MENTION_SCOPES.length; index += 1) {
      const current = MENTION_SCOPES[index]!
      const next = MENTION_SCOPES[(index + 1) % MENTION_SCOPES.length]!
      const previous = MENTION_SCOPES[(index - 1 + MENTION_SCOPES.length) % MENTION_SCOPES.length]!
      expect(cycleMentionScope(current, 'next')).toBe(next)
      expect(cycleMentionScope(current, 'prev')).toBe(previous)
    }
  })
})
