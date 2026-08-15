/**
 * Clipboard behaviour of the composer editor — paste / copy / cut extracted from RichTextInput.
 *
 * The three handlers share one theme: **never trust foreign HTML, and internal token chips must survive**.
 * All rich text entering or leaving the editor is forced through our own Segment[] model
 * (parseSegmentsFromDOM → segmentsToHtml), so:
 *   - foreign rich formatting / scripts pasted in are stripped, leaving only trusted escaped HTML;
 *   - internally copied @ / command chips (carrying data-token-*) round-trip with their identity intact;
 *   - external apps receive clean flattened text/plain.
 *
 * Depends only on editorRef and onPasteIntercept — it never touches segments state (changes go through
 * execCommand, which fires the native onInput, and RichTextInput re-serializes centrally).
 */
import { useCallback, type ClipboardEvent, type RefObject } from 'react'
import { parseSegmentsFromDOM, segmentsToHtml, segmentsToText } from '../segments'

/** Return surface of `useComposerClipboard` — attach directly to the contenteditable. */
export interface ComposerClipboardApi {
  handlePaste: (e: ClipboardEvent<HTMLDivElement>) => void
  /** Shared by copy / cut; when `isCut` is true the selection is additionally deleted. */
  handleClipboardWrite: (e: ClipboardEvent<HTMLDivElement>, isCut: boolean) => void
}

export function useComposerClipboard(
  editorRef: RefObject<HTMLDivElement | null>,
  /** Paste interceptor — returning true means the composer has claimed this paste (turning it into a session mount, etc.). */
  onPasteIntercept?: (e: ClipboardEvent<HTMLDivElement>) => boolean,
): ComposerClipboardApi {
  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLDivElement>) => {
      // Composer paste→mount interception (large text / files / abs-path):
      // when it claims the paste, stop both the native insert AND bubbling to
      // the outer drag/paste attachment handler (which would mock-attach it).
      if (onPasteIntercept?.(e)) {
        e.preventDefault()
        e.stopPropagation()
        return
      }
      // The native contenteditable paste would inline-insert images into the DOM — refuse it.
      if (e.clipboardData.files.length > 0) {
        e.preventDefault()
        return
      }
      // Internally copied @ / command chips: the clipboard's text/html carries data-token-type. Parse it
      // with DOMParser into an inert document (no scripts / onerror / image loads fire), round-trip it
      // through our own safe serializer segmentsToHtml, then insert — this both preserves token identity
      // (id/label/group/path) and emits only trusted escaped html (foreign rich formatting / scripts are
      // stripped). execCommand natively handles selection replacement + caret placement.
      const tokenHtml = e.clipboardData.getData('text/html')
      if (tokenHtml.includes('data-token-type')) {
        e.preventDefault()
        const doc = new DOMParser().parseFromString(tokenHtml, 'text/html')
        const pasted = parseSegmentsFromDOM(doc.body)
        document.execCommand('insertHTML', false, segmentsToHtml(pasted))
        return
      }
      // Force plain-text paste: a native paste carries the source's text/html rich formatting (text copied
      // from a rendered markdown page / code block brings inline style spans with a grey background, and
      // subsequent typing continues inside that style span and inherits the grey). Uniformly degrade to plain text.
      e.preventDefault()
      const text = e.clipboardData.getData('text/plain')
      if (!text) return
      if (text.includes('\n')) {
        // Multi-line: Chromium's insertText splits \n into block-level <div>s, whereas
        // parseSegmentsFromDOM only recognizes <br> — so newlines would be lost on serialization (see
        // "pasted newlines lost"). Go through the trusted segmentsToHtml instead (\n→<br> plus escaping) so
        // newlines enter the DOM as <br> and reuse the existing <br>↔\n round-trip; onInput → serialize fires as usual.
        document.execCommand('insertHTML', false, segmentsToHtml([{ type: 'text', value: text }]))
      } else {
        // Single line: insertText is lighter (replaces the selection, joins the native undo stack) with unchanged behaviour.
        document.execCommand('insertText', false, text)
      }
    },
    [onPasteIntercept],
  )

  // Copy / cut: serialize the SELECTED nodes through our own Segment[] model
  // so @ / command chips survive an internal round-trip (text/html carries the
  // token spans) while external apps still get clean flattened text/plain.
  // Cut additionally deletes the selection (execCommand → onInput re-parse).
  const handleClipboardWrite = useCallback(
    (e: ClipboardEvent<HTMLDivElement>, isCut: boolean) => {
      const el = editorRef.current
      const sel = window.getSelection()
      if (!el || !sel || sel.rangeCount === 0 || sel.isCollapsed) return
      const range = sel.getRangeAt(0)
      if (!el.contains(range.commonAncestorContainer)) return
      const tmp = document.createElement('div')
      tmp.appendChild(range.cloneContents())
      const segs = parseSegmentsFromDOM(tmp)
      e.preventDefault()
      e.clipboardData.setData('text/html', segmentsToHtml(segs))
      e.clipboardData.setData('text/plain', segmentsToText(segs))
      if (isCut) document.execCommand('delete')
    },
    [editorRef],
  )

  return { handlePaste, handleClipboardWrite }
}
