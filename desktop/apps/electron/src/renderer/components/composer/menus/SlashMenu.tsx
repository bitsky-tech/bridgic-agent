/**
 * Slash command menu — controlled by FreeFormInput (selectedIndex driven).
 *
 * cmdk's keyboard logic is no longer used: cmdk's listener is attached to the Command element and needs focus to
 * receive keydown, whereas focus must stay on the contenteditable RichTextInput. So the menu's ↑↓ Enter Esc are
 * handled by FreeFormInput itself (host mode), and the menu only renders the highlight according to
 * `selectedIndex` and handles mouse clicks.
 *
 * The menu now lists more than commands: also skills / workflows / schedules (data from useSlashMenuState).
 * The `rows` it receives are already filtered and flattened in keyboard order; group headings are derived in place
 * from `group` changing between adjacent rows. Command rows show `/{id}` as their primary text; the rest show a name.
 *
 * `onMouseDown e.preventDefault()` prevents the caret from losing focus when a menu item is clicked — the caret
 * must stay inside the contenteditable for subsequent typing to work.
 */
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import type { CaretFloatingStyle } from '../hooks/useCaretFloatingPosition'
import { slashGroupTranslationKey, SlashGroup, SlashRowKind, type SlashRow } from './slashRows'

export interface SlashMenuProps {
  rows: SlashRow[]
  selectedIndex: number
  style: CaretFloatingStyle
  onPick: (row: SlashRow) => void
}

/** Colors per entity group (per the "slash command palette" design): the group heading's dot, the row's primary text,
 *  and the tinted background of the selected row. All class names are literals (Tailwind v4 scans this source). */
function getGroupColor(group: string): { text: string; dot: string; bg: string } {
  switch (group) {
    case SlashGroup.Command:
      return { text: 'text-entity-command', dot: 'bg-entity-command', bg: 'bg-entity-command-bg' }
    case SlashGroup.Skill:
      return { text: 'text-entity-skill', dot: 'bg-entity-skill', bg: 'bg-entity-skill-bg' }
    case SlashGroup.Workflow:
      return { text: 'text-entity-workflow', dot: 'bg-entity-workflow', bg: 'bg-entity-workflow-bg' }
    case SlashGroup.Schedule:
      return { text: 'text-entity-schedule', dot: 'bg-entity-schedule', bg: 'bg-entity-schedule-bg' }
    default:
      return { text: 'text-text-primary', dot: 'bg-text-tertiary', bg: 'bg-bg-hover' }
  }
}

export function SlashMenu({ rows, selectedIndex, style, onPick }: SlashMenuProps) {
  const { t } = useTranslation()
  // Scroll the highlighted item into view whenever selectedIndex changes. block:'nearest' = scroll the minimum
  // distance (not forced to center), so it does not fight the position the user has already scrolled to.
  const highlightedRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    highlightedRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Group headings: when `group` changes between adjacent rows, render the group name once before that row (the menu
  // follows the rows order strictly, and useSlashMenuState already guarantees that rows of one group are contiguous).
  const renderedGroups = new Set<string>()

  return (
    <div
      style={style}
      className="z-50 w-[300px] max-h-[280px] overflow-auto bg-bg-elevated border border-border-default rounded-md shadow-md py-1"
      onMouseDown={(e) => e.preventDefault()}
    >
      {rows.length === 0 ? (
        <div className="px-3 py-2 text-sm text-text-tertiary">{t('composer.slash.empty')}</div>
      ) : (
        rows.map((row, idx) => {
          const showGroup = !renderedGroups.has(row.group)
          if (showGroup) renderedGroups.add(row.group)
          const primary = row.kind === SlashRowKind.Command ? `/${row.id}` : row.label
          const color = getGroupColor(row.group)
          return (
            <div key={`${row.kind}-${row.id}`}>
              {showGroup && (
                <div className="flex items-center gap-1.5 px-3 pt-2 pb-1 text-xs text-text-tertiary">
                  {/* The entity-colored dot before the group heading (design handoff). */}
                  <span className={cn('w-1.5 h-1.5 rounded-full flex-shrink-0', color.dot)} />
                  <span>{t(slashGroupTranslationKey(row.group))}</span>
                </div>
              )}
              <button
                ref={idx === selectedIndex ? highlightedRef : null}
                type="button"
                onClick={() => onPick(row)}
                className={cn(
                  'flex flex-col items-start w-full text-left px-3 py-2 cursor-pointer',
                  idx === selectedIndex && color.bg,
                )}
              >
                {/* The row's primary text is colored per entity (design: commands and their echo share one color). */}
                <span className={cn('text-sm truncate max-w-full font-medium', color.text)}>
                  {primary}
                </span>
                {row.description && (
                  <span className="text-xs text-text-tertiary truncate max-w-full">
                    {row.description}
                  </span>
                )}
              </button>
              {/* Overflow hint — rendered after the last entry of a capped group (the overflow is attached to the last row,
                  see useSlashMenuState.pushCapped). It uses the entity color rather than text-tertiary: this is the user's
                  only clue that "there is more, type a keyword", so de-emphasizing it is the same as not having it.
                  Not a button and with no onClick — it does not enter the rows index and does not affect ↑↓ navigation (§1.28). */}
              {row.kind !== SlashRowKind.Command && row.overflow ? (
                <div className={cn('px-3 pb-1.5 text-xs font-medium', color.text)}>
                  {t('composer.slash.overflow', { n: row.overflow })}
                </div>
              ) : null}
            </div>
          )
        })
      )}
    </div>
  )
}
