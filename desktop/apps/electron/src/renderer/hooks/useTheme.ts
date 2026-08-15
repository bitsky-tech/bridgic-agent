/**
 * Theme application + mode setter — split out of atoms/theme.ts (which keeps
 * themeAtom). useApplyTheme writes data-theme + CSS vars to <html>;
 * useSetThemeMode writes theme.mode through settings.
 */
import { useCallback, useEffect } from 'react'
import { useAtomValue } from 'jotai'
import { ThemeMode } from '@app/shared/types'
import { themeAtom } from '@/atoms/theme'
import { settingsAtom } from '@/atoms/settings'
import { useUpdateSettings } from './useSettingsBridge'

/**
 * Apply effective theme + accent to <html> so Tailwind's `dark:` variants +
 * CSS custom properties resolve correctly. Mount once at the App root (after
 * useSettingsBridge).
 *
 * UI zoom is NOT handled here — it is `webContents.setZoomLevel`, applied
 * centrally by the main process (`gui-settings.ts :: applyZoomLevel`); the
 * renderer neither needs to nor can take part.
 */
export function useApplyTheme(): void {
  const theme = useAtomValue(themeAtom)
  const settings = useAtomValue(settingsAtom)

  useEffect(() => {
    document.documentElement.dataset.theme = theme.resolved
  }, [theme.resolved])

  useEffect(() => {
    document.documentElement.style.setProperty('--accent', settings.theme.accent)
  }, [settings.theme.accent])

}

/**
 * Setter that updates `theme.mode` inside GuiSettings. The render-side state
 * follows once main broadcasts back the new blob (via useSettingsBridge), but
 * the optimistic write inside useUpdateSettings makes it feel instant.
 */
export function useSetThemeMode(): (mode: ThemeMode) => Promise<void> {
  const update = useUpdateSettings()
  return useCallback(
    async (mode) => {
      await update((prev) => ({
        ...prev,
        theme: { ...prev.theme, mode },
      }))
    },
    [update],
  )
}
