/**
 * Renderer-side file-tree helpers: graft lazily-loaded directory levels into
 * a per-mount snapshot, plus display utilities (icon tint, size formatting).
 *
 * The SEARCH scorer lives in `@shared/file-search` (it runs in the MAIN
 * process — `fs.searchDir` walks and scores where the data lives, so whole
 * trees never cross IPC). This module only handles the BROWSE side: each
 * expanded level arrives via `fs.listDir` and is grafted in place.
 */
import type { DirTreeNode } from '@shared/dir-tree'

/** Prefix every node's relPath with `prefix/` (recursively) — used to rebase
 *  a lazily-read level (whose relPaths are relative to the SUBDIR) into
 *  mount-root coordinates before grafting. No-op prefix ('') returns nodes
 *  unchanged in coordinates (mount root level). */
export function rebaseTree(nodes: DirTreeNode[], prefix: string): DirTreeNode[] {
  if (prefix === '') return nodes
  return nodes.map((n) => ({
    ...n,
    relPath: `${prefix}/${n.relPath}`,
    ...(n.children ? { children: rebaseTree(n.children, prefix) } : {}),
  }))
}

/** Immutably replace the node at `relPath` with an updated copy: set its
 *  `children` (lazy level arrived) or mark it `unreadable` (load failed).
 *  Unknown relPath (node vanished after a root re-read) → tree unchanged. */
export function graftTree(
  nodes: DirTreeNode[],
  relPath: string,
  update: { children: DirTreeNode[] } | { unreadable: true },
): DirTreeNode[] {
  return nodes.map((n) => {
    if (n.relPath === relPath) {
      if ('children' in update) {
        // Clear a stale `unreadable` after a successful re-read (the directory's
        // permissions may have been fixed).
        const { unreadable: _drop, ...rest } = n
        return { ...rest, children: update.children }
      }
      const { children: _dropChildren, ...rest } = n
      return { ...rest, unreadable: true as const }
    }
    // Recurse only down the target's ancestor chain (relPath prefix match);
    // every other subtree is reused as-is.
    if (n.children && relPath.startsWith(`${n.relPath}/`)) {
      return { ...n, children: graftTree(n.children, relPath, update) }
    }
    return n
  })
}

/** Find a node by relPath inside a grafted snapshot (ancestor-chain walk). */
export function findNode(nodes: DirTreeNode[], relPath: string): DirTreeNode | null {
  for (const n of nodes) {
    if (n.relPath === relPath) return n
    if (n.children && relPath.startsWith(`${n.relPath}/`)) {
      return findNode(n.children, relPath)
    }
  }
  return null
}

/** The expanded-folder set with disk-vanished entries filtered out.
 *
 *  Keeps a relPath only while its PARENT level is still unloaded (can't judge —
 *  the reload window right after a root re-read) OR its parent lists it as a
 *  readable folder. A parent that IS loaded but no longer lists it (or lists it
 *  as a file / unreadable) drops it. Filtering at READ (derived) lets the
 *  caller avoid a setState-in-effect reconcile. `nodes` is the grafted root
 *  snapshot (`DirListResult.nodes`); pass the live set unchanged when the
 *  snapshot isn't loaded yet. */
export function pruneExpanded(
  expanded: ReadonlySet<string>,
  nodes: DirTreeNode[],
): ReadonlySet<string> {
  const next = new Set<string>()
  for (const relPath of expanded) {
    const slash = relPath.lastIndexOf('/')
    const parent = slash === -1 ? '' : relPath.slice(0, slash)
    const siblings = parent === '' ? nodes : findNode(nodes, parent)?.children
    if (siblings === undefined) {
      next.add(relPath) // parent level not loaded → can't judge, keep it
      continue
    }
    const node = siblings.find((n) => n.relPath === relPath)
    if (node && node.kind === 'folder' && !node.unreadable) next.add(relPath)
    // else: parent loaded but the entry is missing / not a folder → confirmed gone, drop it
  }
  return next
}

/** Tailwind text-color class per file extension — values mirror the design's
 *  fileTint palette (low-saturation, restrained). Full string literals so
 *  Tailwind v4 content scanning picks them up. */
const EXT_COLOR: Record<string, string> = {
  zip: 'text-[#E0A33A]',
  rar: 'text-[#E0A33A]',
  '7z': 'text-[#E0A33A]',
  tar: 'text-[#E0A33A]',
  gz: 'text-[#E0A33A]',
  xlsx: 'text-[#3FA86B]',
  xls: 'text-[#3FA86B]',
  csv: 'text-[#3FA86B]',
  pdf: 'text-[#E2574C]',
  doc: 'text-[#3B82C4]',
  docx: 'text-[#3B82C4]',
}

/** Icon tint class: folders brand-blue, files by extension, default tertiary. */
export function extColor(name: string, kind: 'file' | 'folder'): string {
  if (kind === 'folder') return 'text-text-accent'
  const ext = (name.split('.').pop() ?? '').toLowerCase()
  return EXT_COLOR[ext] ?? 'text-text-tertiary'
}

/** Human-readable size: bytes → "245 KB" / "1.2 MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
