/**
 * `resolveLocale` — the one piece of locale logic worth testing in isolation.
 *
 * Everything else in `atoms/locale.ts` is a derived atom over settings; the
 * reduction from "stated preference + OS language" to a shipped language is
 * where the edge cases live (empty preference, regional Chinese variants,
 * unsupported languages).
 */
import { describe, expect, it } from 'bun:test'
import { resolveLocale, UiLocale } from '../locale'

describe('resolveLocale', () => {
  it('prefers the stated locale over the OS language', () => {
    expect(resolveLocale(UiLocale.English, 'zh-CN')).toBe('en')
    expect(resolveLocale(UiLocale.Chinese, 'en-US')).toBe('zh')
  })

  it('falls back to the OS language when nothing is stated', () => {
    expect(resolveLocale(UiLocale.System, 'zh-CN')).toBe('zh')
    expect(resolveLocale(UiLocale.System, 'en-GB')).toBe('en')
  })

  it('matches Chinese by primary subtag, so every variant lands on zh', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-TW', 'zh-Hant-HK', 'ZH-cn']) {
      expect(resolveLocale(UiLocale.System, tag)).toBe('zh')
    }
  })

  it('falls back to English for languages we ship no translation for', () => {
    // Matches `fallbackLng: 'en'` in lib/i18n.ts — an unsupported language must
    // not leave the UI untranslated.
    for (const tag of ['ja-JP', 'ko', 'fr', 'de-DE', '']) {
      expect(resolveLocale(UiLocale.System, tag)).toBe('en')
    }
  })

  it('does not treat a language merely containing "zh" as Chinese', () => {
    // Primary-subtag matching, not substring: a tag like `az` or `zu` must not
    // be dragged to Chinese by a naive includes() check.
    expect(resolveLocale(UiLocale.System, 'zu-ZA')).toBe('en')
    expect(resolveLocale(UiLocale.System, 'az-Latn')).toBe('en')
  })
})
