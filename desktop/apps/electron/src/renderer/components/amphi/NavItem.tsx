/**
 * One row of a vertical navigation list — icon, label, selected state. Shared by
 * the left sidebar's top-level nav and the settings dialog's tab rail; the two
 * were hand-maintained copies of each other and drifted apart twice.
 *
 * It exists to hold three rules, every one of which was a real regression:
 *
 * - Selection is the background plus the weight. The label never fades — a nav
 *   row is a primary entry point and reads at full strength either way. Dimming
 *   the unselected rows is what made this list "hard to read" in the first place.
 * - The selected background is --bg-selected, the one token every selected
 *   surface in the app shares (session rows, mention menu, mode pill, the tool
 *   rail, FilterTabs). Do not substitute --bg-hover or --bg-active here: both
 *   were tried, the first vanished (1.08:1 in light) and the second read as
 *   heavy. Retune the token, not the call site.
 * - The icon runs large and light (18px at --text-tertiary), never small and
 *   dark. Icons only need 3:1, and a thin glyph in a 7:1 grey reads as sharp
 *   beside 13px text. Never an opacity: it multiplies against whatever sits
 *   behind the element and escapes the contrast scale entirely.
 *
 * Deliberately NOT used for the session rows, the mention menu or the mode pill.
 * Their highlight means "the keyboard cursor is here", not "this is the current
 * section" — same pixels, different concept, and merging them would be the wrong
 * abstraction.
 */
import type { ReactNode } from 'react'
import { cn } from '@/lib/cn'

/** Fixed so the size cannot drift per call site — see the icon rule above. */
const ICON_SIZE = 18

export function NavItem({
  icon,
  label,
  active,
  onClick,
  testId,
}: {
  icon: (size?: number) => ReactNode
  label: string
  active: boolean
  onClick: () => void
  testId: string
}) {
  return (
    <div
      data-testid={testId}
      onClick={onClick}
      className={cn(
        'flex items-center gap-2.5 px-3 py-2.5 rounded-md cursor-pointer text-text-primary',
        active ? 'bg-bg-selected' : 'hover:bg-bg-hover',
      )}
    >
      <span className={cn('flex items-center flex-shrink-0', active ? 'text-text-primary' : 'text-text-tertiary')}>
        {icon(ICON_SIZE)}
      </span>
      <span className={cn('flex-1 text-sm', active ? 'font-semibold' : 'font-normal')}>{label}</span>
    </div>
  )
}
