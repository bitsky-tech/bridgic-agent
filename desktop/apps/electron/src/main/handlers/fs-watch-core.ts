/**
 * Pure, electron-free helpers for the fs-watch registry (`./fs-watch.ts`).
 *
 * Extracted so bun:test can exercise the watch-set reconcile logic without
 * importing Electron (which can't load outside an Electron process). The
 * stateful parts (FSWatcher
 * handles, debounce timers, `webContents.send`) stay in the handler; only
 * the set-diff lives here.
 */

/** The minimal diff to bring the live watch set to `desired`: which absolute
 *  paths to start watching, which to stop. Idempotent — equal sets yield
 *  empty arrays. Inputs are deduped; empty/blank paths are dropped (a blank
 *  path would watch the process cwd — never intended). */
export function reconcileWatchSet(
  current: Iterable<string>,
  desired: Iterable<string>,
): { toAdd: string[]; toRemove: string[] } {
  const cur = new Set([...current].filter((p) => p.length > 0))
  const want = new Set([...desired].filter((p) => p.length > 0))
  const toAdd = [...want].filter((p) => !cur.has(p))
  const toRemove = [...cur].filter((p) => !want.has(p))
  return { toAdd, toRemove }
}
