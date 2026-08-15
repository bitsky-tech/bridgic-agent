/**
 * Order of the @ popover's category tabs and the ←/→ cycling logic (pure functions, unrelated to React/Jotai).
 *
 * Single source of truth (§4.11): the menu header (MentionMenu) renders the tabs in `MENTION_SCOPES` order, and the
 * host's (FreeFormInput) keyboard handling cycles in that same order — the two can never drift.
 *
 * Only `import type` MentionScope, so there is zero runtime dependency and it can be unit-tested without happy-dom.
 */
import type { MentionScope } from './useMentionMenuState'

/** Tab order: all → session files → workflows → run results → schedules. */
export const MENTION_SCOPES = [
  'all',
  'session-files',
  'workflows',
  'workflow-runs',
  'schedules',
] as const satisfies readonly MentionScope[]

/** ←/→ cycling between category tabs: returns the adjacent scope (wrapping around at both ends, the same modulo semantics as ↑/↓). */
export function cycleMentionScope(current: MentionScope, direction: 'prev' | 'next'): MentionScope {
  const idx = MENTION_SCOPES.indexOf(current)
  const delta = direction === 'next' ? 1 : -1
  return MENTION_SCOPES[(idx + delta + MENTION_SCOPES.length) % MENTION_SCOPES.length]!
}
