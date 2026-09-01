/**
 * Tests for the composer's rotating placeholder.
 *
 * Renderless: the hook is a timer + index, so the assertions here are about
 * the tip table's invariants and the rotation arithmetic — not about React.
 * The one behaviour that genuinely needs React (stop the timer when the
 * composer is non-empty) is guarded by the `active` flag the caller passes,
 * which is exercised in FreeFormInput rather than mocked here.
 */
import { describe, it, expect } from 'bun:test'

import { composerTips } from '../useRotatingPlaceholder'

const COMPOSER_TIPS = composerTips()

describe('COMPOSER_TIPS', () => {
  it('keeps the original static copy first', () => {
    // The first frame after mount must look exactly like it did before this
    // feature existed — rotation only starts once the user has lingered.
    expect(COMPOSER_TIPS[0]).toBe('输入消息，使用 / 触发指令…')
  })

  it('only advertises commands that actually exist', () => {
    // A tip promising a command the app doesn't have is worse than no tip.
    // Keep this in sync with SLASH_COMMANDS in atoms/composer-fixtures.ts.
    const REAL_COMMANDS = ['/build', '/schedule', '/help']
    const mentioned = COMPOSER_TIPS.flatMap(
      (tip) => tip.match(/\/[a-z]+/g) ?? [],
    ).filter((token) => token !== '/ ')
    for (const cmd of mentioned) {
      expect(REAL_COMMANDS).toContain(cmd)
    }
  })

  it('has no duplicates and no empty entries', () => {
    expect(new Set(COMPOSER_TIPS).size).toBe(COMPOSER_TIPS.length)
    expect(COMPOSER_TIPS.every((t) => t.trim().length > 0)).toBe(true)
  })

  it('keeps the pitfall tips, and keeps them inside the first rotation window', () => {
    // These tips correspond to real hard-coded behavior documented in COMPOSER_TIPS, not optional
    // advice. Without them, users may think the app is broken when `file@` opens no menu or a long
    // paste is converted. A full rotation takes count * 5 seconds and users rarely wait that long,
    // so critical tips must remain within the initial window, not merely somewhere in the list.
    //
    // The window is a **fixed value**, not `length / 2`. A proportional threshold expands whenever
    // a tip is added and silently weakens the assertion, while user patience is independent of list
    // length. With ROTATE_INTERVAL_MS = 5s, six entries represent about 30 seconds.
    const FIRST_WINDOW = 6
    const PITFALLS = ['@ 与 /', 'Shift + Enter', '.txt 附件', '拖入文件']
    for (const marker of PITFALLS) {
      const at = COMPOSER_TIPS.findIndex((tip) => tip.includes(marker))
      expect(at).toBeGreaterThan(-1)
      expect(at).toBeLessThan(FIRST_WINDOW)
    }
  })

  it('wraps around instead of running off the end', () => {
    // Mirrors the hook's `(i + 1) % length`, which is the only arithmetic
    // that could ever produce an out-of-range read.
    const n = COMPOSER_TIPS.length
    expect((n - 1 + 1) % n).toBe(0)
    for (let i = 0; i < n * 2; i++) {
      expect(COMPOSER_TIPS[i % n]).toBeDefined()
    }
  })
})
