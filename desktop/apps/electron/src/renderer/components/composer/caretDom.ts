/**
 * DOM primitives for caret placement — the pure DOM part extracted from RichTextInput (no React).
 *
 * **Core invariant**: the character accounting in `placeCaretAtOffset` must be **exactly identical** to
 * `segments.caretOffsetInEditor` — text nodes count their textContent length, `<br>` counts as 1, and a token chip counts as
 * `tokenDomLength` (a widget host is filled by a portal, so it counts data-token-flat rather than the rendered characters).
 * The two are a pair of inverse functions: the former is "offset → caret", the latter "caret → offset". The moment their
 * accounting drifts, the caret lands in the wrong place — and **nothing throws**; it only shows up as "the @ menu pops up in
 * the wrong place / input is inserted somewhere strange".
 * caretDom.test.ts pins this invariant with a round-trip test (place(n) → read() === n).
 *
 * Why it is a separate file: this is the hardest and least covered part of the composer, and buried inside the 563-line
 * RichTextInput it was both untestable and in the way of getting that file back within the §1.14 line budget.
 */
import { tokenDomLength } from './segments'

/** Move caret to the very end of the editor element. */
export function placeCaretAtEnd(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  if (sel) {
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

/**
 * Pick the field slot to jump to from the current selection — powers Tab /
 * Shift+Tab between guided-template `field` slots. Pure(DOM-only, no React):
 *   - not inside any field (anchor null / outside) → first (next) or last (prev)
 *   - inside field i → i±1, or null when that runs off the end (caller then lets
 *     native Tab through instead of trapping focus).
 *
 * `fields` MUST be in document order (querySelectorAll gives this). `anchor` is
 * the selection's start container; `f.contains(anchor)` (contains-self = true)
 * locates the current field even when it's empty.
 */
export function pickAdjacentField(
  fields: HTMLElement[],
  anchor: Node | null,
  direction: 'next' | 'prev',
): HTMLElement | null {
  if (fields.length === 0) return null
  const currentIdx = anchor ? fields.findIndex((f) => f.contains(anchor)) : -1
  let targetIdx: number
  if (currentIdx === -1) {
    targetIdx = direction === 'next' ? 0 : fields.length - 1
  } else {
    targetIdx = currentIdx + (direction === 'next' ? 1 : -1)
  }
  return fields[targetIdx] ?? null
}

/** Place the caret at the END of an element's own contents — INSIDE it, even when
 *  the element is empty (an empty inline-block `field` span still holds the caret).
 *  Used to drop the caret into a fillable slot: seed focus + Tab navigation both
 *  need the caret to land *within* the field span (a plain offset would sit at its
 *  boundary, before the span, so typing would spill outside). */
export function placeCaretInElement(el: HTMLElement): void {
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  const sel = window.getSelection()
  if (sel) {
    sel.removeAllRanges()
    sel.addRange(range)
  }
}

/**
 * Place the caret at a global char offset (index into the flattened text),
 * mirroring `caretOffsetInEditor`'s accounting (text length, `<br>` = 1, token
 * chip = its flattened length). The caret snaps to a chip's edge rather than
 * landing inside it. Falls back to end-of-editor when the offset overruns.
 */
export function placeCaretAtOffset(root: HTMLElement, offset: number): void {
  const range = document.createRange()
  let remaining = offset
  let done = false
  const visit = (parent: Node): void => {
    for (const node of Array.from(parent.childNodes)) {
      if (done) return
      if (node.nodeType === Node.TEXT_NODE) {
        const len = (node.textContent ?? '').length
        if (remaining <= len) {
          range.setStart(node, remaining)
          done = true
          return
        }
        remaining -= len
        continue
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue
      const el = node as HTMLElement
      if (el.tagName === 'BR') {
        if (remaining <= 0) {
          range.setStartBefore(el)
          done = true
          return
        }
        remaining -= 1
        continue
      }
      if (el.getAttribute('data-token-type')) {
        // widget host is portal-filled → count its logical flat length, not the
        // rendered control chars (see tokenDomLength). slash/mention use textContent.
        const len = tokenDomLength(el)
        if (remaining <= 0) {
          range.setStartBefore(el)
          done = true
          return
        }
        if (remaining <= len) {
          range.setStartAfter(el)
          done = true
          return
        }
        remaining -= len
        continue
      }
      visit(el)
    }
  }
  visit(root)
  if (!done) {
    range.selectNodeContents(root)
    range.collapse(false)
  } else {
    range.collapse(true)
  }
  const sel = window.getSelection()
  if (sel) {
    sel.removeAllRanges()
    sel.addRange(range)
  }
}
