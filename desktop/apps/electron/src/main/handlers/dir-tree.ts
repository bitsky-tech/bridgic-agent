/**
 * Async directory walkers behind the `fs.listDir` / `fs.searchDir` IPC
 * channels. Kept electron-free (node:fs/promises only) so it's testable
 * under `bun:test` — same split as `sanitize.ts` next to `logged-handle.ts`.
 *
 * Root-cause performance contract (agreed with the user):
 *   - Everything is `fs/promises` — NEVER readdirSync: a big walk must not
 *     block the main-process event loop (it froze ALL IPC, not just the UI).
 *   - `listDir` reads ONE level: names+kinds come from dirents (one readdir
 *     batch, no per-file stat); file sizes are stat'ed only when the level
 *     is small enough to be "what the user is looking at"
 *     (LIST_DIR_STAT_LIMIT) — stat is the per-file cost, names are ~free.
 *   - `searchDir` walks names-only under a TIME budget and ships back only
 *     the ranked top hits, stat-ing sizes for just those. partial=true when
 *     the budget expired — the UI says "results may be incomplete".
 *   - Directory symlinks are never followed (loop safety) during search;
 *     browse may expand them explicitly (each expand is a fresh listDir).
 *   - Per-level ordering: normal folders → normal files → hidden folders →
 *     hidden files (each group locale-sorted).
 */
import * as fsp from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import * as path from 'node:path'
import {
  LIST_DIR_STAT_LIMIT,
  type DirListResult,
  type DirTreeNode,
  type SearchDirRequest,
  type SearchDirResult,
} from '../../shared/dir-tree'
import {
  searchEntries,
  SEARCH_MAX_RESULTS,
  type FileSearchEntry,
} from '../../shared/file-search'

/** Search walk time budget. Names-only enumeration covers ~50-100k entries
 *  in this window on an SSD; beyond that we return partial results. */
export const SEARCH_TIME_BUDGET_MS = 300

/** Belt-and-suspenders cap on entries VISITED per search (not per results). */
const SEARCH_VISIT_LIMIT = 200_000

/** Hidden = dotfile name (macOS/Linux convention). */
function isHidden(name: string): boolean {
  return name.startsWith('.')
}

/** Per-level sort: normal folders → normal files → hidden folders → hidden
 *  files; locale order within each group. */
function compareEntries(a: Dirent, b: Dirent): number {
  const aHidden = isHidden(a.name) ? 1 : 0
  const bHidden = isHidden(b.name) ? 1 : 0
  if (aHidden !== bHidden) return aHidden - bHidden
  const aDir = a.isDirectory() ? 0 : 1
  const bDir = b.isDirectory() ? 0 : 1
  if (aDir !== bDir) return aDir - bDir
  return a.name.localeCompare(b.name)
}

/** Classify one dirent, resolving symlinks shallowly (never followed into).
 *  Returns null for broken symlinks / sockets / FIFOs / devices. */
async function classifyDirent(
  d: Dirent,
  parentAbs: string,
): Promise<{ kind: 'file' | 'folder' } | null> {
  if (d.isDirectory()) return { kind: 'folder' }
  if (d.isFile()) return { kind: 'file' }
  if (d.isSymbolicLink()) {
    try {
      const target = await fsp.stat(path.join(parentAbs, d.name))
      if (target.isDirectory()) return { kind: 'folder' }
      if (target.isFile()) return { kind: 'file' }
    } catch {
      return null // broken symlink
    }
  }
  return null
}

/**
 * Read ONE directory level. `relBase` ('' for the mount root) prefixes the
 * returned nodes' relPaths so the renderer can graft them in place.
 */
