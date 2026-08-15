/**
 * useIsClamped — detect whether the content of an element clamped by `line-clamp-*` really
 * overflows (vertical truncation).
 *
 * Returns `[ref, isClamped]`: attach `ref` to the clamped element; `isClamped` true means the
 * content is taller than the clamp height (`scrollHeight > clientHeight`), i.e. the text
 * really is truncated and an "expand/collapse" control is worth showing. This is the vertical
 * counterpart of `Tooltip`'s `onlyWhenTruncated` (horizontal `scrollWidth > clientWidth`),
 * following the project's existing detection convention instead of pulling in a third-party
 * component.
 *
 * Invariants / non-obvious points:
 * - Uses `useLayoutEffect` (measure before paint), so the button doesn't flash once before
 *   disappearing. This measures the DOM (an external system), it is not derived state, so
 *   §1.17 permits it.
 * - `expanded` is passed in: an expanded element is no longer clamped, so measuring then
 *   reads "not overflowing" and misjudges — hence measurement is skipped while expanded and
 *   the collapsed-phase result is kept (which is why the collapse button stays); it
 *   re-measures on collapse.
 * - Re-measures only when `text` / `expanded` change, with no viewport resize listener (all
 *   consumers live inside transient popovers, where dragging the window during review is
 *   unlikely — §2 simplicity first).
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** Detect whether a line-clamped element overflows its clamp. See file header. */
export function useIsClamped(
  text: string | null,
  expanded: boolean,
): [RefObject<HTMLDivElement>, boolean] {
  const ref = useRef<HTMLDivElement>(null)
  const [isClamped, setIsClamped] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || expanded) return
    // +1 tolerates sub-pixel rounding; one line of overflow is at least one extra
    // line-height, so this 1px can't mask it.
    setIsClamped(el.scrollHeight > el.clientHeight + 1)
  }, [text, expanded])
  return [ref, isClamped]
}
