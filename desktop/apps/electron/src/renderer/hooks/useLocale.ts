/**
 * Locale application + setter — the counterpart of `useTheme.ts`.
 *
 * `useApplyLocale` pushes the resolved language into i18next; `useSetLocale`
 * writes the stated preference through settings. Mount `useApplyLocale` once at
 * the App root, after `useSettingsBridge`, so the first render already reflects
 * the persisted choice.
 */
import { useCallback, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { localeAtom, type UiLocale } from '@/atoms/locale'
import { i18n } from '@/lib/i18n'
import { useUpdateSettings } from './useSettingsBridge'

/**
 * Keep i18next's active language — and the daemon's — in sync with settings.
 *
 * The guard matters: `changeLanguage` emits `languageChanged`, which re-renders
 * every component using `useTranslation`. Calling it unconditionally on each
 * settings write (they happen on unrelated fields too) would re-render the whole
 * tree for nothing.
 *
 * The daemon renders its own display text (approval cards, security labels, build
 * conflict prompts), so it needs the same language or the two drift. Dynamic import
 * keeps WebSocket out of the static graph, mirroring `useWsConnection.ts`.
 */
export function useApplyLocale(): void {
  const locale = useAtomValue(localeAtom)

  useEffect(() => {
    if (i18n.language !== locale.resolved) {
      void i18n.changeLanguage(locale.resolved)
    }
    document.documentElement.lang = locale.resolved
  }, [locale.resolved])

  useEffect(() => {
    let cancelled = false
    void import('@/lib/amphiWsConnection').then((m) => {
      if (cancelled) return
      m.getAmphiWsConnection().setLocale(locale.resolved)
    })
    return () => {
      cancelled = true
    }
  }, [locale.resolved])
}

/**
 * Setter that updates `locale` inside GuiSettings. Pass `UiLocale.System` (an
 * empty string) to hand control back to the OS language.
 */
export function useSetLocale(): (locale: UiLocale) => Promise<void> {
  const update = useUpdateSettings()
  return useCallback(
    (locale: UiLocale) => update((prev) => ({ ...prev, locale })),
    [update],
  )
}
