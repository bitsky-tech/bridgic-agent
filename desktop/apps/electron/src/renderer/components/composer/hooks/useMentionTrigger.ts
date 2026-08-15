/**
 * Mention trigger over Segment[] model. Same shape as useSlashTrigger.
 *
 * `@` at word boundary followed by non-whitespace filter. Selected item
 * becomes a mention token segment with `group` metadata preserved so the
 * badge can be styled per-section.
 */
import { useCallback, useMemo } from 'react'
import type { RefObject } from 'react'
import type { RichTextInputHandle } from '../RichTextInput'
import {
  findTriggerAtCaret,
  replaceTriggerWithToken,
  tokenInsertCaretOffset,
  type Segment,
  type TokenSegment,
  type TriggerMatch,
} from '../segments'

export interface MentionTrigger {
  isOpen: boolean
  filter: string
  close: () => void
  /** `path` = the path relative to the mount (when referencing a child item inside a mounted folder); omitted = the mount root. */
  insertItem: (item: { id: string; label: string; group: string; path?: string }) => void
}

export function useMentionTrigger(
  editorRef: RefObject<RichTextInputHandle | null>,
  segments: Segment[],
  onSegmentsChange: (next: Segment[]) => void,
  forceClosed: boolean,
  caret: number | null,
): MentionTrigger {
  const match: TriggerMatch | null = useMemo(() => {
    if (forceClosed) return null
    return findTriggerAtCaret(segments, '@', caret)
  }, [segments, forceClosed, caret])

  const close = useCallback(() => {}, [])

  const insertItem = useCallback(
    (item: { id: string; label: string; group: string; path?: string }) => {
      if (!match) return
      const token: TokenSegment = item.path
        ? { type: 'mention', id: item.id, label: item.label, group: item.group, path: item.path }
        : { type: 'mention', id: item.id, label: item.label, group: item.group }
      onSegmentsChange(replaceTriggerWithToken(segments, match, token))
      // Put the caret after the just-inserted token + its separating space (rather than at the end of the editor) — inserting in the middle does not jump to the end.
      editorRef.current?.focusAtOffset(tokenInsertCaretOffset(segments, match, token))
    },
    [match, segments, onSegmentsChange, editorRef],
  )

  return {
    isOpen: !!match,
    filter: match?.filter ?? '',
    close,
    insertItem,
  }
}
