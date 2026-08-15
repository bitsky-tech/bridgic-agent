/**
 * GuiSettings atoms — state + the single write action.
 *
 * Seeded synchronously from `window.__initialSettings__` (planted by preload
 * from main's `loadGuiSettingsSync` blob). No async loading state — the
 * renderer's very first React render reads the correct settings, so themes /
 * accent / font / window sizing are right out of the gate (no FOUC).
 *
 * All writes go through `updateSettingsAtom` (read-modify-write inside the
 * setter — see its TSDoc). The bridge hooks (useSettingsBridge /
 * useSetSettings / useUpdateSettings) in hooks/use-settings-bridge.ts are
 * thin wrappers over these atoms.
 */
import { atom } from 'jotai'
import { DEFAULT_SETTINGS, type GuiSettings } from '@app/shared/types'
import { rlog } from '@/lib/logger'

declare global {
  interface Window {
    __initialSettings__?: GuiSettings | null
  }
}

// `globalThis.window?.`, not a bare `window.` — the optional chain is the whole
// point, and it is not defensive clutter.
//
// This runs at MODULE SCOPE, so a bare `window` makes merely importing this file
// throw wherever the global is absent. That is not hypothetical: under bun:test
// only the files that register happy-dom have a `window`, and any test that
// imports this module without one used to die with `ReferenceError: window is
// not defined` — then leave the half-evaluated module in the loader cache, so
// every later importer got `Cannot access 'settingsAtom' before initialization`
// instead of the real cause. One unlucky file order turned into 119 failures
// across the suite, none of which named this line.
//
// The renderer always has a `window`, so nothing changes there: preload plants
// `__initialSettings__` before any module here runs. The fallback to
// DEFAULT_SETTINGS is the same value a renderer would get if preload had
// planted nothing.
const seed: GuiSettings = globalThis.window?.__initialSettings__ ?? DEFAULT_SETTINGS

export const settingsAtom = atom<GuiSettings>(seed)
export const osPrefersDarkAtom = atom<boolean>(false)

/** Number of in-flight `settings.set` calls. When >0, any external whole-blob
 *  snapshot is necessarily older than the local optimistic value — see
 *  `applyExternalSettingsAtom`. */
const inFlightWritesAtom = atom(0)

/**
 * Write action: optimistic update + persist to main.
 *
 * Read-modify-write happens INSIDE the setter, so two updates in the same
 * tick both apply — the previous hook-level `useAtomValue` closure read a
 * render-time snapshot and silently dropped the first of two rapid updates.
 *
 * On IPC failure the atom resyncs from disk truth (`settings.get()`) instead
 * of keeping an optimistic value the disk never accepted.
 */
export const updateSettingsAtom = atom(
  null,
  async (get, set, recipe: (prev: GuiSettings) => GuiSettings): Promise<void> => {
    const next = recipe(get(settingsAtom))
    set(settingsAtom, next)
    set(inFlightWritesAtom, get(inFlightWritesAtom) + 1)
    try {
      await window.api.settings.set(next)
    } catch (err) {
      rlog.error('[settings] persist failed, resyncing from disk', err)
      try {
        set(settingsAtom, await window.api.settings.get())
      } catch (resyncErr) {
        // Disk truth is unreadable too (total IPC failure) — keep the
        // optimistic value so the UI at least stays self-consistent.
        rlog.error('[settings] resync from disk failed', resyncErr)
      }
    } finally {
      set(inFlightWritesAtom, get(inFlightWritesAtom) - 1)
    }
  },
)

/**
 * Apply a whole-blob snapshot that came from OUTSIDE this renderer's own
 * optimistic state — main's `settings:changed` broadcast, or the boot
 * `settings.get()` resync.
 *
 * Dropped while a write is in flight: the snapshot was produced before that
 * write landed, so applying it silently ROLLS BACK the pending change. That
 * is how a session click could bounce the user back to Schedules — `activeNavAtom`
 * derives from `ui.lastNav`, and `useActiveSessionPersistence` (settings-in →
 * settings-out) turned each rollback into another write, amplifying the churn.
 */
export const applyExternalSettingsAtom = atom(null, (get, set, next: GuiSettings) => {
  if (get(inFlightWritesAtom) > 0) return
  set(settingsAtom, next)
})
