/**
 * Segmented filter control — the row of tabs that sits above a list view and
 * narrows it (Skills' source tiers, Schedules' all/active/paused). Shared by
 * those two views, which were hand-written copies that had drifted apart on
 * padding, size, weight, selected background and unselected colour all at once.
 *
 * Not to be confused with two neighbours that stay separate on purpose:
 * - `Primitives.TabBar` is the underlined tab strip inside modals — a different
 *   visual language, not a variant of this one.
 * - The pill filters in `RightPanel` / `WorkbenchToolPrimitives` invert to a
 *   solid `--text-primary` fill; also a different language.
 *
 * The rules it holds:
 * - Selected reads as --bg-selected, the one selected-state token used app-wide
 *   (sidebar nav, session rows, mention menu, mode pill, tool rail). Retune that
 *   token rather than reaching for --bg-hover or --bg-active here.
 * - Unselected is --text-secondary, never --text-tertiary. Selection is shown by
 *   the selected item gaining a background, not by the others being dimmed.
 * - The font weight never changes between states (§LS1). Going 400→600 widens
 *   CJK glyphs, which pushes every later tab in the group — and the count
 *   parentheses after them — sideways on each selection.
 */
import { cn } from '@/lib/cn'

export interface FilterTab<K extends string> {
  key: K
  label: string
  /** Rendered as "(n)" after the label. Omit for filters that show no count. */
  count?: number
}

export function FilterTabs<K extends string>({
  tabs,
  value,
  onChange,
  testIdPrefix,
}: {
  tabs: readonly FilterTab<K>[]
  value: K
  onChange: (key: K) => void
  testIdPrefix: string
}) {
  return (
    <div className="flex gap-1 p-1 rounded-md border border-border-subtle bg-bg-surface w-fit">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          data-testid={`${testIdPrefix}${tab.key}`}
          onClick={() => onChange(tab.key)}
          className={cn(
            'px-3 py-1 rounded-[5px] text-sm',
            tab.key === value
              ? 'bg-bg-selected text-text-primary'
              : 'text-text-secondary hover:text-text-primary',
          )}
        >
          {tab.label}
          {tab.count === undefined ? null : <span className="ml-1">({tab.count})</span>}
        </button>
      ))}
    </div>
  )
}
