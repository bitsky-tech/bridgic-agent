/**
 * Task review surface — temporarily occupies the shared right-side dock. Two modes:
 *  - Preview: renders the `.work/.build/task.md` markdown; selecting text floats a "comment" affordance → "add" stages it.
 *  - Edit: a textarea showing the raw markdown; saving writes straight to disk through Electron IPC
 *    (saveSpecEditAtom → fs:writeFile) and simulates sending a human message to notify the Agent.
 *
 * Key invariant: comments are only "collected" into pendingComments (persisted per session); the actual send is done by
 * CommentFeedbackPanel on the left, which merges them into a single turn. Selection is based on the DOM rendered by MarkdownMessage.
 *
 * Second invariant: everything the user has **typed but not committed** — the comment composer and the source-edit
 * textarea — lives in `SpecSessionDraft` (atoms/build.ts), keyed by session, NOT in local state. This component is
 * unmounted every time the active session changes, so local state was silently destroyed on each switch.
 * Purely ephemeral UI state (the floating selection bubble, diff/document toggle, quote expansion) stays local on purpose —
 * but the bubble carries the session it was made in, because it is the one piece of local state that could otherwise seed a
 * comment across a session boundary.
 *
 * Mount point: SessionResourcePanel renders this component while the Build mode surface is selected.
 */
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { useIsClamped } from '@/hooks/useIsClamped'
import {
  SaveSpecResult,
  addPendingCommentAtom,
  currentBriefAtom,
  currentOriginalBriefAtom,
  currentPendingTaskConfirmAtom,
  currentSpecDraftAtom,
  currentTaskDiffBaselineAtom,
  editBaselinePreviewAtom,
  pendingCommentsAtom,
  saveSpecEditAtom,
  setSpecCommentDraftAtom,
  setSpecEditDraftAtom,
  specPreviewArchivedAtom,
} from '@/atoms/build'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { settingsAtom } from '@/atoms/settings'
import { showToastAtom } from '@/atoms/toast'
import { resolveSendKeyAction } from '@/lib/sendKeyAction'
import { Icons } from '@/components/amphi/Icons'
import { TaskReviewActions } from '@/components/amphi/TaskConfirmCard'
import { Tooltip } from '@/components/amphi/Tooltip'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { SESSION_STATUS_BAR_HEIGHT_PX } from './SessionStatusBar'

/** Position of the floating "comment" button after a selection hit (content coordinates relative to the scroll container). */
interface FloatingSelection {
  /** Session the selection was made in. The bubble is local state and the pane survives a
   *  session switch when both sessions have the preview open, so without this stamp the
   *  bubble would keep hovering over the *next* session's document and seed a comment whose
   *  quote comes from the previous one. */
  sessionId: string | null
  text: string
  top: number
  left: number
}

type DiffLine = { kind: 'same' | 'added' | 'removed'; value: string; oldLine?: number; newLine?: number }

