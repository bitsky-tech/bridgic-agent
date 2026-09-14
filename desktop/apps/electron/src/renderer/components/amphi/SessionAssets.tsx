/**
 * Right-panel "session outputs" — "session files" group body, plus the `AssetRow`
 * file-row primitive (since 2026-06-11 the RightPanel converged to the three
 * tiers all / workflows / session files, leaving this without a consumer for now;
 * it is kept for when a "run artifacts" style list comes back).
 *
 * Session files render mounts as a FILE TREE (per the v2 design): each folder
 * mount root expands into its on-disk hierarchy — see `MountRow` (the
 * row + subtree implementation) and atoms/mounts.ts (fresh-from-disk
 * snapshot semantics). A mount is a REFERENCE — "remove" unmounts the
 * registry row, never the real file.
 *
 * This panel is a pure consumer of atoms/mounts.ts: the mount list is
 * loaded once per session switch by the composer (FreeFormInput's
 * loadMounts effect — the single load site); this panel reads it and
 * fires actions (copy path / reveal in file manager / remove / add to chat).
 *
 * "+add" opens the same pick-file / pick-folder two-step as the composer
 * toolbar (Win/Linux can't mix file+folder in one native dialog).
 *
 * When `query` is non-empty the whole tree is replaced by `SessionAssetsSearch`'s
 * flat list of hits — search goes through the main process's `fs.searchDir`
 * (see `useMountSearch`) rather than filtering the tree here: subdirectories are
 * lazily loaded, the render layer only holds the few levels the user has
 * expanded, so filtering it would search next to nothing.
 */
import { useState, type ReactNode } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { rlog } from '@/lib/logger'
import { Icons } from './Icons'
import { Tooltip } from './Tooltip'
import { MountRow } from './MountRow'
import { SessionAssetsSearch } from './SessionAssetsSearch'
import { EMPTY_MOUNT_SEARCH, type MountSearchState } from '@/hooks/useMountSearch'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { showToastAtom } from '@/atoms/toast'
import {
  mountsFamily,
  pickAndMountAtom,
  removeMountAtom,
  requestMentionInsertAtom,
} from '@/atoms/mounts'
import { isPowerPointFileTarget, requestSessionFileOpenAtom } from '@/atoms/fileOpen'
import type { DirTreeNode } from '@shared/dir-tree'
import type { MountSummary } from '@/lib/amphiClient'

const MENU_ITEM_CLS =
  'w-full text-left px-2.5 py-1.5 text-xs text-text-secondary hover:text-text-primary hover:bg-bg-hover'

export interface AssetRowProps {
  kind: 'file' | 'folder'
  name: string
  /** Second line: size / item count / stale marker. */
  meta: string
  /** false → the name is struck through and greyed out (the path is stale). Defaults to true. */
  exists?: boolean
  /** Clicking @ = add to chat. When omitted, @ degrades to a purely visual placeholder (placeholder
   *  fake data has no daemon mount id, and injecting it into the composer would produce an unresolvable
   *  reference; per §1.23 non-interactive elements do not get cursor-pointer). */
  onMention?: () => void
  /** Extra action area to the left of @ (e.g. the hover ⋯ menu, including its dropdown — the row root is relative). */
  trailing?: ReactNode
}

