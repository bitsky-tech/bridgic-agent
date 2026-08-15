/**
 * Generic per-session JSON-blob persistence: load ONCE on mount → seed the
 * atom, then debounced-save the whole map on change. Backs both
 * useDraftPersistence + useSpecCommentPersistence (§1.27 — same load-once +
 * gated-save orchestration, diverging only on "whether to prune before save").
 *
 * Key invariant (gate): save is blocked by the loadedRef gate until the first
 * load succeeds — otherwise the empty initial atom would overwrite disk. Neither
 * a cancelled effect (StrictMode double-mount / fast unmount) nor a failed load
 * opens the gate: opening it while the atom is still the empty initial value
 * would let the debounced save overwrite the on-disk blob with `{}`, wiping out
 * every entry permanently. The cost is that saves are disabled for this run (new
 * entries aren't persisted), which beats destroying the existing ones.
 *
 * `prepareSave` lets consumers transform before persisting (drafts prune empty
 * drafts; spec-comments pass through as-is).
 *
 * Stability: `load`/`save` are passed as `window.api.x.load` (a fixed preload
 * reference, stable across renders), so the load effect runs only once and does
 * not reload on every render.
 */
import { useEffect, useRef } from 'react'
import { rlog } from '@/lib/logger'
import { useDebouncedEffect } from './useDebouncedEffect'

const SAVE_DEBOUNCE_MS = 500

const identity = <T>(value: Record<string, T>): Record<string, T> => value

export function useBlobPersistence<T>(
  value: Record<string, T>,
  setAll: (next: Record<string, T>) => void,
  load: () => Promise<unknown>,
  save: (value: Record<string, T>) => Promise<void>,
  label: string,
  prepareSave: (value: Record<string, T>) => Record<string, T> = identity,
): void {
  const loadedRef = useRef(false)

  // 1. Load once.
  useEffect(() => {
    let cancelled = false
    void load()
      .then((raw) => {
        if (cancelled) return
        setAll(raw as Record<string, T>)
        loadedRef.current = true
      })
      .catch((err: unknown) =>
        rlog.warn(`[${label}] load failed; saves stay disabled this run`, err),
      )
    return () => {
      cancelled = true
    }
  }, [load, setAll, label])

  // 2. Save on change (debounced), gated until the initial load resolved.
  useDebouncedEffect(
    () => {
      if (!loadedRef.current) return
      void save(prepareSave(value)).catch((err: unknown) => rlog.warn(`[${label}] save failed`, err))
    },
    [value],
    SAVE_DEBOUNCE_MS,
  )
}
