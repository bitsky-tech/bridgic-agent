/**
 * Theme atoms — derived from `settingsAtom`.
 *
 * Theme used to live in its own IPC namespace with a separate `themeAtom`
 * source-of-truth. Phase G folded theme into GuiSettings, so this file now
 * just derives from `atoms/settings.ts`.
 *
 * The apply + setter hooks (useApplyTheme / useSetThemeMode) live in
 * hooks/use-theme.ts — this file is pure atoms.
 */
import { atom } from 'jotai'
import { ThemeMode } from '@app/shared/types'
import { osPrefersDarkAtom, settingsAtom } from './settings'

interface ThemeState {
  mode: ThemeMode
  resolved: 'light' | 'dark'
}

/**
 * Derived: read `theme.mode` + OS preference, return both the user-stated
 * mode and the actually-resolved light/dark.
 */
export const themeAtom = atom<ThemeState>((get) => {
  const mode = get(settingsAtom).theme.mode
  if (mode === ThemeMode.Light) return { mode: ThemeMode.Light, resolved: 'light' }
  if (mode === ThemeMode.Dark) return { mode: ThemeMode.Dark, resolved: 'dark' }
  return { mode: ThemeMode.System, resolved: get(osPrefersDarkAtom) ? 'dark' : 'light' }
})