export async function listDir(absPath: string, relBase = ''): Promise<DirListResult> {
  let dirents: Dirent[]
  try {
    const st = await fsp.stat(absPath)
    if (!st.isDirectory()) return { ok: false, reason: 'not-a-dir' }
    dirents = await fsp.readdir(absPath, { withFileTypes: true })
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' }
    // EACCES/EPERM is what macOS TCC returns for an un-granted folder
    // (~/Downloads, another app's data dir …) — surfaced separately so the
    // UI can point at System Settings instead of saying "read failed".
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, reason: 'denied' }
    return { ok: false, reason: 'error' }
  }
  dirents.sort(compareEntries)

  const nodes: DirTreeNode[] = []
  for (const d of dirents) {
    const cls = await classifyDirent(d, absPath)
    if (!cls) continue
    nodes.push({
      name: d.name,
      kind: cls.kind,
      relPath: relBase === '' ? d.name : `${relBase}/${d.name}`,
      sizeBytes: null,
    })
  }

  // Sizes only for human-scale levels — stat is the per-file cost; a 50k-entry
  // flat dir renders names instantly instead of stalling on 50k stats.
  if (nodes.length <= LIST_DIR_STAT_LIMIT) {
    await Promise.all(
      nodes.map(async (n) => {
        if (n.kind !== 'file') return
        try {
          n.sizeBytes = (await fsp.stat(path.join(absPath, n.name))).size
        } catch {
          // stat race (deleted mid-list) — keep the entry, size unknown.
        }
      }),
    )
  }
  return { ok: true, nodes }
}

/**
 * Names-only recursive search across mount roots, under a time budget.
 * Collects entries (BFS, shallow-first — matches the ranking's "shallower
 * wins" bias when the budget cuts deep tails), scores them with the shared
 * tiered matcher, then stats sizes for just the returned hits.
 */
export async function searchDir(req: SearchDirRequest): Promise<SearchDirResult> {
  const limit = req.limit ?? SEARCH_MAX_RESULTS
  const deadline = Date.now() + SEARCH_TIME_BUDGET_MS
  const entries: FileSearchEntry[] = []
  // Scoring spread-copies the entry (its object identity changes), so we look
  // the absolute path back up by a `${mountId}:${relPath}` string key.
  const absByKey = new Map<string, string>()
  let partial = false

  for (const root of req.roots) {
    // The mount root itself is a candidate (searchable by its name).
    const rootEntry: FileSearchEntry = {
      name: root.mountName,
      kind: 'folder',
      relPath: '',
      crumb: [],
      sizeBytes: null,
      mountId: root.mountId,
      mountName: root.mountName,
    }
    entries.push(rootEntry)
    absByKey.set(`${root.mountId}:`, root.absPath)

    const queue: Array<{ abs: string; rel: string; crumb: string[] }> = [
      { abs: root.absPath, rel: '', crumb: [root.mountName] },
    ]
    while (queue.length > 0) {
      if (Date.now() > deadline || entries.length >= SEARCH_VISIT_LIMIT) {
        partial = true
        break
      }
      const item = queue.shift() as { abs: string; rel: string; crumb: string[] }
      let dirents: Dirent[]
      try {
        dirents = await fsp.readdir(item.abs, { withFileTypes: true })
      } catch {
        continue // unreadable / vanished mid-walk — skip silently
      }
      dirents.sort(compareEntries)
      for (const d of dirents) {
        // Search never follows symlinks (loop safety) and skips specials —
        // dirent-only classification, zero stat calls on this path.
        const isDir = d.isDirectory()
        if (!isDir && !d.isFile()) continue
        const childAbs = path.join(item.abs, d.name)
        const childRel = item.rel === '' ? d.name : `${item.rel}/${d.name}`
        const entry: FileSearchEntry = {
          name: d.name,
          kind: isDir ? 'folder' : 'file',
          relPath: childRel,
          crumb: item.crumb,
          sizeBytes: null,
          mountId: root.mountId,
          mountName: root.mountName,
        }
        entries.push(entry)
        absByKey.set(`${root.mountId}:${childRel}`, childAbs)
        if (isDir) {
          queue.push({ abs: childAbs, rel: childRel, crumb: [...item.crumb, d.name] })
        }
      }
    }
    if (partial) break
  }

  const { hits, total } = searchEntries(entries, req.query, limit)

  // Sizes for the ≤50 displayed hits only.
  await Promise.all(
    hits.map(async (h) => {
      if (h.kind !== 'file') return
      const abs = absByKey.get(`${h.mountId}:${h.relPath}`)
      if (!abs) return
      try {
        h.sizeBytes = (await fsp.stat(abs)).size
      } catch {
        // vanished since the walk — leave size unknown.
      }
    }),
  )

  return { hits, total, partial }
}
