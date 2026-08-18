/**
 * FileTreeView — recursive lazy file tree shared by the right-panel session-files
 * section and the @ mention popover's browse mode (the spec requires the
 * two surfaces to render the SAME hierarchy).
 *
 * Lazy contract: a folder with `children === undefined` simply hasn't been
 * read yet — it IS expandable; opening it makes the host fire a one-level
 * `fs.listDir` (see atoms/mounts.ts::loadMountLevelAtom) and a "loading…"
 * row shows until the graft lands. Only `unreadable` folders don't expand.
 *
 * Huge levels render incrementally (user requirement: load while scrolling): each level
 * renders through the shared `WindowedList` — data arrives in full (one
 * readdir), only the DOM is windowed.
 *
 * Controlled: the host owns the expanded set (keyed by relPath) and the
 * snapshot. Rows follow the design handoff: 14px chevron slot, tinted type
 * icon, mono filename, right-aligned size, indent guide line.
 */
import { useTranslation } from 'react-i18next'
import type { DirTreeNode } from '@shared/dir-tree'
import { cn } from '@/lib/cn'
import { extColor, formatSize } from '@/lib/fileTree'
import { Icons } from './Icons'
import { Tooltip } from './Tooltip'
import { WindowedList } from './WindowedList'

export interface FileTreeViewProps {
  nodes: DirTreeNode[]
  /** Expanded folder relPaths. Host-owned (controlled). */
  expanded: ReadonlySet<string>
  /** Toggle a folder open/closed. The host lazy-loads the level when the
   *  node opens with `children === undefined`. */
  onToggle: (node: DirTreeNode) => void
  /** Render an @ button per row (right panel). Absent = no @ affordance. */
  onMention?: (node: DirTreeNode) => void
  /** Make file rows pickable (@ popover browse mode). */
  onPickFile?: (node: DirTreeNode) => void
  /** Double-click a FILE row → open it with the OS default program.
   *  Absent (e.g. @ popover) disables open-on-double-click; folders ignore it. */
  onOpen?: (node: DirTreeNode) => void
  /** Keyboard-selected row (@ popover); rendered with the hover background. */
  highlightRelPath?: string | null
  /** relPath → that row's **full absolute path**, used for the hover tooltip. When omitted the tooltip falls back to the file name.
   *  A row itself only holds the mount-relative relPath, and joining an absolute path needs the mount root, which only the host knows. */
  absPathOf?: (node: DirTreeNode) => string
  /** ⋯ row menu (right panel; absent in the @ popover). Host owns the
   *  single-open invariant: `menuFor` is the relPath whose menu is open.
   *  Child-row menus only have copy path / reveal in file manager — there is no "remove"
   *  (removing = unregistering a mount, which only applies to mount roots; child files are not mounts). */
  menu?: TreeRowMenu
}

/** Bundled ⋯-menu wiring threaded down every tree row (right panel only). */
export interface TreeRowMenu {
  /** relPath of the row whose menu is open (host-owned single-open state). */
  menuFor: string | null
  onToggle: (relPath: string) => void
  onCopyPath: (node: DirTreeNode) => void
  onReveal: (node: DirTreeNode) => void
}

export function FileTreeView({
  nodes,
  expanded,
  onToggle,
  onMention,
  onPickFile,
  onOpen,
  highlightRelPath,
  absPathOf,
  menu,
}: FileTreeViewProps) {
  return (
    <WindowedList items={nodes}>
      {(n) => (
        <TreeNodeRow
          key={n.relPath}
          node={n}
          expanded={expanded}
          onToggle={onToggle}
          onMention={onMention}
          onPickFile={onPickFile}
          onOpen={onOpen}
          highlightRelPath={highlightRelPath}
          absPathOf={absPathOf}
          menu={menu}
        />
      )}
    </WindowedList>
  )
}

interface TreeNodeRowProps {
  node: DirTreeNode
  expanded: ReadonlySet<string>
  onToggle: (node: DirTreeNode) => void
  onMention?: (node: DirTreeNode) => void
  onPickFile?: (node: DirTreeNode) => void
  onOpen?: (node: DirTreeNode) => void
  highlightRelPath?: string | null
  absPathOf?: (node: DirTreeNode) => string
  menu?: TreeRowMenu
}

