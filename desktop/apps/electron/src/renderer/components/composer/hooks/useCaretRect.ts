/**
 * Track the caret's viewport rect while a composer menu (@ / slash) is open.
 *
 * Invariant: the returned rect is in **viewport** coordinates, because its only consumer
 * — `useCaretFloatingPosition` — places a `position: fixed` menu. A fixed coordinate is a
 * snapshot: it goes stale the moment an ancestor scrolls or the window resizes, and the
 * menu is left behind where the caret used to be (SchedFreqWidget / SessionRow hit the
 * same trap). So the rect is re-measured on scroll + resize, not once at open time.
 *
 * Non-obvious dep: the scroll listener is registered in the **capture** phase — what
 * scrolls is an ancestor container (the home page's scroll box, the message list), and
 * `scroll` does not bubble to window.
 */
import { useEffect, useState, type RefObject } from 'react'

import { throttleRaf } from '@/lib/throttleRaf'
import type { RichTextInputHandle } from '../RichTextInput'

/** Positional equality only: menu placement reads top/bottom/left, never the caret's size. */
function sameCaretRect(a: DOMRect | null, b: DOMRect | null): boolean {
  if (a === null || b === null) return a === b
  return a.top === b.top && a.bottom === b.bottom && a.left === b.left
}

/**
 * @param active - whether any menu is open; nothing is measured or subscribed while false
 * @param remeasureKey - re-measure whenever this changes (the composer passes `segments`,
 *   so typing after `@` keeps the menu tracking the caret)
 */
export function useCaretRect(
  editorRef: RefObject<RichTextInputHandle | null>,
  active: boolean,
  remeasureKey: unknown,
): DOMRect | null {
  const [rect, setRect] = useState<DOMRect | null>(null)

  // DOM-sync effect, not §1.17 derived state: the value comes from a DOM measurement.
  // The rect is deliberately NOT cleared when `active` goes false — the menu unmounts
  // anyway, and clearing would make the next open flash at the stale-null position.
  useEffect(() => {
    if (active) {
      setRect(editorRef.current?.getCaretRect() ?? null)
    }
  }, [editorRef, active, remeasureKey])

  useEffect(() => {
    if (!active) return
    const measure = (): void => {
      const next = editorRef.current?.getCaretRect() ?? null
      // Skip the setState when nothing moved: scroll fires once per frame, and setting
      // blindly would re-render the whole menu (up to 440px of rows) on every frame.
      setRect((prev) => (sameCaretRect(prev, next) ? prev : next))
    }
    const scheduleMeasure = throttleRaf(measure)
    window.addEventListener('resize', scheduleMeasure)
    window.addEventListener('scroll', scheduleMeasure, true)
    return () => {
      scheduleMeasure.cancel()
      window.removeEventListener('resize', scheduleMeasure)
      window.removeEventListener('scroll', scheduleMeasure, true)
    }
  }, [editorRef, active])

  return rect
}
