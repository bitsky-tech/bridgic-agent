/**
 * Contenteditable wrapper using a Segment-based content model.
 *
 * Segments support text + non-editable token spans (slash/mention/label
 * tokens inserted by the composer's menus). Native contenteditable
 * behavior gives us:
 *   - Backspace adjacent to a token deletes the whole token in one keystroke
 *     (no special handling needed in our code)
 *   - Token visually flows inline with surrounding text
 *
 * Round-trip:
 *   external segments → innerHTML (dangerouslySetInnerHTML, when props
 *     don't match current DOM)
 *   user keypress → contenteditable mutates DOM natively → onInput fires
 *     → parseSegmentsFromDOM → onChange(newSegments)
 *
 * To avoid React/contenteditable fights, we never re-render via JSX after
 * the initial mount. The single useEffect compares external props.segments
 * with serialized DOM and only rewrites innerHTML when they diverge
 * (typically: menu just inserted a token, draft just loaded on session
 * switch). User typing produces matching segments so the effect no-ops.
 *
 * Drop/paste are preventDefault'd here so the outer composer's paste→mount
 * pipeline (useComposerFileDrop / onPasteIntercept) is the only consumer
 * (otherwise contenteditable would inline-insert dropped images, bypassing
 * the session-mount flow).
 */
import { forwardRef, useImperativeHandle, useRef, useEffect, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { rlog } from '@/lib/logger'
import {
  caretOffsetInEditor,
  EMPTY_SEGMENTS,
  parseSegmentsFromDOM,
  segmentsEqual,
  segmentsToHtml,
  segmentsToText,
  type Segment,
} from './segments'
import { pickAdjacentField, placeCaretAtEnd, placeCaretAtOffset, placeCaretInElement } from './caretDom'
import { useWidgetHosts } from './hooks/useWidgetHosts'
import { useComposerClipboard } from './hooks/useComposerClipboard'
import { WidgetHost } from './widgets'
import { RotatingPlaceholder } from './RotatingPlaceholder'

export interface RichTextInputProps {
  segments: Segment[]
  onChange: (segments: Segment[]) => void
  /** Caret offset (index into the flattened text) after each input, so the
   *  composer's trigger detection can bound the @ / filter at the caret. */
  onCaretChange?: (offset: number | null) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLDivElement>) => void
  /** Paste interceptor — return true to claim the paste (the editor then
   *  prevents the native insert + stops bubbling). Used for the paste→mount
   *  flow: large text / files / absolute-path pastes become session mounts. */
  onPasteIntercept?: (e: React.ClipboardEvent<HTMLDivElement>) => boolean
  onCompositionStart?: () => void
  onCompositionEnd?: () => void
  placeholder?: string
  disabled?: boolean
  className?: string
}

export interface RichTextInputHandle {
  /** Caret rect in viewport coords (for floating menu positioning). */
  getCaretRect: () => DOMRect | null
  focus: () => void
  /** Focus + place caret at a global char offset AFTER the next DOM rewrite.
   *  Used by menu insert so the caret lands right after the inserted token
   *  (not at editor end). Deferred because segments were just setState'd and
   *  the DOM hasn't updated yet. */
  focusAtOffset: (offset: number) => void
  /** Focus + place caret at the END of an editable `field` region (by data-field-id)
   *  AFTER the next DOM rewrite — inside the span even when empty, so typing fills
   *  the slot (a plain offset would land at its boundary, before the span). Used by
   *  the schedule template seed to drop the caret into the description field. */
  focusField: (fieldId: string) => void
  /** Insert token/text segments at the caret the user last placed in the
   *  editor (e.g. clicked mid-text), then leave the caret after them. Used by
   *  the right-panel "add to chat" flow so an @-mention lands where the user is
   *  pointing, not always at the end. Falls back to end when no caret is known. */
  insertSegmentsAtCaret: (segs: Segment[]) => void
  /** Move the caret to the next/previous fillable `field` slot (data-field-id),
   *  landing the caret INSIDE it. Powers Tab / Shift+Tab between guided-template
   *  slots (description ↔ name). Returns false when there's no such target (no fields, or
   *  already at the last/first one) so the caller can fall through to native Tab. */
  focusAdjacentField: (direction: 'next' | 'prev') => boolean
}