export function SpecPreviewPane() {
  const { t } = useTranslation()
  const brief = useAtomValue(currentBriefAtom)
  const originalBrief = useAtomValue(currentOriginalBriefAtom)
  const pendingTaskConfirm = useAtomValue(currentPendingTaskConfirmAtom)
  const taskDiffBaseline = useAtomValue(currentTaskDiffBaselineAtom)
  const editBaselinePreview = useAtomValue(editBaselinePreviewAtom)
  const archived = useAtomValue(specPreviewArchivedAtom)
  const sessionId = useAtomValue(activeSessionIdAtom)
  const pendingCount = useAtomValue(pendingCommentsAtom).length
  const addComment = useSetAtom(addPendingCommentAtom)
  const saveSpecEdit = useSetAtom(saveSpecEditAtom)
  const showToast = useSetAtom(showToastAtom)
  // Unsent input is session-scoped state, not component state — see the file header.
  const draft = useAtomValue(currentSpecDraftAtom)
  const setCommentDraft = useSetAtom(setSpecCommentDraftAtom)
  const setEditDraft = useSetAtom(setSpecEditDraftAtom)

  const bodyRef = useRef<HTMLDivElement>(null)
  const [rawSelection, setSelection] = useState<FloatingSelection | null>(null)
  // A selection made in another session is dead the moment we switch away (see FloatingSelection).
  const selection = rawSelection?.sessionId === sessionId ? rawSelection : null
  const commentDraft = draft.comment
  const editDraft = draft.edit
  const editing = editDraft !== null
  // A first create has no prior document, so its empty transport baseline is not a meaningful diff.
  const isInitialCreateReview =
    pendingTaskConfirm?.operation !== 'edit' && taskDiffBaseline === ''
  const hasReviewDiff =
    pendingTaskConfirm !== null &&
    taskDiffBaseline !== null &&
    brief !== null &&
    !isInitialCreateReview &&
    taskDiffBaseline.replace(/\r\n/g, '\n') !== brief.replace(/\r\n/g, '\n')
  const [reviewView, setReviewView] = useState<'diff' | 'document'>(hasReviewDiff ? 'diff' : 'document')
  const reviewViewRequest = useRef<string | null>(null)

  useEffect(() => {
    if (!pendingTaskConfirm || reviewViewRequest.current === pendingTaskConfirm.requestId) {
      return
    }
    reviewViewRequest.current = pendingTaskConfirm.requestId
    setSelection(null)
    setReviewView(hasReviewDiff ? 'diff' : 'document')
  }, [hasReviewDiff, pendingTaskConfirm])

  // Selection detection: deferred until the browser has settled the selection before reading it (event handling, not derived state, §1.17).
  // No selection handling in edit mode.
  const handleMouseUp = () => {
    if (editing || archived || editBaselinePreview) return
    window.setTimeout(() => {
      const sel = window.getSelection()
      const host = bodyRef.current
      if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !host) {
        setSelection(null)
        return
      }
      const range = sel.getRangeAt(0)
      if (
        !host.contains(sel.anchorNode) ||
        !host.contains(sel.focusNode) ||
        !host.contains(range.commonAncestorContainer)
      ) {
        setSelection(null)
        return
      }
      const text = hasReviewDiff && reviewView === 'diff'
        ? Array.from(host.querySelectorAll<HTMLElement>('[data-diff-value]'))
            .filter((value) => range.intersectsNode(value))
            .map((value) => {
              const valueRange = document.createRange()
              valueRange.selectNodeContents(value)
              if (value.contains(range.startContainer)) {
                valueRange.setStart(range.startContainer, range.startOffset)
              }
              if (value.contains(range.endContainer)) {
                valueRange.setEnd(range.endContainer, range.endOffset)
              }
              return valueRange.toString()
            })
            .join('\n')
            .trim()
        : sel.toString().trim()
      if (!text) {
        setSelection(null)
        return
      }
      const rect = range.getBoundingClientRect()
      const hostRect = host.getBoundingClientRect()
      setSelection({
        sessionId,
        text,
        top: rect.bottom - hostRect.top + host.scrollTop + 8,
        left: Math.min(rect.left - hostRect.left, host.clientWidth - 120),
      })
    }, 0)
  }

  const beginComment = () => {
    if (!selection) return
    setCommentDraft({ quote: selection.text, text: '' })
    setSelection(null)
  }

  // addPendingCommentAtom closes the composer draft itself, so staging and "the box is
  // empty again" cannot come apart.
  const handleAdd = (text: string) => {
    if (commentDraft === null) return
    addComment({ quote: commentDraft.quote, text })
  }

  const beginEdit = () => {
    setEditDraft(brief ?? '')
    setSelection(null)
    setCommentDraft(null)
  }

  const saveEdit = async () => {
    if (editDraft === null) return
    // Content unchanged: no need to write to disk or notify, just leave edit mode.
    if (editDraft === (brief ?? '')) {
      setEditDraft(null)
      return
    }
    // On success saveSpecEditAtom leaves edit mode itself, keyed by the session captured
    // before its await — clearing it from here would target whatever session is active
    // when the write resolves.
    const result = await saveSpecEdit(editDraft)
    if (result === SaveSpecResult.Saved) {
      showToast(t('specPreview.toast.saved'))
    } else if (result === SaveSpecResult.NotReady) {
      showToast(t('specPreview.toast.notReady'))
    } else if (result === SaveSpecResult.WriteFailed) {
      showToast(t('specPreview.toast.saveFailed'))
    } else {
      showToast(t('specPreview.toast.sessionNotReady'))
    }
  }

  let footer: JSX.Element | null = null
  if (!editing && commentDraft !== null) {
    footer = (
      <CommentComposer
        quote={commentDraft.quote}
        text={commentDraft.text}
        onChange={(text) => setCommentDraft({ quote: commentDraft.quote, text })}
        onAdd={handleAdd}
        onCancel={() => setCommentDraft(null)}
      />
    )
  } else if (
    !editing &&
    !archived &&
    !editBaselinePreview &&
    pendingTaskConfirm
  ) {
    footer = (
      <div className="shrink-0 border-t border-border-subtle bg-bg-surface px-4 py-3">
        <TaskReviewActions block={pendingTaskConfirm} sessionId={sessionId ?? undefined} />
      </div>
    )
  }

  let statusBadge: JSX.Element | null = null
  if (archived) {
    statusBadge = (
      <span className="rounded-full bg-status-success-bg px-2 py-0.5 text-xs font-semibold text-status-success shrink-0">
        {t('specPreview.badge.saved')}
      </span>
    )
  } else if (editBaselinePreview) {
    statusBadge = (
      <span className="rounded-full bg-bg-hover px-2 py-0.5 text-xs font-semibold text-text-secondary shrink-0">
        {t('specPreview.badge.original')}
      </span>
    )
  } else if (pendingTaskConfirm) {
    statusBadge = (
      <span className="rounded-full bg-accent-blue-subtle px-2 py-0.5 text-xs font-semibold text-brand-blue shrink-0">
        {t('specPreview.badge.awaitingConfirmation')}
      </span>
    )
  }

  let editControls: JSX.Element | null = null
  if (editing) {
    editControls = (
      <>
        <button
          type="button"
          onClick={() => setEditDraft(null)}
          className="h-7 px-2.5 rounded-md text-xs font-semibold text-text-secondary bg-bg-hover shrink-0"
        >
          {t('specPreview.cancel')}
        </button>
        <button
          type="button"
          onClick={() => void saveEdit()}
          className="flex items-center gap-1 h-7 px-2.5 rounded-md text-xs font-semibold bg-brand-blue text-white shrink-0"
        >
          {Icons.check(13)} {t('specPreview.save')}
        </button>
      </>
    )
  } else if (!archived && !editBaselinePreview) {
    editControls = (
      <Tooltip content={t('specPreview.editSource')}>
        <button
          type="button"
          onClick={beginEdit}
          className="flex items-center justify-center w-7 h-7 rounded-md text-text-tertiary hover:bg-bg-hover hover:text-brand-blue"
        >
          {Icons.edit(14)}
        </button>
      </Tooltip>
    )
  }

  let instruction: JSX.Element
  if (archived) {
    instruction = <>{Icons.check(13)} {t('specPreview.instructions.archived')}</>
  } else if (editBaselinePreview) {
    instruction = <>{Icons.file(13)} {t('specPreview.instructions.original')}</>
  } else if (editing) {
    instruction = <>{Icons.edit(13)} {t('specPreview.instructions.editing')}</>
  } else if (hasReviewDiff && reviewView === 'diff') {
    instruction = <>{Icons.edit(13)} {t('specPreview.instructions.diff')}</>
  } else {
    instruction = <>{Icons.chat(13)} {t('specPreview.instructions.comment')}</>
  }

  let previewContent: JSX.Element
  if (editBaselinePreview && originalBrief !== null) {
    previewContent = <MarkdownMessage content={originalBrief} />
  } else if (hasReviewDiff && reviewView === 'diff' && brief !== null) {
    previewContent = <TaskMarkdownDiff before={taskDiffBaseline ?? ''} after={brief} />
  } else if (brief !== null) {
    previewContent = <MarkdownMessage content={brief} />
  } else {
    previewContent = <div className="text-sm text-text-tertiary text-center py-10">{t('specPreview.empty')}</div>
  }

  return (
    <div className="flex flex-col h-full bg-bg-surface animate-fade">
      <div
        data-testid="spec-preview-header"
        className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4"
        style={{ height: SESSION_STATUS_BAR_HEIGHT_PX }}
      >
        <span className="text-brand-blue flex shrink-0">{Icons.file(15)}</span>
        <span className="flex-1 min-w-0 truncate text-sm font-semibold text-text-primary">
          {editBaselinePreview ? t('specPreview.originalFileName') : t('specPreview.fileName')}
        </span>
        {statusBadge}
        {pendingCount > 0 ? (
          <span className="px-2 py-0.5 rounded-full bg-accent-blue-subtle text-brand-blue text-xs font-semibold shrink-0">
            {t('specPreview.pendingCount', { count: pendingCount })}
          </span>
        ) : null}
        {hasReviewDiff && !editing && !editBaselinePreview ? (
          <div className="flex h-7 items-center rounded-md bg-bg-hover p-0.5">
            <button
              type="button"
              onClick={() => {
                setSelection(null)
                setReviewView('diff')
              }}
              className={cn(
                'h-6 rounded px-2 text-[11px] font-semibold',
                reviewView === 'diff' ? 'bg-bg-surface text-brand-blue shadow-sm' : 'text-text-tertiary',
              )}
            >
              {t('specPreview.diff')}
            </button>
            <button
              type="button"
              onClick={() => {
                setSelection(null)
                setReviewView('document')
              }}
              className={cn(
                'h-6 rounded px-2 text-[11px] font-semibold',
                reviewView === 'document' ? 'bg-bg-surface text-brand-blue shadow-sm' : 'text-text-tertiary',
              )}
            >
              {t('specPreview.latest')}
            </button>
          </div>
        ) : null}
        {editControls}
      </div>

      <div
        className={cn(
          'flex items-center gap-1.5 px-4 py-2 border-b border-border-subtle text-xs',
          archived ? 'bg-status-success-bg text-status-success' : 'bg-accent-blue-subtle text-brand-blue',
        )}
      >
        {instruction}
      </div>

      {editDraft !== null ? (
        <div className="flex-1 overflow-hidden p-3">
          <textarea
            value={editDraft}
            onChange={(e) => setEditDraft(e.target.value)}
            autoFocus
            className="w-full h-full resize-none px-4 py-3 rounded-md border border-border-default bg-bg-input text-text-primary text-sm font-mono leading-relaxed outline-none"
          />
        </div>
      ) : (
        <div ref={bodyRef} onMouseUp={handleMouseUp} className="relative flex-1 overflow-auto px-5 py-4">
          {previewContent}

          {selection && commentDraft === null ? (
            <div className="absolute z-30 animate-pop" style={{ top: selection.top, left: selection.left }}>
              <button
                type="button"
                aria-label={t('specPreview.commentSelectionAria')}
                onClick={beginComment}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-blue text-white text-xs font-semibold shadow-md whitespace-nowrap"
              >
                {Icons.chat(13)} {t('specPreview.comment')}
              </button>
            </div>
          ) : null}
        </div>
      )}

      {footer}
    </div>
  )
}

