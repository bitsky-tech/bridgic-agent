/**
 * MountRow — one session-file mount rendered as a tree root row, expanding
 * into its on-disk subtree (`FileTreeView`). Extracted from SessionAssets.tsx
 * to keep that file under the §1.14 size budget.
 *
 * Expansion re-reads the tree from disk EVERY time (snapshot semantics —
 * only the mount root lives in the daemon registry; see atoms/mounts.ts).
 * The ⋯ menu (copy path / open / remove) lives on root rows only; every row
 * (root + subtree) hover-reveals an @ that enqueues a composer mention —
 * subtree rows carry their mount-relative `path`.
 */
import { useEffect, useMemo, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { cn } from '@/lib/cn'
import { isDocxFileName } from '@/lib/fileTypes'
import { extColor, findNode, formatSize, pruneExpanded } from '@/lib/fileTree'
import { APP_PRODUCT_NAME } from '@shared/app-meta'
import type { DirListResult, DirTreeNode } from '@shared/dir-tree'
import type { MountSummary } from '@/lib/amphiClient'
import {
  contributeWatchedLevelsAtom,
  loadMountLevelAtom,
  loadMountRootAtom,
  mountTreeFamily,
  type WatchedLevel,
} from '@/atoms/mounts'
import { Icons } from './Icons'
import { RowActionMenu } from './RowActionMenu'
import { Tooltip } from './Tooltip'
import { FileTreeView, type TreeRowMenu } from './FileTreeView'

/** Right-aligned meta of a mount root row: size / item count / stale marker.
 *
 *  A folder shows its count ONLY while expanded, from the LIVE root snapshot
 *  (`tree.nodes.length`) — the exact number of rows visible below, kept
 *  consistent with disk by fs-watch re-reads. Collapsed folders show nothing:
 *  the daemon never reads a mounted directory (listing one trips the macOS TCC
 *  prompt and walks the whole tree), so `item_count` is always null and there
 *  is no honest number to print until the user expands the row. */
function mountMeta(m: MountSummary, tree: DirListResult | undefined, t: TFunction): string {
  if (!m.exists) return t('asset.mount.pathStale')
  if (m.kind === 'folder') return tree?.ok ? t('asset.mount.itemCount', { n: tree.nodes.length }) : ''
  return formatSize(m.size_bytes ?? 0)
}

export interface MountRowProps {
  mount: MountSummary
  sessionId: string
  menuOpen: boolean
  onMenuToggle: () => void
  onCopyPath: () => void
  onOpenInFileManager: () => void
  /** Absent for system-owned roots such as the Session `.work` directory. */
  onRemove?: () => void
  onMentionRoot: () => void
  onMentionChild: (node: DirTreeNode) => void
  /** Child-row ⋯ menu (the single-open state lives in the panel, keyed by relPath; no "remove" — child items are not mounts). */
  childMenuFor: string | null
  onChildMenuToggle: (relPath: string) => void
  onCopyChildPath: (node: DirTreeNode) => void
  onRevealChild: (node: DirTreeNode) => void
  /** Open a file-type mount root. DOCX uses single-click; other file types use double-click. */
  onOpenRoot: () => void
  /** Open a child file row. DOCX uses single-click; other file types use double-click. */
  onOpenChild: (node: DirTreeNode) => void
}

/** One mount root as a tree-style row; folder mounts expand into their
 *  on-disk subtree (fresh read per expand). */
export function MountRow({
  mount: m,
  sessionId,
  menuOpen,
  onMenuToggle,
  onCopyPath,
  onOpenInFileManager,
  onRemove,
  onMentionRoot,
  onMentionChild,
  childMenuFor,
  onChildMenuToggle,
  onCopyChildPath,
  onRevealChild,
  onOpenRoot,
  onOpenChild,
}: MountRowProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [expandedChildren, setExpandedChildren] = useState<ReadonlySet<string>>(new Set())
  const tree = useAtomValue(mountTreeFamily(m.id))
  const loadRoot = useSetAtom(loadMountRootAtom)
  const loadLevel = useSetAtom(loadMountLevelAtom)
  const contributeWatched = useSetAtom(contributeWatchedLevelsAtom)

  // Effective expanded set = the expanded set minus entries that have disappeared from disk (decision D3: derive, do not self-heal via setState).
  // Rendering / self-healing / watch contributions all use it; the raw expandedChildren is only the toggle store.
  const effectiveExpanded = useMemo(
    () => (tree?.ok ? pruneExpanded(expandedChildren, tree.nodes) : expandedChildren),
    [expandedChildren, tree],
  )

  const expandable = m.kind === 'folder' && m.exists
  // DOCX roots open in the Word surface on one click; other files retain the established double-click behaviour.
  const rootOpenable = m.kind === 'file' && m.exists
  const rootOpensOnClick = rootOpenable && isDocxFileName(m.name)
  const toggleRoot = (): void => {
    if (rootOpensOnClick) {
      onOpenRoot()
      return
    }
    if (!expandable) return
    if (!open) {
      // Every root expansion re-reads this level from disk (snapshot semantics): out-of-band deletions/additions are immediately visible;
      // deeper collapse state is reset along with it (each deeper level re-reads when it is expanded).
      setExpandedChildren(new Set())
      void loadRoot({ sessionId, mountId: m.id, path: m.path })
    }
    setOpen((o) => !o)
  }

  const toggleChild = (node: DirTreeNode): void => {
    const opening = !expandedChildren.has(node.relPath)
    // Freshness: every expansion re-reads this level (never reuse previously grafted content); still only the
    // level being expanded is read, deeper levels are read when they are expanded themselves.
    if (opening) {
      void loadLevel({ mountId: m.id, mountPath: m.path, relPath: node.relPath })
    }
    setExpandedChildren((prev) => {
      const next = new Set(prev)
      if (next.has(node.relPath)) next.delete(node.relPath)
      else next.add(node.relPath)
      return next
    })
  }

  // Declarative self-healing: an expand marker exists but that level's content is missing (the snapshot was reset by the
  // @ popover's open-edge, or a race scrambled it) → read it again automatically. loadLevel dedupes in-flight requests, and
  // once children land (or unreadable), the effect converges naturally — a "permanently loading" state is mechanically impossible.
  useEffect(() => {
    if (!open || !tree?.ok) return
    for (const relPath of effectiveExpanded) {
      const node = findNode(tree.nodes, relPath)
      if (node && node.kind === 'folder' && !node.unreadable && node.children === undefined) {
        void loadLevel({ mountId: m.id, mountPath: m.path, relPath })
      }
    }
  }, [open, tree, effectiveExpanded, loadLevel, m.id, m.path])

  // Contribute this mount's "currently expanded" directory levels to fs-watch: the root (while open) + the effectively expanded subdirectories
  // (vanished entries are already filtered out by effectiveExpanded). useFsWatchBridge unions them and pushes them to the main process to watch;
  // unmounting (switching sessions / removing the mount) withdraws them via the cleanup below.
  useEffect(() => {
    const levels: WatchedLevel[] = []
    if (open && expandable) {
      levels.push({ mountId: m.id, mountPath: m.path, relPath: '', absPath: m.path })
      for (const relPath of effectiveExpanded) {
        levels.push({ mountId: m.id, mountPath: m.path, relPath, absPath: `${m.path}/${relPath}` })
      }
    }
    contributeWatched({ mountId: m.id, levels })
  }, [open, expandable, effectiveExpanded, m.id, m.path, contributeWatched])

  useEffect(() => {
    return () => contributeWatched({ mountId: m.id, levels: [] })
  }, [m.id, contributeWatched])

  return (
    <div>
      <div
        onClick={toggleRoot}
        onDoubleClick={() => {
          if (rootOpenable && !rootOpensOnClick) onOpenRoot()
        }}
        className={cn(
          'group relative flex items-center gap-1.5 px-2 py-[5px] rounded-md',
          (expandable || rootOpenable) && 'cursor-pointer hover:bg-bg-hover',
        )}
      >
        <span className="w-3.5 flex justify-center text-text-tertiary flex-shrink-0">
          {expandable && (open ? Icons.chevronDown(12) : Icons.chevronRight(12))}
        </span>
        <span
          className={cn(
            'flex flex-shrink-0',
            m.exists ? extColor(m.name, m.kind) : 'text-text-tertiary',
          )}
        >
          {m.kind === 'folder' ? Icons.folder(15) : Icons.file(14)}
        </span>
        {/* Show the **full absolute path** rather than the file name: names produced by the Agent tend to be long and
            similar, so echoing just the name says nothing; the path is what answers "which one on disk is this". Stale
            mounts additionally explain why the row is struck through and greyed out.
            Since the content carries more than the visible text, onlyWhenTruncated is deliberately not set — it is just
            as informative when the name is not truncated. */}
        <Tooltip content={m.exists ? m.path : t('asset.mount.pathWithStale', { path: m.path })}>
          <span
            className={cn(
              'flex-1 min-w-0 text-xs font-medium font-mono truncate',
              m.exists ? 'text-text-primary' : 'text-text-tertiary line-through',
            )}
          >
            {m.name}
          </span>
        </Tooltip>
        <span className="text-2xs text-text-tertiary flex-shrink-0">{mountMeta(m, tree, t)}</span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onMenuToggle()
          }}
          className={cn(
            // Same approach as session-row: always rendered, shown/hidden via opacity, to avoid
            // row-height jitter on hover (§LS1); flex items-center removes the svg's baseline gap.
            'flex items-center text-text-tertiary p-0.5 cursor-pointer flex-shrink-0 hover:text-text-primary transition-opacity',
            menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
          )}
          aria-label={t('asset.mount.actions', { name: m.name })}
          aria-expanded={menuOpen}
        >
          {Icons.dots(14)}
        </button>
        {menuOpen && (
          <RowActionMenu
            onDismiss={onMenuToggle}
            items={[
              { label: t('asset.common.copyPath'), onSelect: onCopyPath },
              { label: t('asset.common.revealInFileManager'), onSelect: onOpenInFileManager },
              ...(onRemove
                ? [{
                  label: (
                    <>
                      {t('asset.mount.remove')}
                      <span className="block text-2xs text-text-tertiary">
                        {t('asset.mount.removeHint')}
                      </span>
                    </>
                  ),
                  onSelect: onRemove,
                  tone: 'danger' as const,
                  separated: true,
                }]
                : []),
            ]}
          />
        )}
        <button
          type="button"
          // Do not steal focus from the editor: keeping the input caret is what lets @ be inserted where the user clicked rather than at the end.
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onMentionRoot()
          }}
          aria-label={t('asset.common.addToChat', { name: m.name })}
          className="w-4 text-center text-xs font-semibold text-text-accent flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          @
        </button>
      </div>

      {open && (
        <MountSubtree
          tree={tree}
          expanded={effectiveExpanded}
          onToggle={toggleChild}
          onMention={onMentionChild}
          onOpen={onOpenChild}
          absPathOf={(node) => `${m.path}/${node.relPath}`}
          menu={{
            menuFor: childMenuFor,
            onToggle: onChildMenuToggle,
            onCopyPath: onCopyChildPath,
            onReveal: onRevealChild,
          }}
        />
      )}
    </div>
  )
}

