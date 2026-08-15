/**
 * Manages the "live" widget node-view hosts inside the composer — the portal orchestration extracted from RichTextInput.
 *
 * In HTML a widget segment is just an empty `contenteditable=false` host span; the actual interactive control is
 * rendered into it by RichTextInput through a React portal. This hook does two things:
 *   1. `syncWidgetHosts()` — scan the editor DOM and collect the host spans into a list of portal targets.
 *   2. `commitWidget()` — after a control changes its value, write it back to the host's data-* and re-serialize upward.
 *
 * **Key invariant**: `commitWidget` MUST write the new segments into `lastEmittedRef` (marking them as "our own
 * echo"), otherwise RichTextInput's diff effect treats them as an external change → rewrites innerHTML →
 * **the portal hosts are replaced and the controls unmount on the spot**, so the control vanishes the moment the user
 * changes a frequency. This coupling is real, which is why the ref is an explicit parameter rather than hidden inside.
 *
 * **Performance constraint**: `syncWidgetHosts` is only called when innerHTML is (re)written (mount / external segment
 * change), never on every keystroke; and when the host set is unchanged it returns the same reference, so ordinary typing triggers no re-render.
 */
import { useCallback, useState, type MutableRefObject, type RefObject } from 'react'
import { parseSegmentsFromDOM, type Segment } from '../segments'

/** One live widget node-view: the host span + its seeded value/flat. */
export interface WidgetHostEntry {
  id: string
  /** Registry key. **An open value** — read from the DOM's `data-token-kind`, and a historical draft may hold a kind
   *  that is not registered in this session, in which case WidgetHost's fallback covers it (see widgets/registry.ts::getWidgetDef). */
  kind: string
  value: string
  flat: string
  el: HTMLElement
}

/** Return surface of `useWidgetHosts`. */
export interface WidgetHostsApi {
  /** The currently live host list — RichTextInput calls createPortal against it. */
  widgetHosts: WidgetHostEntry[]
  /** Re-scan the DOM to collect hosts; if the set is unchanged no re-render is triggered. Only call this after innerHTML has been rewritten. */
  syncWidgetHosts: () => void
  /** Control changed its value → write back the host's data-* → re-serialize and report upward (marked as our own echo). */
  commitWidget: (host: HTMLElement, value: string, flat: string) => void
}

export function useWidgetHosts(
  editorRef: RefObject<HTMLDivElement | null>,
  /** RichTextInput's "last emitted content" cache — commitWidget must **write** it (to mark its own echo),
   *  hence MutableRefObject rather than the read-only RefObject. See the file header for the reasoning. */
  lastEmittedRef: MutableRefObject<Segment[]>,
  onChange: (segments: Segment[]) => void,
): WidgetHostsApi {
  const [widgetHosts, setWidgetHosts] = useState<WidgetHostEntry[]>([])

  const syncWidgetHosts = useCallback(() => {
    const el = editorRef.current
    if (!el) return
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-token-type="widget"]'))
    setWidgetHosts((prev) => {
      if (prev.length === nodes.length && prev.every((p, i) => p.el === nodes[i])) return prev
      return nodes.map((node) => ({
        id: node.getAttribute('data-token-id') ?? '',
        kind: node.getAttribute('data-token-kind') ?? '',
        value: node.getAttribute('data-token-value') ?? '',
        flat: node.getAttribute('data-token-flat') ?? '',
        el: node,
      }))
    })
  }, [editorRef])

  // A widget control changed its value → write the host's data-* attrs, then
  // re-serialize the DOM and push up marked as our own echo (lastEmittedRef) so
  // the diff effect does NOT rewrite innerHTML — the portal stays mounted.
  const commitWidget = useCallback(
    (host: HTMLElement, value: string, flat: string) => {
      host.setAttribute('data-token-value', value)
      host.setAttribute('data-token-flat', flat)
      const el = editorRef.current
      if (!el) return
      const next = parseSegmentsFromDOM(el)
      lastEmittedRef.current = next
      onChange(next)
    },
    [editorRef, lastEmittedRef, onChange],
  )

  return { widgetHosts, syncWidgetHosts, commitWidget }
}