/** Line diff of the spec. Memoized on (before, after): the pane now re-renders on every
 *  keystroke in the comment box (the draft is session state, read by the pane), and without
 *  this the whole diff — hundreds of rows on a long spec — would reconcile per character. */
const TaskMarkdownDiff = memo(function TaskMarkdownDiff({ before, after }: { before: string; after: string }) {
  const { t } = useTranslation()
  const lines = useMemo(() => {
    const oldLines = before === '' ? [] : before.split(/\r?\n/)
    const newLines = after === '' ? [] : after.split(/\r?\n/)
    const maxMatrixLines = 600
    const result: DiffLine[] = []

    const orderChangedBlocks = (diffLines: DiffLine[]) => {
      const ordered: DiffLine[] = []
      const removed: DiffLine[] = []
      const added: DiffLine[] = []
      const flushChanges = () => {
        ordered.push(...removed, ...added)
        removed.length = 0
        added.length = 0
      }
      for (const line of diffLines) {
        if (line.kind === 'same') {
          flushChanges()
          ordered.push(line)
        } else if (line.kind === 'removed') {
          removed.push(line)
        } else {
          added.push(line)
        }
      }
      flushChanges()
      return ordered
    }

    if (oldLines.length > maxMatrixLines || newLines.length > maxMatrixLines) {
      oldLines.forEach((value, index) => result.push({ kind: 'removed', value, oldLine: index + 1 }))
      newLines.forEach((value, index) => result.push({ kind: 'added', value, newLine: index + 1 }))
      return orderChangedBlocks(result)
    }

    const lengths = Array.from({ length: oldLines.length + 1 }, () =>
      new Uint16Array(newLines.length + 1),
    )
    for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
      for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
        lengths[oldIndex]![newIndex] = oldLines[oldIndex] === newLines[newIndex]
          ? lengths[oldIndex + 1]![newIndex + 1]! + 1
          : Math.max(lengths[oldIndex + 1]![newIndex]!, lengths[oldIndex]![newIndex + 1]!)
      }
    }

    let oldIndex = 0
    let newIndex = 0
    while (oldIndex < oldLines.length || newIndex < newLines.length) {
      if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
        result.push({ kind: 'same', value: oldLines[oldIndex]!, oldLine: oldIndex + 1, newLine: newIndex + 1 })
        oldIndex += 1
        newIndex += 1
      } else if (
        newIndex < newLines.length &&
        (oldIndex === oldLines.length || lengths[oldIndex]![newIndex + 1]! >= lengths[oldIndex + 1]![newIndex]!)
      ) {
        result.push({ kind: 'added', value: newLines[newIndex]!, newLine: newIndex + 1 })
        newIndex += 1
      } else {
        result.push({ kind: 'removed', value: oldLines[oldIndex]!, oldLine: oldIndex + 1 })
        oldIndex += 1
      }
    }
    return orderChangedBlocks(result)
  }, [after, before])

  const changed = lines.some((line) => line.kind !== 'same')

  return (
    <>
      {!changed ? (
        <div className="select-none rounded-md border border-border-subtle bg-bg-hover px-4 py-8 text-center text-sm text-text-tertiary">
          {t('specPreview.noChanges')}
        </div>
      ) : null}
      {lines.length > 0 ? (
        <div
          className={cn(
            'overflow-hidden rounded-md border border-border-subtle bg-bg-input font-mono text-xs leading-5',
            !changed && 'mt-3',
          )}
        >
          {lines.map((line, index) => {
            let marker = ' '
            if (line.kind === 'added') marker = '+'
            else if (line.kind === 'removed') marker = '−'
            return (
              <div
                key={`${line.kind}:${line.oldLine ?? '-'}:${line.newLine ?? '-'}:${index}`}
                data-kind={line.kind}
                className={cn(
                  'grid grid-cols-[38px_38px_20px_minmax(0,1fr)]',
                  line.kind === 'added' && 'bg-status-success-bg',
                  line.kind === 'removed' && 'bg-status-error-bg',
                )}
              >
                <span className="select-none border-r border-border-subtle px-1.5 text-right text-text-tertiary">
                  {line.oldLine ?? ''}
                </span>
                <span className="select-none border-r border-border-subtle px-1.5 text-right text-text-tertiary">
                  {line.newLine ?? ''}
                </span>
                <span
                  className={cn(
                    'select-none text-center',
                    line.kind === 'added' && 'text-status-success',
                    line.kind === 'removed' && 'text-status-error',
                    line.kind === 'same' && 'text-text-tertiary',
                  )}
                >
                  {marker}
                </span>
                <span data-diff-value className="min-w-0 whitespace-pre-wrap break-words pr-3 text-text-primary">
                  {line.value || ' '}
                </span>
              </div>
            )
          })}
        </div>
      ) : null}
    </>
  )
})

