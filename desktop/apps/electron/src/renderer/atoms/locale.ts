/**
 * Locale atoms — derived from `settingsAtom`, mirroring `atoms/theme.ts`.
 *
 * The stated value lives in `GuiSettings.locale` (BCP-47, empty = follow OS).
 * Everything the UI actually renders with is the *resolved* value, which is
 * always one of the languages we ship translations for.
 *
 * Settings is the single source of truth on purpose: i18next's
 * LanguageDetector would otherwise keep its own copy in localStorage, and the
 * two would drift the moment a user changes the language on one and the app
 * reads the other on next boot. The detector stays configured for first-run
 * defaults only; `hooks/useLocale.ts` drives i18next from here afterwards.
 */
import { atom } from 'jotai'
import { settingsAtom } from './settings'

// The rule itself lives in `@shared/locale` because the main process resolves the same
// language for the tray menu / application menu / quit dialog. Re-exported so renderer
// consumers keep importing it from here.
export { resolveLocale, UiLocale, type ResolvedLocale } from '@shared/locale'
import { resolveLocale, type ResolvedLocale, type UiLocale } from '@shared/locale'

interface LocaleState {
  /** What the user chose, verbatim. Empty means "follow system". */
  stated: UiLocale
  /** The language actually in effect. */
  resolved: ResolvedLocale
}

/** Derived: the stated preference plus the language actually in effect. */
export const localeAtom = atom<LocaleState>((get) => {
  const stated = get(settingsAtom).locale as UiLocale
  const osLanguage = typeof navigator === 'undefined' ? 'en' : navigator.language
  return { stated, resolved: resolveLocale(stated, osLanguage) }
})
