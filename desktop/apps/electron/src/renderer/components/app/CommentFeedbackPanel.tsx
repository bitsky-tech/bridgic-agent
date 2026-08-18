/**
 * Comment feedback panel — replaces the input box at the bottom of the center column when there are comments waiting to be sent (the switch is controlled by CenterView).
 *
 * It lists the staged comments one by one (each can be removed individually); "send feedback and continue building" merges them into a
 * single piece of feedback sent to the daemon (during task confirmation it goes through the structured revise path, otherwise through a
 * normal human turn). An optional free-form instruction ("just tell it what to do") can be attached — clicking the button carries it too
 * (fixing the prototype's bug of swallowing the instruction).
 * Esc / cancel only clears the staged comments; the preview stays open (design ⑤).
 *
 * The instruction text is session-scoped state (`SpecSessionDraft.instruction`), not local: this panel is unmounted
 * whenever the active session changes, so a locally held instruction was silently discarded on every switch.
 */
import { useEffect, useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import {
  clearPendingCommentsAtom,
  currentSpecDraftAtom,
  pendingCommentsAtom,
  removePendingCommentAtom,
  sendCommentBatchAtom,
  setSpecInstructionDraftAtom,
  type PendingComment,
} from '@/atoms/build'
import { settingsAtom } from '@/atoms/settings'
import { Icons } from '@/components/amphi/Icons'
import { Tooltip } from '@/components/amphi/Tooltip'
import { useIsClamped } from '@/hooks/useIsClamped'
import { cn } from '@/lib/cn'
import { resolveSendKeyAction } from '@/lib/sendKeyAction'

export function CommentFeedbackPanel() {
  const { t } = useTranslation()
  const pending = useAtomValue(pendingCommentsAtom)
  const remove = useSetAtom(removePendingCommentAtom)
  const send = useSetAtom(sendCommentBatchAtom)
  const clear = useSetAtom(clearPendingCommentsAtom)
  const instruction = useAtomValue(currentSpecDraftAtom).instruction
  const setInstruction = useSetAtom(setSpecInstructionDraftAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const n = pending.length
  // Send key / IME behaviour matches the session input box — it reads the same inputSendKey setting.
  const sendKey = useAtomValue(settingsAtom).composer.inputSendKey

  // Esc cancels the whole batch of feedback (the preview stays open). Subscribing to a DOM event = external-system sync (§1.17 compliant).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') clear()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clear])

  // Both clicking the button and pressing Enter carry the typed instruction (which may be empty) — fixing the prototype's bug where option ① swallowed the instruction.
  const handleSend = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await send(instruction.trim() || undefined)
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('commentFeedback.sendFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="rounded-2xl border-[1.5px] border-brand-purple bg-accent-purple-subtle shadow-md overflow-hidden animate-enter">
      {/* Header: title + cancel */}
      <div className="flex items-center gap-3 px-4 pt-3.5 pb-2.5">
        <div className="flex-1 text-md font-bold text-text-primary">{t('commentFeedback.title', { count: n })}</div>
        <Tooltip content={t('commentFeedback.cancelEsc')}>
          <button
            type="button"
            onClick={() => clear()}
            className="flex p-1 rounded-md text-text-tertiary hover:bg-bg-hover shrink-0"
          >
            {Icons.x(18)}
          </button>
        </Tooltip>
      </div>

      {/* Comment list: each one is its own card — top = the selected source text (de-emphasized reference), bottom = my comment (the main event). */}
      <div className="px-4 pb-3.5 flex flex-col gap-2.5 max-h-56 overflow-auto">
        {pending.map((p) => (
          <CommentItem key={p.id} comment={p} onRemove={() => remove(p.id)} />
        ))}
      </div>

      {/* The divider clearly separates the two areas: "the comments collected" and "the send action". */}
      <div className="border-t border-border-subtle px-4 pt-3.5 pb-4">
        <div className="text-md font-bold text-text-accent-purple mb-1">{t('commentFeedback.continueBuild')}</div>
        <div className="text-sm text-text-secondary mb-3">{t('commentFeedback.summary', { count: n })}</div>

        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={busy}
          className="w-full flex items-center justify-center px-3.5 py-3 rounded-md border border-border-default bg-bg-surface mb-2.5 hover:border-brand-purple disabled:opacity-50"
        >
          <span className="text-sm font-semibold text-text-primary">{busy ? t('commentFeedback.sending') : t('commentFeedback.sendAndContinue')}</span>
        </button>

        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={t('commentFeedback.instructionPlaceholder')}
          onKeyDown={(e) => {
            // A single-line input has no newline action: the send key sends, everything else is handed back to the native input / the IME.
            if (resolveSendKeyAction(e, sendKey) === 'send') {
              e.preventDefault()
              void handleSend()
            }
          }}
          disabled={busy}
          className="w-full box-border px-3.5 py-3 rounded-md border border-border-default bg-bg-input text-sm text-text-primary outline-none"
        />

        {error && <div className="mt-2 text-xs text-status-error">{error}</div>}
        <div className="mt-2.5 text-xs text-text-tertiary">{t('commentFeedback.escCancel')}</div>
      </div>
    </div>
  )
}

interface CommentItemProps {
  /** One staged comment (the selected source text + the user's comment). */
  comment: PendingComment
  /** Remove this one. */
  onRemove: () => void
}

/** One comment card: top = the selected source text (de-emphasized reference), bottom = my comment (the main event). When either part is
 *  too long, `useIsClamped` detects **actual overflow** before showing "expand / collapse" (the same convention as SkillConflictRow);
 *  each has its own expansion state, hence the child component (hooks cannot be called inside a map loop). */
function CommentItem({ comment, onRemove }: CommentItemProps) {
  const { t } = useTranslation()
  const [quoteExpanded, setQuoteExpanded] = useState(false)
  const [textExpanded, setTextExpanded] = useState(false)
  const [quoteRef, quoteClamped] = useIsClamped(comment.quote, quoteExpanded)
  const [textRef, textClamped] = useIsClamped(comment.text, textExpanded)

  return (
    <div className="group relative rounded-lg border border-border-subtle bg-bg-surface p-2.5 pr-8">
      {/* Selected source text — a reference, de-emphasized into a small grey box; expandable when very long. */}
      <div className="mb-2 rounded-md bg-bg-hover px-2 py-1.5">
        <div className="mb-0.5 text-2xs font-medium text-text-tertiary">{t('commentFeedback.selectedSource')}</div>
        <div
          ref={quoteRef}
          className={cn('text-xs italic leading-snug text-text-tertiary', !quoteExpanded && 'line-clamp-2')}
        >
          {comment.quote}
        </div>
        {quoteClamped && (
          <button
            type="button"
            onClick={() => setQuoteExpanded((v) => !v)}
            className="mt-1 text-2xs font-semibold text-text-accent-purple hover:underline"
          >
            {quoteExpanded ? t('commentFeedback.collapse') : t('commentFeedback.expandAll')}
          </button>
        )}
      </div>
      {/* My comment — the main event; expandable when very long. */}
      <div>
        <div className="mb-0.5 text-2xs font-semibold text-text-accent-purple">{t('commentFeedback.myComment')}</div>
        <div
          ref={textRef}
          className={cn('text-sm font-medium leading-snug text-text-primary', !textExpanded && 'line-clamp-3')}
        >
          {comment.text}
        </div>
        {textClamped && (
          <button
            type="button"
            onClick={() => setTextExpanded((v) => !v)}
            className="mt-1 text-2xs font-semibold text-text-accent-purple hover:underline"
          >
            {textExpanded ? t('commentFeedback.collapse') : t('commentFeedback.expandAll')}
          </button>
        )}
      </div>
      <Tooltip content={t('commentFeedback.remove')}>
        <button
          type="button"
          onClick={onRemove}
          className="absolute top-2 right-2 flex p-0.5 rounded text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-status-error transition-opacity"
        >
          {Icons.x(13)}
        </button>
      </Tooltip>
    </div>
  )
}
