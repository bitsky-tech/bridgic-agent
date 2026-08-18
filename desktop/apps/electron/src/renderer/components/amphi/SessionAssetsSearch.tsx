/**
 * The **search results** view of the right panel's "session files" — it replaces the tree browser whenever the search box is non-empty.
 *
 * Key difference from the tree view (`MountRow`): results are **flat**, and every row carries a
 * breadcrumb saying where it sits. The tree expresses position through hierarchy; search results have
 * no hierarchy to use — a hit can come from any depth, and forcing it back into the tree would mean
 * expanding every parent directory along the way, which is harder to scan, not easier.
 *
 * Behaviour matches the `@` popover's search rows (same `fs.searchDir` hits, same highlighting
 * parts): searching the same word in either place should show the same thing. The actions keep the
 * right panel's semantics: click = open, ⋯ = copy path / reveal in file manager, @ = inject a
 * composer reference — **all three must be there**: search results and the tree view are two
 * presentations of the same files, and if tree rows have ⋯ but search rows do not, the user loses
 * everyday operations like "copy path" the moment they search.
 *
 * ⋯ has no "remove": that is an operation on the mount registry, while most hits are files **inside**
 * a mount, for which unmounting is meaningless (the tree view also offers "remove" only on the mount root row).
 */
import { useState } from 'react'
import { useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { extColor } from '@/lib/fileTree'
import type { FileSearchHit } from '@shared/file-search'
import type { MountSummary } from '@/lib/amphiClient'
import { requestMentionInsertAtom } from '@/atoms/mounts'
import { requestFileOpenAtom } from '@/atoms/fileOpen'
import { Icons } from './Icons'
import { RowActionMenu } from './RowActionMenu'
import { Tooltip } from './Tooltip'
import { Highlighted, hitCrumbRanges, hitSizeLabel, noMatchText } from './SearchHighlight'

export interface SessionAssetsSearchProps {
  hits: FileSearchHit[]
  /** Total number of hits (before truncation); when it exceeds hits.length we say there are more. */
  total: number
  /** The traversal hit its time budget, so the results may be incomplete. */
  partial: boolean
  isSearching: boolean
  query: string
  /** Used to resolve a hit's mount-relative path back to an absolute path. */
  mounts: MountSummary[]
  /** The two ⋯ menu actions. Supplied by the panel rather than built here: SessionAssetsPanel already
   *  has one clipboard + toast implementation, and copying it would leave two copies to keep in sync. */
  onCopyPath: (abs: string) => void
  onReveal: (abs: string) => void
}

/** Flat hit list: icon + highlighted filename + breadcrumb + size; click to open, ⋯ for actions, @ to inject a reference. */
export function SessionAssetsSearch({
  hits,
  total,
  partial,
  isSearching,
  query,
  mounts,
  onCopyPath,
  onReveal,
}: SessionAssetsSearchProps) {
  const { t } = useTranslation()
  const requestMentionInsert = useSetAtom(requestMentionInsertAtom)
  const requestFileOpen = useSetAtom(requestFileOpenAtom)
  // At most one row's menu is open at a time (a single value rather than per-row state), same as
  // SessionAssetsPanel. The key is `${mountId}:${relPath}` — a mount root's relPath is the empty
  // string, so relPath alone would collide.
  const [menuFor, setMenuFor] = useState<string | null>(null)

  // A hit only carries mountId + relPath; the absolute path has to be joined with the mount root. If
  // the mount was removed after the search returned, the lookup fails — in that case we offer no open
  // action rather than building a wrong path.
  //
  // An empty relPath = the **mount root itself** was hit (`dir-tree.ts::searchDir` treats the root as a
  // candidate too, searchable by mount name). Use the mount path directly here; blindly joining a `/`
  // would put a weird trailing-slash path in the tooltip.
  const absPathOf = (h: FileSearchHit): string | null => {
    const mount = mounts.find((m) => m.id === h.mountId)
    if (!mount) return null
    return h.relPath ? `${mount.path}/${h.relPath}` : mount.path
  }

  if (isSearching && hits.length === 0) {
    return <div className="px-2.5 py-4 text-xs text-text-tertiary text-center">{t('asset.search.searching')}</div>
  }
  if (hits.length === 0) {
    return (
      <div className="px-2.5 py-4 text-xs text-text-tertiary text-center leading-[1.6]">
        {noMatchText(query, t('asset.search.fileScope'))}
      </div>
    )
  }

  return (
    <div className="flex flex-col">
      {hits.map((h) => {
        const abs = absPathOf(h)
        const rowKey = `${h.mountId}:${h.relPath}`
        const menuOpen = menuFor === rowKey
        return (
          <div
            key={rowKey}
            // File → open with the system default application (behind the confirmation gate); folder → reveal in
            // the file manager. Search results are flat with no tree to expand, so a folder cannot reuse the tree
            // view's "click to expand" — and with no action at all, clicking a folder hit sitting at the top of
            // the list would do nothing and look broken.
            onClick={() => {
              if (!abs) return
              if (h.kind === 'folder') void window.api.shell.showItemInFolder(abs)
              else requestFileOpen({ path: abs, name: h.name })
            }}
            className={cn(
              'group relative flex items-center gap-1.5 px-2 py-[5px] rounded-md',
              abs && 'cursor-pointer hover:bg-bg-hover',
            )}
          >
            <span className={cn('flex flex-shrink-0', extColor(h.name, h.kind))}>
              {h.kind === 'folder' ? Icons.folder(15) : Icons.file(14)}
            </span>
            <Tooltip content={abs ?? h.relPath}>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium font-mono text-text-primary truncate">
                  <Highlighted text={h.name} ranges={h.nameRanges} />
                </div>
                {h.crumb.length > 0 && (
                  <div className="text-2xs text-text-tertiary truncate">
                    <Highlighted text={h.crumb.join(' / ')} ranges={hitCrumbRanges(h)} />
                  </div>
                )}
              </div>
            </Tooltip>
            <span className="text-2xs text-text-tertiary flex-shrink-0">{hitSizeLabel(h)}</span>
            {abs && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  setMenuFor(menuOpen ? null : rowKey)
                }}
                aria-label={t('asset.tree.rowActions', { name: h.name })}
                aria-expanded={menuOpen}
                // Always rendered, shown/hidden via opacity, so the row width does not jump on hover (§LS1).
                className={cn(
                  'flex items-center text-text-tertiary p-0.5 flex-shrink-0 hover:text-text-primary transition-opacity',
                  menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                )}
              >
                {Icons.dots(14)}
              </button>
            )}
            {abs && menuOpen && (
              <HitRowMenu
                abs={abs}
                onCopyPath={onCopyPath}
                onReveal={onReveal}
                onClose={() => setMenuFor(null)}
              />
            )}
            <button
              type="button"
              // Do not steal focus from the editor: keeping the input's caret is what lets @ insert at the user's click position rather than at the end.
              onMouseDown={(e) => e.preventDefault()}
              onClick={(e) => {
                e.stopPropagation()
                requestMentionInsert({
                  id: h.mountId,
                  label: h.kind === 'folder' ? `${h.name}/` : h.name,
                  // `|| undefined`: a mount-root hit has an empty-string relPath, and passing the empty string would be
                  // read as "some relative path inside the mount" rather than the mount itself. Same spelling as the `@`
                  // popover's FreeFormInput::pickMentionRow.
                  path: h.relPath || undefined,
                })
              }}
              aria-label={t('asset.common.addToChat', { name: h.name })}
              className="w-4 text-center text-xs font-semibold text-text-accent flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              @
            </button>
          </div>
        )
      })}
      <SearchResultFooter hitCount={hits.length} total={total} partial={partial} />
    </div>
  )
}