/** One file/folder row of the session-outputs panel: icon + name/meta + trailing actions + always-present @. */
export function AssetRow({ kind, name, meta, exists = true, onMention, trailing }: AssetRowProps) {
  const { t } = useTranslation()
  return (
    <div className="group relative flex items-center gap-2.5 px-2.5 py-2 rounded-md bg-bg-hover">
      <span className="text-text-tertiary flex-shrink-0">
        {kind === 'folder' ? Icons.folder(16) : Icons.file(16)}
      </span>
      <div className="flex-1 min-w-0">
        <Tooltip content={name} onlyWhenTruncated>
          <div
            className={cn(
              'text-sm font-medium truncate',
              exists ? 'text-text-primary' : 'text-text-tertiary line-through',
            )}
          >
            {name}
          </div>
        </Tooltip>
        <div className="text-xs text-text-tertiary">{meta}</div>
      </div>
      {trailing}
      {onMention ? (
        <button
          type="button"
          // Do not steal focus from the editor: keeping the input caret is what lets @ be inserted where the user clicked rather than at the end.
          onMouseDown={(e) => e.preventDefault()}
          onClick={onMention}
          className="flex items-center text-text-tertiary p-0.5 flex-shrink-0 hover:text-text-primary"
          aria-label={t('asset.common.addToChat', { name })}
        >
          {Icons.at(14)}
        </button>
      ) : (
        <span className="flex items-center text-text-tertiary p-0.5 flex-shrink-0">
          {Icons.at(14)}
        </span>
      )}
    </div>
  )
}

export interface SessionAssetsPanelProps {
  /** Current query from the right panel's search box; empty string = tree browsing. */
  query?: string
  /** Search results. Owned by RightPanel (its chip counts / group visibility also need the hit count);
   *  this component only consumes them and never starts a search itself — calling the hook in two places would fire the IPC twice and the counts could drift. */
  search?: MountSearchState
}

export function SessionAssetsPanel({
  query = '',
  search = EMPTY_MOUNT_SEARCH,
}: SessionAssetsPanelProps) {
  const { t } = useTranslation()
  const sessionId = useAtomValue(activeSessionIdAtom)
  const mounts = useAtomValue(mountsFamily(sessionId ?? ''))
  const pickAndMount = useSetAtom(pickAndMountAtom)
  const removeMount = useSetAtom(removeMountAtom)
  const requestMentionInsert = useSetAtom(requestMentionInsertAtom)
  const requestSessionFileOpen = useSetAtom(requestSessionFileOpenAtom)
  const showToast = useSetAtom(showToastAtom)
  const [addOpen, setAddOpen] = useState(false)
  // At most one row's menu is open at a time (a single value rather than per-row state).
  // Key: root rows = mountId; child rows = `${mountId}:${relPath}` (mount ids contain no colon).
  const [menuFor, setMenuFor] = useState<string | null>(null)

  const pick = (kind: 'file' | 'folder') => {
    setAddOpen(false)
    if (!sessionId) return
    void pickAndMount({ sessionId, kind })
  }

  const addToChat = (m: MountSummary) => {
    setMenuFor(null)
    requestMentionInsert({ id: m.id, label: m.kind === 'folder' ? `${m.name}/` : m.name })
  }

  const addChildToChat = (m: MountSummary, node: DirTreeNode) => {
    // A child reference = mount id + path relative to the mount; the daemon joins them fail-closed.
    requestMentionInsert({
      id: m.id,
      label: node.kind === 'folder' ? `${node.name}/` : node.name,
      path: node.relPath,
    })
  }

  const copyAbsPath = (abs: string) => {
    setMenuFor(null)
    void navigator.clipboard
      .writeText(abs)
      .then(() => showToast(t('asset.toast.pathCopied')))
      .catch((err: unknown) => {
        rlog.warn('[mounts] copy path failed', { path: abs, err })
        showToast(t('asset.toast.copyFailed'))
      })
  }

  const revealAbsPath = (abs: string) => {
    setMenuFor(null)
    // showItemInFolder behaves the same for files and folders: reveal that path in the system file manager.
    void window.api.shell.showItemInFolder(abs)
  }

  const remove = (m: MountSummary) => {
    setMenuFor(null)
    if (sessionId) void removeMount({ sessionId, mountId: m.id })
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-semibold text-text-secondary">{t('asset.session.title')}</span>
        <div className="relative">
          <button
            type="button"
            onClick={() => setAddOpen((o) => !o)}
            disabled={!sessionId}
            className="inline-flex items-center gap-0.5 text-xs text-text-accent hover:opacity-80 disabled:opacity-40"
            aria-expanded={addOpen}
          >
            {Icons.plus(12)}
            {t('asset.session.add')}
          </button>
          {addOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setAddOpen(false)} />
              <div className="absolute top-full right-0 mt-1 z-20 min-w-[132px] rounded-md border border-border-default bg-bg-input shadow-md py-1">
                <button type="button" onClick={() => pick('file')} className={MENU_ITEM_CLS}>
                  {t('asset.session.pickFile')}
                </button>
                <button type="button" onClick={() => pick('folder')} className={MENU_ITEM_CLS}>
                  {t('asset.session.pickFolder')}
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {query.trim() ? (
        <SessionAssetsSearch
          hits={search.hits}
          total={search.total}
          partial={search.partial}
          isSearching={search.isSearching}
          query={query.trim()}
          mounts={mounts}
          onCopyPath={copyAbsPath}
          onOpen={requestSessionFileOpen}
          onReveal={revealAbsPath}
        />
      ) : (
        <MountList
          mounts={mounts}
          sessionId={sessionId}
          menuFor={menuFor}
          setMenuFor={setMenuFor}
          onCopyPath={copyAbsPath}
          onReveal={revealAbsPath}
          onRemove={remove}
          onMentionRoot={addToChat}
          onMentionChild={addChildToChat}
          onOpen={requestSessionFileOpen}
        />
      )}
    </div>
  )
}

