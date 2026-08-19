/**
 * The ⋯ dropdown hanging off a list row — session files, mount roots, asset
 * search hits. Three byte-identical copies existed; the highlight bug that
 * prompted this extraction was present in all three at once, which is the
 * argument for having one.
 *
 * Two colour decisions live here and should not be "unified" away:
 *
 * - The container is --bg-elevated, NOT --bg-input. In the light theme
 *   bg-input (#F2F3F7) is *darker* than bg-hover (#F5F6F9), so a hover fill on
 *   an input-coloured panel lightens the row instead of darkening it — 1.03:1,
 *   invisible. Elevated puts the fill on the correct side in both themes.
 * - Hover is --bg-active, a step stronger than the --bg-hover that list rows
 *   use. A dropdown is a point-and-click decision: the row under the cursor
 *   has to be unmistakable, where a list row only needs to feel alive.
 *
 * What it deliberately does NOT own: closing. `onDismiss` fires only for the
 * outside-click scrim; whether picking an item also closes the menu is left to
 * each caller, because the callbacks reach different owners (FileTreeView's
 * arrive from MountRow, which gets them from SessionAssets) and some of those
 * are toggles that would reopen the menu if fired twice.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

export interface RowActionMenuItem {
  label: ReactNode
  onSelect: () => void
  /** Destructive actions read in the error colour. */
  tone?: 'danger'
  /** Draws a divider above this item, to set destructive actions apart. */
  separated?: boolean
}

export function RowActionMenu({
  items,
  onDismiss,
}: {
  items: RowActionMenuItem[]
  onDismiss: () => void
}) {
  return (
    <>
      {/* Outside click closes. stopPropagation keeps it from bubbling to the row
          underneath and triggering that row's own click (e.g. "open file"). */}
      <div
        className="fixed inset-0 z-40"
        onClick={(event) => {
          event.stopPropagation()
          onDismiss()
        }}
      />
      <div className="absolute right-1 top-full -mt-1 z-50 min-w-[168px] rounded-md border border-border-default bg-bg-elevated shadow-md py-1">
        {items.map((item, index) => (
          // key is the index: label is a ReactNode, and the item list is static for a given row.
          <div key={index}>
            {item.separated ? <div className="my-1 h-px bg-border-subtle" /> : null}
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation()
                item.onSelect()
              }}
              className={cn(
                'w-full text-left px-2.5 py-1.5 text-xs hover:bg-bg-active',
                item.tone === 'danger'
                  ? 'text-status-error'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {item.label}
            </button>
          </div>
        ))}
      </div>
    </>
  )
}
