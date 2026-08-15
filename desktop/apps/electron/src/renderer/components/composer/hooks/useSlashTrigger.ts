/**
 * Slash command trigger over Segment[] model.
 *
 * Looks at the trailing text segment for a `/` at word boundary followed
 * by a non-whitespace filter string. When the user selects a command,
 * the trigger + filter portion of that text segment is replaced with a
 * slash token segment + trailing empty space segment (caret lands after
 * the space).
 *
 * `forceClosed` (controlled by FreeFormInput) short-circuits the match
 * for the lifetime of one menu interaction — without it, repeatedly
 * pressing Esc would still open the menu again on next text mutation.
 */
import { useCallback, useMemo } from 'react'
import type { RefObject } from 'react'
import type { RichTextInputHandle } from '../RichTextInput'
import {
  findTriggerAtCaret,
  replaceTriggerWithSegments,
  replaceTriggerWithToken,
  tokenInsertCaretOffset,
  type MentionGroup,
  type Segment,
  type TokenSegment,
  type TriggerMatch,
} from '../segments'

export interface SlashTrigger {
  isOpen: boolean
  filter: string
  close: () => void
  insertCommand: (commandId: string, label: string) => void
  insertWorkflow: (workflowId: string, label: string) => void
  /** Insert a saved Schedule action; submitting it triggers one immediate run. */
  insertSchedule: (scheduleId: string, label: string) => void
  /** Replace the trigger with a mention reference token (the capability reference inserted when a skill is
   *  picked from the `/` menu). Workflow and Schedule use executable Slash tokens.
   *  `group` is tightened to MentionGroup: this is the **write side**, whose value domain is closed (the read side still
   *  accepts string for compatibility with historical drafts, see the comment on segments.MentionGroup). */
  insertReference: (item: { id: string; label: string; group: MentionGroup }) => void
  /** Replace the `/…` run with a sequence of segments (e.g. the /schedule guided
   *  template), keeping any text before/after the trigger; optionally focus a field. */
  insertSegments: (insert: Segment[], focusFieldId?: string) => void
}

export function useSlashTrigger(
  editorRef: RefObject<RichTextInputHandle | null>,
  segments: Segment[],
  onSegmentsChange: (next: Segment[]) => void,
  forceClosed: boolean,
  caret: number | null,
): SlashTrigger {
  const match: TriggerMatch | null = useMemo(() => {
    if (forceClosed) return null
    return findTriggerAtCaret(segments, '/', caret)
  }, [segments, forceClosed, caret])

  const close = useCallback(() => {
    // Closing without selecting: caller flips forceClosed. No content change here.
  }, [])

  const insertCommand = useCallback(
    (commandId: string, label: string) => {
      if (!match) return
      const token: TokenSegment = { type: 'slash', id: commandId, label }
      onSegmentsChange(replaceTriggerWithToken(segments, match, token))
      // Put the caret after the token + its separating space (rather than at the end), so inserting in the middle does not jump to the end.
      editorRef.current?.focusAtOffset(tokenInsertCaretOffset(segments, match, token))
    },
    [match, segments, onSegmentsChange, editorRef],
  )

  const insertReference = useCallback(
    (item: { id: string; label: string; group: MentionGroup }) => {
      if (!match) return
      const token: TokenSegment = { type: 'mention', id: item.id, label: item.label, group: item.group }
      onSegmentsChange(replaceTriggerWithToken(segments, match, token))
      editorRef.current?.focusAtOffset(tokenInsertCaretOffset(segments, match, token))
    },
    [match, segments, onSegmentsChange, editorRef],
  )

  const insertWorkflow = useCallback(
    (workflowId: string, label: string) => {
      if (!match) return
      const token: TokenSegment = { type: 'slash', id: workflowId, label, resource: 'workflow' }
      onSegmentsChange(replaceTriggerWithToken(segments, match, token))
      editorRef.current?.focusAtOffset(tokenInsertCaretOffset(segments, match, token))
    },
    [match, segments, onSegmentsChange, editorRef],
  )

  const insertSchedule = useCallback(
    (scheduleId: string, label: string) => {
      if (!match) return
      const token: TokenSegment = { type: 'slash', id: scheduleId, label, resource: 'schedule' }
      onSegmentsChange(replaceTriggerWithToken(segments, match, token))
      editorRef.current?.focusAtOffset(tokenInsertCaretOffset(segments, match, token))
    },
    [match, segments, onSegmentsChange, editorRef],
  )

  const insertSegments = useCallback(
    (insert: Segment[], focusFieldId?: string) => {
      if (!match) return
      onSegmentsChange(replaceTriggerWithSegments(segments, match, insert))
      // Same landing behaviour as pendingComposerSeed's schedule template: swap the content first, then focus the description slot.
      if (focusFieldId) editorRef.current?.focusField(focusFieldId)
    },
    [match, segments, onSegmentsChange, editorRef],
  )

  return {
    isOpen: !!match,
    filter: match?.filter ?? '',
    close,
    insertCommand,
    insertWorkflow,
    insertSchedule,
    insertReference,
    insertSegments,
  }
}