interface CommentComposerProps {
  /** The selected source text being commented on (shown as a quote). */
  quote: string
  /** Current draft text. Controlled by the parent (session-scoped, survives unmount). */
  text: string
  /** Emitted on every keystroke. */
  onChange: (text: string) => void
  /** "Add" callback; text is already trimmed and non-empty. */
  onAdd: (text: string) => void
  /** Cancel editing and discard the draft. */
  onCancel: () => void
}

/** Comment editor docked at the bottom: quote + text box + "add". ⌘↵ submits.
 *  Fully controlled — holding the text locally would lose it on every session switch
 *  (the whole pane unmounts), which is exactly the bug this shape avoids. */
function CommentComposer({ quote, text: draft, onChange, onAdd, onCancel }: CommentComposerProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [quoteExpanded, setQuoteExpanded] = useState(false)
  const [quoteRef, quoteClamped] = useIsClamped(quote, quoteExpanded)
  const canAdd = draft.trim().length > 0
  // Focus on mount instead of `autoFocus`, so the caret can be placed **after** a restored
  // draft. `autoFocus` is a plain `.focus()`, which Chromium answers with caret at offset 0 —
  // coming back to a half-written comment, the next keystroke would land in front of it.
  // Deliberately not an onFocus handler: that also fires when the user clicks into the middle
  // of the text, and would yank the caret to the end every time.
  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus()
    input.setSelectionRange(input.value.length, input.value.length)
  }, [])
  // Send / newline / IME behaviour matches the session input box — it reads the same inputSendKey setting.
  const sendKey = useAtomValue(settingsAtom).composer.inputSendKey
  const sendHint = sendKey === 'enter' ? '↵' : '⌘↵'
  return (
    <div className="shrink-0 border-t border-border-default bg-bg-surface px-3.5 py-3 animate-enter">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="flex items-center gap-1 text-xs font-semibold text-brand-blue">
          {Icons.chat(12)} {t('specPreview.commentSelection')}
        </span>
        <span className="flex-1" />
        <button
          type="button"
          onClick={onCancel}
          className="text-xs text-text-tertiary hover:text-text-primary"
        >
          {t('specPreview.cancel')}
        </button>
      </div>
      <div className="mb-2 px-2.5 py-1.5 border-l-[3px] border-brand-blue bg-bg-hover rounded-r-md">
        <div
          ref={quoteRef}
          className={cn('text-xs text-text-secondary leading-snug', !quoteExpanded && 'line-clamp-2')}
        >
          “{quote}”
        </div>
        {quoteClamped && (
          <button
            type="button"
            onClick={() => setQuoteExpanded((v) => !v)}
            className="mt-1 text-[10px] font-semibold text-brand-blue hover:underline"
          >
            {quoteExpanded ? t('specPreview.collapse') : t('specPreview.expandAll')}
          </button>
        )}
      </div>
      <div className="flex items-end gap-2">
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          placeholder={t('specPreview.commentPlaceholder')}
          onKeyDown={(e) => {
            // Esc only cancels editing this one comment; stopPropagation prevents it from bubbling to
            // CommentFeedbackPanel's global Esc listener — which would otherwise wipe the whole batch of queued comments (destroying what the user had accumulated).
            if (e.key === 'Escape') {
              e.stopPropagation()
              onCancel()
              return
            }
            if (resolveSendKeyAction(e, sendKey) === 'send') {
              e.preventDefault()
              if (canAdd) onAdd(draft.trim())
            }
            // 'newline' / 'ignore' → do not intercept; leave it to the textarea's native newline / the IME.
          }}
          className="flex-1 resize-none px-2.5 py-2 rounded-md border border-border-default bg-bg-input text-sm text-text-primary leading-snug outline-none"
        />
        <Tooltip content={t('specPreview.addCommentTooltip', { shortcut: sendHint })}>
          <button
            type="button"
            onClick={() => canAdd && onAdd(draft.trim())}
            disabled={!canAdd}
            className={cn(
              'flex items-center gap-1 h-[34px] px-3 rounded-md text-xs font-semibold shrink-0',
              canAdd ? 'bg-brand-blue text-white' : 'bg-bg-hover text-text-tertiary',
            )}
          >
            {Icons.plus(14)} {t('specPreview.add')}
          </button>
        </Tooltip>
      </div>
    </div>
  )
}