interface MountListProps {
  mounts: MountSummary[]
  sessionId: string | null
  menuFor: string | null
  setMenuFor: (key: string | null) => void
  onCopyPath: (abs: string) => void
  onReveal: (abs: string) => void
  onRemove: (m: MountSummary) => void
  onMentionRoot: (m: MountSummary) => void
  onMentionChild: (m: MountSummary, node: DirTreeNode) => void
  onOpen: (req: { path: string; name: string }) => void
}

/** Tree-browsing branch: empty state / list of mount roots (§1.24 extract a child component and return early, rather than stacking a nested ternary with the search branch). */
function MountList({
  mounts,
  sessionId,
  menuFor,
  setMenuFor,
  onCopyPath,
  onReveal,
  onRemove,
  onMentionRoot,
  onMentionChild,
  onOpen,
}: MountListProps) {
  const { t } = useTranslation()
  if (mounts.length === 0) {
    return (
      <div className="px-2.5 py-4 text-xs text-text-tertiary text-center leading-[1.6]">
        {t('asset.empty.title')}
        <br />
        {t('asset.empty.hint')}
      </div>
    )
  }
  return (
    <div className="flex flex-col">
      {mounts.map((m) => (
        <MountRow
          key={m.id}
          mount={m}
          sessionId={sessionId ?? ''}
          menuOpen={menuFor === m.id}
          onMenuToggle={() => setMenuFor(menuFor === m.id ? null : m.id)}
          onCopyPath={() => onCopyPath(m.path)}
          onOpenInFileManager={() => onReveal(m.path)}
          onRemove={m.removable === false ? undefined : () => onRemove(m)}
          onMentionRoot={() => onMentionRoot(m)}
          onMentionChild={(node) => onMentionChild(m, node)}
          childMenuFor={menuFor?.startsWith(`${m.id}:`) ? menuFor.slice(m.id.length + 1) : null}
          onChildMenuToggle={(relPath) => {
            const key = `${m.id}:${relPath}`
            setMenuFor(menuFor === key ? null : key)
          }}
          onCopyChildPath={(node) => onCopyPath(`${m.path}/${node.relPath}`)}
          onRevealChild={(node) => onReveal(`${m.path}/${node.relPath}`)}
          onOpenRoot={() => onOpen({ path: m.path, name: m.name })}
          onOpenChild={(node) => onOpen({ path: `${m.path}/${node.relPath}`, name: node.name })}
          openOnSingleClick={(name) => isPowerPointFileTarget({ name })}
        />
      ))}
    </div>
  )
}