export interface MountSubtreeProps {
  /** undefined = the first read of the root level has not returned yet. */
  tree: DirListResult | undefined
  expanded: ReadonlySet<string>
  onToggle: (node: DirTreeNode) => void
  onMention: (node: DirTreeNode) => void
  /** Double-clicking a child file = open with the system default application. */
  onOpen: (node: DirTreeNode) => void
  /** Full absolute path shown in the child row's hover tooltip (mount root + relPath). */
  absPathOf: (node: DirTreeNode) => string
  menu: TreeRowMenu
}

const SUBTREE_MSG_CLS = 'ml-[13px] pl-[3px] px-2 py-[5px] text-2xs'

/** Why a folder level couldn't be read. `denied` is the only one the user can
 *  act on, so it carries the fix instead of a generic failure line: on macOS a
 *  mount under ~/Downloads or another app's data dir stays unreadable until
 *  access is granted, and TCC only prompts once. */
function MountSubtreeError({ reason }: { reason: Extract<DirListResult, { ok: false }>['reason'] }) {
  const { t } = useTranslation()
  if (reason === 'not-found') {
    return <div className={cn(SUBTREE_MSG_CLS, 'text-status-error')}>{t('asset.mount.pathStale')}</div>
  }
  if (reason === 'denied') {
    return (
      <Tooltip content={t('asset.tree.deniedTooltip', { product: APP_PRODUCT_NAME })}>
        <div className={cn(SUBTREE_MSG_CLS, 'text-status-warning cursor-default')}>
          {t('asset.tree.denied')}
        </div>
      </Tooltip>
    )
  }
  return <div className={cn(SUBTREE_MSG_CLS, 'text-status-error')}>{t('asset.tree.readFailed')}</div>
}

/** Expanded body under a folder mount root: loading / error / lazy tree. */
function MountSubtree({ tree, expanded, onToggle, onMention, onOpen, absPathOf, menu }: MountSubtreeProps) {
  const { t } = useTranslation()
  if (tree === undefined) {
    return <div className={cn(SUBTREE_MSG_CLS, 'text-text-tertiary')}>{t('asset.common.loading')}</div>
  }
  if (!tree.ok) return <MountSubtreeError reason={tree.reason} />

  return (
    <div className="ml-[13px] pl-[3px] border-l border-border-subtle">
      {tree.nodes.length === 0 ? (
        <div className="px-2 py-[5px] text-2xs text-text-tertiary">{t('asset.common.emptyFolder')}</div>
      ) : (
        <FileTreeView
          nodes={tree.nodes}
          expanded={expanded}
          onToggle={onToggle}
          onMention={onMention}
          onOpen={onOpen}
          absPathOf={absPathOf}
          menu={menu}
        />
      )}
    </div>
  )
}
