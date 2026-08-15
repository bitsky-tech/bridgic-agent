/**
 * Settings bridge + writers — split out of atoms/settings.ts (which keeps the
 * atoms). useSettingsBridge mounts once at the App root; useSetSettings /
 * useUpdateSettings are thin wrappers over `updateSettingsAtom` (the
 * read-modify-write + persist + failure-resync logic lives in the atom, so
 * same-tick updates never see a stale closure snapshot).
 */
import { useCallback, useEffect } from 'react'
import { useSetAtom } from 'jotai'
import type { GuiSettings } from '@app/shared/types'
import { applyExternalSettingsAtom, osPrefersDarkAtom, updateSettingsAtom } from '@/atoms/settings'
import { rlog } from '@/lib/logger'

/**
 * Mount once at the App root. Resyncs the settings atom from disk truth,
 * pulls the current `osPrefersDark`, and subscribes to settings +
 * system-theme push events from main.
 */
export function useSettingsBridge(): void {
  // Whole-blob snapshots always land through applyExternalSettingsAtom — it
  // drops stale snapshots while a local write is in flight, so changes not yet
  // persisted don't get rolled back (see that atom's TSDoc).
  const setSettings = useSetAtom(applyExternalSettingsAtom)
  const setOsPrefersDark = useSetAtom(osPrefersDarkAtom)

  useEffect(() => {
    let cancelled = false
    // The seed comes from additionalArguments frozen at BrowserWindow creation
    // — Cmd+R does not recreate the window, so changes persisted since (theme
    // etc.) are invisible in the seed. Fetch disk truth once on mount and
    // overwrite, eliminating the whole-blob staleness after a reload.
    void window.api.settings
      .get()
      .then((fresh) => {
        if (!cancelled) setSettings(fresh)
      })
      .catch((err: unknown) => rlog.error('[settings] boot resync fetch failed', err))
    void window.api.system
      .osPrefersDark()
      .then((dark) => {
        if (!cancelled) setOsPrefersDark(dark)
      })
      .catch((err: unknown) => rlog.error('[settings] osPrefersDark fetch failed', err))

    const unsubSettings = window.api.events.onSettingsChanged((next) => {
      setSettings(next)
    })
    const unsubTheme = window.api.events.onSystemThemeChanged((dark) => {
      setOsPrefersDark(dark)
    })

    return () => {
      cancelled = true
      unsubSettings()
      unsubTheme()
    }
  }, [setSettings, setOsPrefersDark])
}

/**
 * Write the entire GuiSettings blob. Optimistic update + persist + broadcast
 * (which `useSettingsBridge` listens to — so the change can also propagate to
 * other windows in future). Delegates to `updateSettingsAtom`.
 */
export function useSetSettings(): (next: GuiSettings) => Promise<void> {
  const update = useSetAtom(updateSettingsAtom)
  return useCallback(async (next) => update(() => next), [update])
}

/**
 * Convenience: take a "recipe" callback that produces a new GuiSettings from
 * the current one (immer-style, but plain spread + replace). The recipe runs
 * inside the atom setter against the LIVE value — safe for back-to-back
 * updates in the same tick.
 */
export function useUpdateSettings(): (recipe: (prev: GuiSettings) => GuiSettings) => Promise<void> {
  return useSetAtom(updateSettingsAtom)
}
