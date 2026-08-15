/**
 * parseDeepLink — the `amphi://` URL → navigation-target boundary parser.
 * Locks the schedule-run shape used by notification clicks and the
 * ignore-don't-throw contract for everything else.
 */
import { describe, it, expect } from 'bun:test'
import { parseDeepLink } from '../deepLink'

describe('parseDeepLink', () => {
  it('parses a schedule-run link', () => {
    expect(parseDeepLink('amphi://schedule-run/sched-1/sess-9')).toEqual({
      kind: 'schedule-run',
      scheduleId: 'sched-1',
      sessionId: 'sess-9',
    })
  })

  it('returns null for unknown hosts (future link kinds pass through)', () => {
    expect(parseDeepLink('amphi://oauth/callback?code=x')).toBeNull()
    expect(parseDeepLink('amphi://session/sess-9')).toBeNull()
  })

  it('returns null for malformed input without throwing', () => {
    expect(parseDeepLink('not a url')).toBeNull()
    expect(parseDeepLink('https://schedule-run/a/b')).toBeNull()
    expect(parseDeepLink('amphi://schedule-run/only-one')).toBeNull()
    expect(parseDeepLink('amphi://schedule-run/a/b/extra')).toBeNull()
    expect(parseDeepLink('')).toBeNull()
  })
})