export const RichTextInput = forwardRef<RichTextInputHandle, RichTextInputProps>(
  function RichTextInput(
    {
      segments,
      onChange,
      onCaretChange,
      onKeyDown,
      onPasteIntercept,
      onCompositionStart,
      onCompositionEnd,
      placeholder,
      disabled,
      className,
    },
    ref,
  ) {
    const editorRef = useRef<HTMLDivElement>(null)
    // Cache last-emitted segments to detect whether the next props.segments
    // is "our own echo from onInput" (skip DOM rewrite) vs "external mutation"
    // (rewrite DOM + restore caret to end).
    const lastEmittedRef = useRef<Segment[]>(segments)
    // Last caret offset the user placed inside the editor (typing / click /
    // arrow). Survives blur (it's a ref, not the live DOM selection) so an
    // external insert (right-panel @) can land where the user last pointed.
    const lastCaretRef = useRef<number | null>(null)
    // Pending caret target (a global offset) for when the menu inserts a token. Consumed by the diff
    // effect after it rewrites the DOM, so the caret lands after the token rather than at the end (when
    // insertItem is called the setState has not flushed yet, the DOM has not changed, and we cannot
    // position immediately).
    const pendingCaretRef = useRef<number | null>(null)
    // Pending target (data-field-id) for when a seed wants the caret to land in an editable field (an
    // empty slot). Consumed by the diff effect after it rewrites the DOM: it positions inside that span
    // (reachable even when empty, and typing immediately triggers the :empty placeholder to hide).
    const pendingFieldFocusRef = useRef<string | null>(null)

    // Live widget node-views (portal host collection + control write-back) — see hooks/useWidgetHosts.
    // Only synced when innerHTML is rewritten; ordinary typing does not trigger a re-render.
    const { widgetHosts, syncWidgetHosts, commitWidget } = useWidgetHosts(
      editorRef,
      lastEmittedRef,
      onChange,
    )

    const rememberCaret = useCallback(() => {
      const el = editorRef.current
      if (!el || document.activeElement !== el) return
      // Clicking / moving the caret with arrow keys does not fire onInput — so this both records
      // lastCaretRef (used to position right-panel @ insertions) and **reports** the latest caret, so the
      // trigger check (findTriggerAtCaret) reads the real caret instead of the position of the last
      // keystroke. Without this step: after Esc, clicking elsewhere and typing @ would not open the menu
      // (the menusForceClosed reset predicate used a stale caret and kept concluding "still on the old @ run").
      const offset = caretOffsetInEditor(el)
      lastCaretRef.current = offset
      onCaretChange?.(offset)
    }, [onCaretChange])

    // Keep the reported caret in sync with the REAL selection, not just keyup/mouseup:
    // during key auto-repeat (holding ↓/↑) no keyup fires, so the composer's history
    // check would keep reading the pre-move caret and paging would jam until the key is
    // released. `selectionchange` is queued as a task after every native caret move, so
    // it lands ahead of the next auto-repeated keydown. rememberCaret self-guards on
    // focus (activeElement !== el → no-op), so the document-level registration is safe.
    useEffect(() => {
      document.addEventListener('selectionchange', rememberCaret)
      return () => document.removeEventListener('selectionchange', rememberCaret)
    }, [rememberCaret])

    // Initial DOM render — runs once on mount only (deps:[]).
    // Subsequent updates go through the diff effect below.
    useEffect(() => {
      const el = editorRef.current
      if (!el) return
      el.innerHTML = segmentsToHtml(segments)
      syncWidgetHosts()
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    // Diff effect — rewrite DOM only when external segments differ from
    // what we last emitted. This skips the case where user typing produced
    // the new segments (DOM is already correct).
    useEffect(() => {
      if (segmentsEqual(segments, lastEmittedRef.current)) {
        // This pass will not rewrite the DOM, so any pending target is already stale — it must be cleared in
        // place, otherwise it survives into the next real rewrite and hijacks the caret to a position
        // unrelated to the content at that time.
        // (Everyone who registers one follows the "register, then immediately change the content" pattern;
        // nobody relies on a pending target surviving across renders: menu insertion / schedule template seed
        // / history navigation all behave this way.)
        pendingCaretRef.current = null
        pendingFieldFocusRef.current = null
        return
      }
      const el = editorRef.current
      if (!el) return
      el.innerHTML = segmentsToHtml(segments)
      lastEmittedRef.current = segments
      syncWidgetHosts()
      // The seed asked for the caret to land in a field (an empty slot) → position inside the span (takes precedence over the offset).
      if (pendingFieldFocusRef.current !== null) {
        const fieldId = pendingFieldFocusRef.current
        pendingFieldFocusRef.current = null
        pendingCaretRef.current = null
        const fieldEl = el.querySelector<HTMLElement>(`[data-field-id="${CSS.escape(fieldId)}"]`)
        if (fieldEl) {
          el.focus({ preventScroll: true })
          placeCaretInElement(fieldEl) // land inside the span (its start when empty), not on the boundary before it
          const offset = caretOffsetInEditor(el)
          lastCaretRef.current = offset
          onCaretChange?.(offset)
        }
      } else if (pendingCaretRef.current !== null) {
        const target = pendingCaretRef.current
        el.focus({ preventScroll: true })
        placeCaretAtOffset(el, target)
        pendingCaretRef.current = null
        // **Report** the landing position after a menu insertion so the caret state matches the real DOM
        // caret; otherwise, after picking a mention the caret would stay at the old @filter position and every
        // subsequent trigger check / forceClosed reset predicate would be computed on a stale caret (the root
        // cause of "@ permanently suppressed after picking a mention when the following text contains `/`").
        lastCaretRef.current = target
        onCaretChange?.(target)
      } else if (document.activeElement === el) {
        placeCaretAtEnd(el)
      }
      // Triggered by segments only (the DOM is only rewritten when external segments change). onCaretChange
      // is a behaviourally stable setter closure (it only calls setCaret + writes a ref), so putting it in
      // deps would just make this effect run segmentsEqual for nothing on every render — hence the explicit
      // exclusion.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [segments])

    useImperativeHandle(ref, () => ({
      getCaretRect: () => {
        try {
          const el = editorRef.current
          const sel = window.getSelection()
          if (!sel || sel.rangeCount === 0) return el?.getBoundingClientRect() ?? null
          const range = sel.getRangeAt(0)
          // When the selection is not inside this editor (after switching sessions focus is still on the
          // session list and the old Range has been invalidated by the innerHTML rewrite),
          // range.getBoundingClientRect() returns a bogus (≈0,0) coordinate and the menu gets pinned to the
          // top-left corner of the screen (see "popover offset when switching to a session containing @").
          // Fall back to anchoring on the editor itself so the overlay positions against the input box.
          // Consistent with the contains guards in caretOffsetInEditor / handleClipboardWrite.
          if (!el || !el.contains(range.endContainer)) {
            return el?.getBoundingClientRect() ?? null
          }
          const collapsed = range.cloneRange()
          collapsed.collapse(false)
          const rect = collapsed.getBoundingClientRect()
          // On an empty document / token-only content the rect may be (0,0,0,0); fall back to the editor itself
          if (rect.width === 0 && rect.height === 0) {
            return el.getBoundingClientRect()
          }
          return rect
        } catch (err) {
          rlog.warn('[RichTextInput] getCaretRect failed', err)
          return null
        }
      },
      focus: () => {
        const el = editorRef.current
        if (!el) return
        // preventScroll: focusing the bottom input box when switching sessions should not scroll the message list to the bottom and interrupt reading history.
        el.focus({ preventScroll: true })
        placeCaretAtEnd(el)
      },
      focusAtOffset: (offset: number) => {
        // Store the pending target and let the diff effect position it after rewriting the DOM (see pendingCaretRef).
        pendingCaretRef.current = offset
      },
      focusField: (fieldId: string) => {
        // Let the diff effect drop the caret into that field after rewriting the DOM (see pendingFieldFocusRef).
        pendingFieldFocusRef.current = fieldId
      },
      insertSegmentsAtCaret: (segs: Segment[]) => {
        const el = editorRef.current
        if (!el) return
        const sel = window.getSelection()
        const liveInEditor =
          !!sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)
        // Keep a live in-editor selection (preserved when the trigger button
        // doesn't steal focus); otherwise restore the last remembered caret.
        if (!liveInEditor) {
          el.focus()
          if (lastCaretRef.current !== null) placeCaretAtOffset(el, lastCaretRef.current)
          else placeCaretAtEnd(el)
        }
        const insertOffset = caretOffsetInEditor(el) ?? 0
        // insertHTML splices at the caret; round-trip through our trusted
        // serializer keeps it injection-free, and onInput re-parses → onChange.
        document.execCommand('insertHTML', false, segmentsToHtml(segs))
        // insertHTML's caret landing position is unreliable after a contenteditable=false chip (measured: it
        // jumps into the text after it). Position the caret explicitly at "insertion point + inserted content
        // length" so it sits right after the chip + space.
        const after = insertOffset + segmentsToText(segs).length
        placeCaretAtOffset(el, after)
        lastCaretRef.current = after
        onCaretChange?.(after)
      },
      focusAdjacentField: (direction: 'next' | 'prev'): boolean => {
        const el = editorRef.current
        if (!el) return false
        // Only jump between field slots that still exist in the DOM (a field that has been filled in and
        // rewritten is flattened to text and no longer has a span, so it naturally drops out of the jump sequence).
        const fields = Array.from(el.querySelectorAll<HTMLElement>('[data-field-id]'))
        const sel = window.getSelection()
        const anchor = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).startContainer : null
        // The target-selection logic is extracted into the pure function pickAdjacentField (caretDom.ts, unit tested).
        const target = pickAdjacentField(fields, anchor, direction)
        if (!target) return false // no field / already at the last (first) one: let the native Tab through
        el.focus({ preventScroll: true })
        placeCaretInElement(target)
        const offset = caretOffsetInEditor(el)
        lastCaretRef.current = offset
        onCaretChange?.(offset)
        return true
      },
    }))

    const handleInput = useCallback(() => {
      const el = editorRef.current
      if (!el) return
      const next = parseSegmentsFromDOM(el)
      // When the user types and then deletes everything, contenteditable often leaves a <br> filler node in
      // the DOM. parse turns <br> into a newline character, so segments are not truly empty → the `:empty` CSS selector
      // does not match → the placeholder stops working. When this "only whitespace/newlines left" state is
      // detected, force-clear the DOM leftovers so the placeholder shows again.
      const hasTokens = next.some((s) => s.type !== 'text')
      const allText = next.map((s) => (s.type === 'text' ? s.value : '')).join('')
      if (!hasTokens && /^[\s\n\r]*$/.test(allText)) {
        if (el.innerHTML !== '') el.innerHTML = ''
        lastEmittedRef.current = EMPTY_SEGMENTS
        onChange(EMPTY_SEGMENTS)
        onCaretChange?.(0)
        syncWidgetHosts() // editor emptied → drop any stale widget portals
        return
      }
      lastEmittedRef.current = next
      onChange(next)
      // Report the caret AFTER onChange so the trigger detector (which keys off
      // the new segments) bounds the @ / filter at the live caret position.
      const offset = caretOffsetInEditor(el)
      lastCaretRef.current = offset
      onCaretChange?.(offset)
      // A widget host may have been backspace-deleted (contenteditable=false span
      // removed whole) — reconcile the portal set. No-ops when unchanged.
      syncWidgetHosts()
    }, [onChange, onCaretChange, syncWidgetHosts])

    // Plain-text editor: block the browser's native rich-text shortcuts on contenteditable.
    // Cmd/Ctrl+B/I/U toggle bold/italic/underline, inserting <b>/<i>/<u> or font-weight nodes, and once
    // the caret is inside them subsequent typing inherits the style (observed by the user: text turning
    // bold on its own). The composer has no rich-text semantics, so these keys should be no-ops; leftover
    // styling is additionally neutralised by the CSS on .composer-editor. Every other key is passed
    // through to the outer onKeyDown (send / menu navigation).
    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLDivElement>) => {
        if ((e.metaKey || e.ctrlKey) && !e.altKey) {
          const k = e.key.toLowerCase()
          if (k === 'b' || k === 'i' || k === 'u') {
            e.preventDefault()
            return
          }
        }
        onKeyDown?.(e)
      },
      [onKeyDown],
    )

    // contenteditable's native drop/paste inline-inserts images into the DOM — refuse, and let the outer
    // useComposerFileDrop take over (bubbling to the container's onDrop → the mount pipeline).
    const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault()
    }, [])
    const { handlePaste, handleClipboardWrite } = useComposerClipboard(editorRef, onPasteIntercept)

    return (
      <>
        {/* relative container: the placeholder must be a **sibling** of the editor (putting it inside the
            contenteditable would make it content and `:empty` would immediately stop matching), while still
            being absolutely positioned on top of it. The editor itself is a block, so wrapping it in a div is layout-equivalent. */}
        <div className="relative">
          <div
            ref={editorRef}
            role="textbox"
            contentEditable={!disabled}
            // Plain text input, so turn off the browser's spell checker — otherwise non-dictionary words like /asadss get a red squiggle.
            spellCheck={false}
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            // Clicking / moving the caret with arrow keys does not fire onInput — record the last caret position
            // here for positioning right-panel @ insertions (see insertSegmentsAtCaret).
            onMouseUp={rememberCaret}
            onKeyUp={rememberCaret}
            onCompositionStart={onCompositionStart}
            onCompositionEnd={onCompositionEnd}
            onDrop={handleDrop}
            onPaste={handlePaste}
            onCopy={(e) => handleClipboardWrite(e, false)}
            onCut={(e) => handleClipboardWrite(e, true)}
            className={[
              // composer-editor: the hook CSS uses to neutralise leftover rich-text styling (see index.css).
              'composer-editor',
              'min-h-[24px] max-h-[200px] overflow-auto outline-none text-text-primary text-base font-sans',
              'whitespace-pre-wrap break-words',
              className ?? '',
            ].join(' ')}
          />
          {/* Placeholder overlay. It used to be the editor's ::before (content: attr(...)), but a pseudo-element
              cannot hold a "scrolling switch" — that needs two boxes, old and new. Now that it is real DOM, its
              visibility is controlled by index.css's
              `.composer-editor:not(:empty) ~ .composer-placeholder`, while the emptiness check is still left to
              the CSS `:empty` (DOM truth, more reliable than inferring it on the React side).
              The font size/family must match the editor character for character, otherwise the placeholder does
              not line up with real input.
              It uses text-secondary rather than the darkest tertiary — tertiary against the input's background
              has too little contrast and makes the whole empty box look grey, "as if disabled". */}
          {placeholder && (
            <div
              aria-hidden
              /* Being absolute already makes it a positioned element, so a leaving node's absolute
                 positions against it directly; no extra relative is needed (writing both would conflict). */
              className="composer-placeholder absolute inset-x-0 top-0 overflow-hidden pointer-events-none text-text-secondary text-base font-sans"
            >
              <RotatingPlaceholder text={placeholder} />
            </div>
          )}
        </div>
        {/* Widget node-views — each interactive control is portaled INTO its
            `contenteditable=false` host span (which lives inside the div above).
            Portals sit in the React tree here (siblings of the div), so their
            events don't bubble into the contenteditable's key handlers. */}
        {widgetHosts.map((h, i) =>
          createPortal(
            <WidgetHost
              kind={h.kind}
              value={h.value}
              flat={h.flat}
              onChange={(value, flat) => commitWidget(h.el, value, flat)}
            />,
            h.el,
            // Composite key: index guarantees uniqueness even if two widgets share
            // an id (copy/paste); including the seeded value forces a fresh remount
            // when a re-seed (e.g. editing A → editing B in a reused draft) changes it, so a
            // widget's local state can't go stale. Stable during typing/edits
            // (widgetHosts is only rebuilt on an innerHTML rewrite).
            `${h.id}-${i}-${h.value}`,
          ),
        )}
      </>
    )
  },
)
