/**
 * Directory wire types for the `fs.listDir` / `fs.searchDir` IPC channels.
 *
 * Single source of truth shared by main (walker/search), preload (bridge)
 * and renderer (right-panel tree + @ mention popover).
 *
 * Performance model (root-caused with the user — no corpus caps):
 *   - BROWSE is per-level lazy: `listDir` reads ONE directory level, async,
 *     names+kinds from dirents (no per-file stat for huge levels). Expanding
 *     a folder reads that level on demand — unlimited depth/size, and the
 *     result is always fresh from disk (never persisted; only the mount
 *     root lives in the daemon DB).
 *   - SEARCH walks where the data lives (main process, `searchDir`), names
 *     only, under a TIME budget — whole trees never cross IPC; only ≤50
 *     ranked hits do, with sizes stat'ed for just those hits.
 *
 * `relPath` is POSIX `/`-separated relative to the mount root: it doubles
 * as the mention block's `path` field on the WS wire (the daemon joins it
 * onto the mount root, fail-closed — see `WsMentionBlock` in the backend).
 */
import type { FileSearchHit } from './file-search'

export interface DirTreeNode {
  name: string
  kind: 'file' | 'folder'
  /** POSIX `/`-separated path relative to the mount root. */
  relPath: string
  /** Bytes for files when stat'ed (small levels / search hits); null otherwise. */
  sizeBytes: number | null
  /** Set when the folder couldn't be read (EACCES / read failure) — render
   *  dimmed, no expand. */
  unreadable?: true
  /** Present once this folder's level has been lazily loaded (renderer-side
   *  grafting); `listDir` itself always returns single-level nodes without
   *  children. undefined = not loaded yet (still expandable). */
  children?: DirTreeNode[]
}

/** One directory level (`fs.listDir`) — also the renderer's per-mount
 *  snapshot shape after grafting lazily-loaded levels into `nodes`.
 *
 *  `denied` is split out of `error` because it is the ONE failure the user
 *  can act on: on macOS a mount under ~/Downloads, ~/Documents or another
 *  app's data dir stays unreadable until they grant access in System
 *  Settings, and folding that into a generic "read failed" hides the only fix. */
export type DirListResult =
  | { ok: true; nodes: DirTreeNode[] }
  | { ok: false; reason: 'not-found' | 'not-a-dir' | 'denied' | 'error' }

/** One mount root to search under. */
export interface SearchRootSpec {
  mountId: string
  mountName: string
  absPath: string
}

export interface SearchDirRequest {
  roots: SearchRootSpec[]
  query: string
  /** Max hits returned (default SEARCH_MAX_RESULTS). */
  limit?: number
}

export interface SearchDirResult {
  hits: FileSearchHit[]
  /** Real match count among scanned entries. */
  total: number
  /** Walk stopped on the time budget — results may be incomplete. */
  partial: boolean
}

/** Per-level stat budget: levels up to this size get real file sizes;
 *  pathological flat dirs (10k+ entries) skip stat (names render instantly,
 *  sizes show blank). */
export const LIST_DIR_STAT_LIMIT = 2000

/** Push payload for the `events.fsChanged` channel (main → renderer).
 *
 *  `path` is the absolute directory whose listing changed (a watched, then-
 *  expanded level). Carries no per-file detail by design: snapshot semantics
 *  mean the renderer just re-reads that level fresh (`fs.listDir`). The watch
 *  set is driven declaratively by `fs.setWatchDirs` — see `main/handlers/fs-watch.ts`. */
export interface FsChangedEvent {
  path: string
}
