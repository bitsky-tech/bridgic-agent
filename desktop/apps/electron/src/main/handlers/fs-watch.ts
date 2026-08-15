/**
 * `fs:setWatchDirs` handler + the live FSWatcher registry that keeps the
 * session-file tree consistent with disk.
 *
 * Model (declarative): the renderer pushes the WHOLE set of currently-expanded
 * directory paths via `fs.setWatchDirs`; this module reconciles its live
 * watchers to match (start new, close vanished — see `reconcileWatchSet`).
 * Each watcher is NON-recursive (`fs.watch`, cross-platform incl. Linux) and
 * only signals "this level changed, re-read it" — filenames are ignored
 * (snapshot semantics: the renderer re-reads the level fresh via `fs.listDir`).
 * Raw events are debounced per-dir (`DEBOUNCE_MS`) to swallow the duplicate
 * fires macOS emits, then broadcast as `events.fsChanged` to every window.
 *
 * Non-obvious deps:
 *  - Watches LOCAL disk directly (the mount flow already assumes the GUI is
 *    co-located with the daemon host).
 *  - Broadcasts to ALL windows (mirrors backend.ts / system.ts); the renderer
 *    maps a changed abs path back to its mount level.
 *  - `disposeAllWatchers()` MUST run on quit/window-all-closed (index.ts) so we
 *    never leak FSWatcher handles / file descriptors.
 */
import { watch, type FSWatcher } from 'node:fs'
import { BrowserWindow } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { handlerLog } from '../logger'
import { loggedHandle } from './logged-handle'
import { reconcileWatchSet } from './fs-watch-core'

/** Per-dir debounce: collapse the burst (macOS fires twice; editors
 *  write-then-rename) into a single re-read signal. */
const DEBOUNCE_MS = 150

interface WatchEntry {
  watcher: FSWatcher
  timer: ReturnType<typeof setTimeout> | null
}

/** Live watchers keyed by absolute dir path. Module singleton — there is one
 *  watch set for the app (broadcast to all windows). */
const watchers = new Map<string, WatchEntry>()

/** Tell every window "this dir changed → re-read its level". */
function broadcastChange(path: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(IPC.events.fsChanged, { path })
  }
}

/** Debounced per-dir change signal — only fires if the dir is still watched. */
function scheduleChange(path: string): void {
  const entry = watchers.get(path)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.timer = setTimeout(() => {
    entry.timer = null
    broadcastChange(path)
  }, DEBOUNCE_MS)
}

function stopWatcher(path: string): void {
  const entry = watchers.get(path)
  if (!entry) return
  if (entry.timer) clearTimeout(entry.timer)
  entry.watcher.close()
  watchers.delete(path)
}

function startWatcher(path: string): void {
  if (watchers.has(path)) return
  try {
    // recursive:false — cross-platform reliable (recursive is unsupported on
    // Linux). We watch exactly the expanded levels, so per-level is enough.
    const watcher = watch(path, { recursive: false }, () => scheduleChange(path))
    // A watcher whose target later vanishes emits 'error' — surface it as one
    // more change so the renderer re-reads (→ not-found → prunes the node).
    watcher.on('error', () => {
      broadcastChange(path)
      stopWatcher(path)
    })
    watchers.set(path, { watcher, timer: null })
  } catch (err) {
    // Target vanished between the renderer's snapshot and this call (ENOENT),
    // or perms — tell the renderer to re-read so its tree/prune converges.
    handlerLog.debug(`[fs-watch] watch failed: ${path}`, err)
    broadcastChange(path)
  }
}

/** Reconcile the live watch set to exactly `paths` (declarative, idempotent). */
function setWatchDirs(paths: string[]): void {
  const { toAdd, toRemove } = reconcileWatchSet(watchers.keys(), paths)
  for (const p of toRemove) stopWatcher(p)
  for (const p of toAdd) startWatcher(p)
}

/** Close every live watcher — call on app quit / window-all-closed (index.ts).
 *  Safe to call repeatedly; the renderer re-syncs the set when a window returns. */
export function disposeAllWatchers(): void {
  for (const path of [...watchers.keys()]) stopWatcher(path)
}

export function registerFsWatchHandlers(): void {
  loggedHandle(IPC.fs.setWatchDirs, (_event, paths: string[]): void => {
    setWatchDirs(Array.isArray(paths) ? paths : [])
  })
}