function TreeNodeRow({
  node,
  expanded,
  onToggle,
  onMention,
  onPickFile,
  onOpen,
  highlightRelPath,
  absPathOf,
  menu,
}: TreeNodeRowProps) {
  const { t } = useTranslation()
  const isFolder = node.kind === 'folder'
  // Lazy-loading semantics: children undefined = not read yet, but still expandable (expanding is what triggers the read);
  // only unreadable folders (read failure / no permission) cannot be expanded.
  const expandable = isFolder && !node.unreadable
  const isOpen = expandable && expanded.has(node.relPath)
  const pickable = !isFolder && onPickFile !== undefined
  // Double-click to open applies to file rows only (folders keep single-click expansion); openable also makes the row show clickable feedback.
  const openable = !isFolder && onOpen !== undefined

  const handleRowClick = (): void => {
    if (expandable) onToggle(node)
    else if (pickable) onPickFile(node)
  }

  // Double-clicking a file = open with the system default application; double-clicking a folder does nothing extra (single-click expansion as before).
  const handleDoubleClick = (): void => {
    if (openable) onOpen?.(node)
  }

  const menuOpen = menu !== undefined && menu.menuFor === node.relPath

  return (
    <div>
      <div
        onClick={handleRowClick}
        onDoubleClick={handleDoubleClick}
        className={cn(
          'group/tree-row relative flex items-center gap-1.5 px-2 py-[5px] rounded-md',
          (expandable || pickable || openable) && 'cursor-pointer hover:bg-bg-hover',
          highlightRelPath === node.relPath && 'bg-bg-hover',
        )}
      >
        <span className="w-3.5 flex justify-center text-text-tertiary flex-shrink-0">
          {expandable && (isOpen ? Icons.chevronDown(12) : Icons.chevronRight(12))}
        </span>
        <span className={cn('flex flex-shrink-0', extColor(node.name, node.kind))}>
          {isFolder ? Icons.folder(15) : Icons.file(14)}
        </span>
        {/* When an absolute path is available, show it (and not only when truncated): file names produced by the Agent are
            long and similar, so echoing just the name says nothing — the path is what answers "which one on disk is this".
            Only when no path is available (the @ popover has no mount root) do we fall back to the old "show the file name only when truncated". */}
        <Tooltip
          content={absPathOf ? absPathOf(node) : node.name}
          onlyWhenTruncated={absPathOf === undefined}
        >
          <span
            className={cn(
              'flex-1 min-w-0 text-xs font-medium font-mono truncate',
              node.unreadable ? 'text-text-tertiary' : 'text-text-primary',
            )}
          >
            {node.name}
          </span>
        </Tooltip>
        {node.unreadable && (
          <span className="text-2xs text-text-tertiary flex-shrink-0">{t('asset.tree.noPermission')}</span>
        )}
        {node.sizeBytes !== null && (
          <span className="text-2xs text-text-tertiary flex-shrink-0">
            {formatSize(node.sizeBytes)}
          </span>
        )}
        {menu && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              menu.onToggle(node.relPath)
            }}
            aria-label={t('asset.tree.rowActions', { name: node.name })}
            aria-expanded={menuOpen}
            // Always rendered, shown/hidden via opacity, to avoid row-width jitter on hover (§LS1).
            className={cn(
              'flex items-center text-text-tertiary p-0.5 cursor-pointer flex-shrink-0 hover:text-text-primary transition-opacity',
              menuOpen ? 'opacity-100' : 'opacity-0 group-hover/tree-row:opacity-100',
            )}
          >
            {Icons.dots(14)}
          </button>
        )}
        {menu && menuOpen && <TreeRowMenuDropdown node={node} menu={menu} />}
        {onMention && (
          <button
            type="button"
            // Do not steal focus from the editor: keeping the input caret is what lets @ be inserted where the user clicked rather than at the end.
            onMouseDown={(e) => e.preventDefault()}
            onClick={(e) => {
              e.stopPropagation()
              onMention(node)
            }}
            aria-label={t('asset.tree.mention', { name: node.name })}
            // Always rendered, shown/hidden via opacity: it appears on hover without causing row-width jitter (§LS1).
            className="w-4 text-center text-xs font-semibold text-text-accent flex-shrink-0 opacity-0 group-hover/tree-row:opacity-100 transition-opacity"
          >
            @
          </button>
        )}
      </div>
      {isOpen && (
        <ExpandedBody
          node={node}
          {...{ expanded, onToggle, onMention, onPickFile, onOpen, highlightRelPath, absPathOf, menu }}
        />
      )}
    </div>
  )
}

interface TreeRowMenuDropdownProps {
  node: DirTreeNode
  menu: TreeRowMenu
}

/** Child-row ⋯ dropdown: copy path / reveal in file manager (no "remove" — see the props comment). */
function TreeRowMenuDropdown({ node, menu }: TreeRowMenuDropdownProps) {
  const { t } = useTranslation()
  const itemCls =
    'w-full text-left px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover'
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={(e) => {
          e.stopPropagation()
          menu.onToggle(node.relPath)
        }}
      />
      <div className="absolute right-1 top-full -mt-1 z-50 min-w-[168px] rounded-md border border-border-default bg-bg-input shadow-md py-1">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            menu.onCopyPath(node)
          }}
          className={itemCls}
        >
          {t('asset.common.copyPath')}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            menu.onReveal(node)
          }}
          className={itemCls}
        >
          {t('asset.common.revealInFileManager')}
        </button>
      </div>
    </>
  )
}

/** Expanded content: not read yet → loading; empty → empty folder; otherwise recurse into the child level (§1.24 early return). */
function ExpandedBody({
  node,
  expanded,
  onToggle,
  onMention,
  onPickFile,
  onOpen,
  highlightRelPath,
  absPathOf,
  menu,
}: TreeNodeRowProps) {
  const { t } = useTranslation()
  const shell = 'ml-[13px] pl-[3px] border-l border-border-subtle'
  if (node.children === undefined) {
    return (
      <div className={shell}>
        <div className="px-2 py-[5px] text-2xs text-text-tertiary">{t('asset.common.loading')}</div>
      </div>
    )
  }
  if (node.children.length === 0) {
    return (
      <div className={shell}>
        <div className="px-2 py-[5px] text-2xs text-text-tertiary">{t('asset.common.emptyFolder')}</div>
      </div>
    )
  }
  return (
    <div className={shell}>
      <WindowedList items={node.children}>
        {(c) => (
          <TreeNodeRow
            key={c.relPath}
            node={c}
            expanded={expanded}
            onToggle={onToggle}
            onMention={onMention}
            onPickFile={onPickFile}
            onOpen={onOpen}
            highlightRelPath={highlightRelPath}
            absPathOf={absPathOf}
            menu={menu}
          />
        )}
      </WindowedList>
    </div>
  )
}
