/**
 * fs-watch bridge — keeps the expanded session-file tree AND file-mount
 * metadata in sync with disk.
 *
 * Mount once from the root component. Two directions:
 *   - OUT: debounced-push the watch set to main = the union of every MountRow's
 *     expanded directory levels (`watchedLevelsAtom`) + every FILE mount's path
 *     (file mounts can't expand, so the tree never watches them — yet their
 *     size / invalidated state are visible and would otherwise go stale).
 *   - IN: on `fsChanged(path)`, route it: an expanded directory level → re-read
 *     that level (content); a watched file mount → debounced `loadMounts` to
 *     refresh metadata (size / exists) from the daemon.
 *
 * Folder mount ROOTS are intentionally NOT watched for metadata here: their
 * only visible metadata is the item count, which is already live via the
 * expanded tree (`tree.nodes.length`); watching a collapsed folder would fire
 * on every invisible content change → needless daemon round-trips (decision
 * D7). The @ popover adds no watchers of its own (D4) — it shares `mountTrees`
 * with the right panel. Non-Electron contexts (Playwright) get api-stub
 * no-ops, so this hook is inert there.
 */
import { useEffect, useMemo, useRef } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useDebouncedEffect } from './useDebouncedEffect'
import {
  loadMountLevelAtom,
  loadMountRootAtom,
  loadMountsAtom,
  mountsFamily,
  watchedLevelsAtom,
} from '@/atoms/mounts'
import { activeSessionIdAtom } from '@/atoms/sessions'

/** Debounce the watch-set push so a burst of expand/collapse coalesces into a
 *  single round-trip (the watcher already debounces the reverse direction). */
const SYNC_DELAY_MS = 150

/** Coalesce metadata refreshes: one `loadMounts` per burst (it re-stats ALL
 *  mounts in a single daemon call, so per-file fan-out is unnecessary). */
const META_DEBOUNCE_MS = 200

export function useFsWatchBridge(): void {
  const levels = useAtomValue(watchedLevelsAtom)
  const loadRoot = useSetAtom(loadMountRootAtom)
  const loadLevel = useSetAtom(loadMountLevelAtom)
  const loadMounts = useSetAtom(loadMountsAtom)
  const sessionId = useAtomValue(activeSessionIdAtom)
  const mounts = useAtomValue(mountsFamily(sessionId ?? ''))

  // File mounts never expand → MountRow contributes no watched level for them,
  // so their visible size / invalidated state would go stale. Watch the file itself.
  const fileMountPaths = useMemo(
    () => mounts.filter((m) => m.kind === 'file').map((m) => m.path),
    [mounts],
  )

  // Watch set = expanded directory levels (content) ∪ file-mount paths (metadata).
  // The sorted key is a stable debounce trigger: re-arm only when the SET changes.
  const absPaths = useMemo(
    () => [...new Set([...levels.map((l) => l.absPath), ...fileMountPaths])],
    [levels, fileMountPaths],
  )
  const watchKey = absPaths.join('\n')

  useDebouncedEffect(
    () => {
      void window.api.fs.setWatchDirs(absPaths)
    },
    [watchKey],
    SYNC_DELAY_MS,
  )

  // Debounce the daemon metadata refresh across a burst of file-mount changes.
  const metaTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (metaTimer.current) clearTimeout(metaTimer.current)
    },
    [],
  )

  useEffect(() => {
    const fileSet = new Set(fileMountPaths)
    return window.api.events.onFsChanged(({ path }) => {
      // Content (P1): an expanded level changed. Same abs path can map to
      // several mounts (nested / duplicate) — re-read every match.
      for (const l of levels) {
        if (l.absPath !== path) continue
        if (l.relPath === '') {
          if (sessionId) void loadRoot({ sessionId, mountId: l.mountId, path: l.mountPath })
        } else {
          void loadLevel({ mountId: l.mountId, mountPath: l.mountPath, relPath: l.relPath })
        }
      }
      // Metadata: a watched file mount changed → debounced size / invalidated-state refresh.
      if (sessionId && fileSet.has(path)) {
        if (metaTimer.current) clearTimeout(metaTimer.current)
        metaTimer.current = setTimeout(() => void loadMounts(sessionId), META_DEBOUNCE_MS)
      }
    })
  }, [levels, fileMountPaths, sessionId, loadRoot, loadLevel, loadMounts])
}
