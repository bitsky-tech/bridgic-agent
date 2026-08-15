/**
 * The one language-resolution rule, shared by the renderer and the main process.
 *
 * Both processes render UI the user reads — the renderer draws the window, main draws the
 * tray menu, the application menu and the quit dialog — and both must land on the same
 * language or the app contradicts itself. They only differ in where the OS language comes
 * from (`navigator.language` in the renderer, `app.getLocale()` in main), so that is a
 * parameter rather than a second implementation.
 *
 * Priority, in one line: **an explicit choice beats the OS default.** `GuiSettings.locale`
 * holds the stated preference and is empty until the user picks one, so a first launch
 * follows the OS and every launch after a manual pick reads the persisted value back.
 */

/**
 * Languages selectable in the UI. `System` is stored as an empty string, which
 * is what `GuiSettings.locale` documents as "follow OS".
 *
 * Keep in sync with `supportedLngs` and the bundled resources in `renderer/lib/i18n.ts`.
 */
export const UiLocale = {
  System: '',
  Chinese: 'zh',
  English: 'en',
} as const
export type UiLocale = (typeof UiLocale)[keyof typeof UiLocale]

/** A language we actually have translations for — what `t()` resolves against. */
export type ResolvedLocale = 'zh' | 'en'

/**
 * Reduce a stated preference (possibly empty) plus the OS language to one of
 * the shipped languages.
 *
 * Matching is by primary subtag so every Chinese variant (`zh`, `zh-CN`,
 * `zh-Hans`, `zh-TW`) lands on `zh`; anything else falls back to English,
 * matching `fallbackLng` in `renderer/lib/i18n.ts`.
 */
export function resolveLocale(stated: string, osLanguage: string): ResolvedLocale {
  const tag = (stated || osLanguage || '').toLowerCase()
  return tag.split('-')[0] === 'zh' ? 'zh' : 'en'
}