interface HitRowMenuProps {
  abs: string
  onCopyPath: (abs: string) => void
  onReveal: (abs: string) => void
  onClose: () => void
}

/** ⋯ dropdown on a hit row: copy path / reveal in file manager (no "remove" — see the file header).
 *  Chrome and colours come from `RowActionMenu`; this used to be a hand-kept copy
 *  of `FileTreeView :: TreeRowMenuDropdown` and the two drifted together. */
function HitRowMenu({ abs, onCopyPath, onReveal, onClose }: HitRowMenuProps) {
  const { t } = useTranslation()
  return (
    <RowActionMenu
      onDismiss={onClose}
      items={[
        {
          label: t('asset.common.copyPath'),
          onSelect: () => {
            onClose()
            onCopyPath(abs)
          },
        },
        {
          label: t('asset.common.revealInFileManager'),
          onSelect: () => {
            onClose()
            onReveal(abs)
          },
        },
      ]}
    />
  )
}

interface SearchResultFooterProps {
  hitCount: number
  total: number
  partial: boolean
}

/** Explanation shown when results were truncated / the traversal ran over budget, so the user does not assume "that's all there is".
 *
 *  The two conditions **can hold at once** and each says something different (the traversal of a large
 *  directory did not finish / the hit count exceeded the transport cap), so they are shown side by side
 *  rather than either-or — an earlier version returned early on `partial` and swallowed "only the first
 *  50 are shown" entirely, and "big tree + many hits" is exactly the case where both fire. */
function SearchResultFooter({ hitCount, total, partial }: SearchResultFooterProps) {
  const { t } = useTranslation()
  const capped = total > hitCount
  if (!partial && !capped) return null
  return (
    <div className="px-2 pt-2 flex flex-col gap-0.5 text-2xs">
      {capped && (
        <span className="text-text-tertiary">
          {t('asset.search.capped', { total, shown: hitCount })}
        </span>
      )}
      {partial && <span className="text-status-warning">{t('asset.search.partial')}</span>}
    </div>
  )
}
