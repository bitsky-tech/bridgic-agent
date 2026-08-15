import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { MessageBlock } from '@/atoms/agent'
import {
  currentBriefAtom,
  openSpecPreviewAtom,
  pendingCommentsAtom,
  respondTaskConfirmAtom,
} from '@/atoms/build'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { Icons } from './Icons'
import { Badge } from './Primitives'

export type TaskConfirmBlock = Extract<MessageBlock, { type: 'task_confirm' }>

export function TaskConfirmCard({
  block,
  sessionId,
  floating = false,
}: {
  block: TaskConfirmBlock
  sessionId?: string
  floating?: boolean
}) {
  const { t } = useTranslation()
  const openPreview = useSetAtom(openSpecPreviewAtom)
  // Do not expose the preview entry point when there is no spec content: the preview panel does not open at all when brief===null
  // (see the gate in specPreviewOpenAtom), and leaving a button that does nothing when clicked is more confusing. The pending
  // state always has taskMarkdown (guaranteed by currentBriefAtom), so !hasBrief implies !pending — at which point both the
  // preview button and TaskReviewActions are empty, so the whole footer row is hidden and no empty divider line is left behind.
  const hasBrief = useAtomValue(currentBriefAtom) !== null
  const status = block.status ?? 'pending'
  const pending = status === 'pending'

  let badgeColor: 'brand' | 'success' | 'warning' = 'brand'
  let badgeIcon = Icons.file(12)
  let badgeLabel = t('workflow.task.status.pending')
  if (status === 'confirmed') {
    badgeColor = 'success'
    badgeIcon = Icons.check(12)
    badgeLabel = t('workflow.task.status.confirmed')
  } else if (status === 'revision_requested') {
    badgeColor = 'warning'
    badgeIcon = Icons.edit(12)
    badgeLabel = t('workflow.task.status.revising')
  }
  let description = t('workflow.task.desc.revisionSubmitted')
  if (pending) {
    description = t('workflow.task.desc.pending')
  } else if (status === 'confirmed') {
    description = t('workflow.task.desc.confirmed')
  }

  return (
    <div className={floating ? 'w-full' : 'max-w-xl rounded-lg border border-border-subtle bg-bg-elevated p-3.5 shadow-sm'}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-blue-subtle text-brand-blue">
            {Icons.file(16)}
          </span>
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-text-primary">{t('workflow.task.title')}</div>
            <div className="mt-0.5 text-xs text-text-tertiary">task.md</div>
          </div>
        </div>
        <Badge color={badgeColor}>
          <span className="inline-flex items-center gap-1">{badgeIcon}{badgeLabel}</span>
        </Badge>
      </div>

      <div className="mt-2.5 text-sm leading-6 text-text-secondary">
        {description}
      </div>

      {hasBrief && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
          <button
            type="button"
            onClick={() => openPreview()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-xs font-semibold text-brand-blue hover:bg-bg-hover"
          >
            {Icons.eye(14)} {t('workflow.task.preview')}
          </button>
          <span className="flex-1" />
          <TaskReviewActions block={block} sessionId={sessionId} />
        </div>
      )}

      {!pending && status === 'revision_requested' && block.feedback && (
        <div className="mt-3 border-l-2 border-status-warning pl-2.5 text-sm leading-6 text-text-secondary">
          {t('workflow.task.feedbackLabel', { feedback: block.feedback })}
        </div>
      )}
    </div>
  )
}

/** Shared task-review controls used by the compact card and full preview. */
export function TaskReviewActions({ block, sessionId }: { block: TaskConfirmBlock; sessionId?: string }) {
  const { t } = useTranslation()
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const pendingComments = useAtomValue(pendingCommentsAtom).length
  const respond = useSetAtom(respondTaskConfirmAtom)
  const targetSessionId = sessionId ?? activeSessionId
  const [commenting, setCommenting] = useState(false)
  const [feedback, setFeedback] = useState('')
  const [busy, setBusy] = useState<'confirm' | 'revise' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const pending = (block.status ?? 'pending') === 'pending'

  async function submit(action: 'confirm' | 'revise') {
    if (!targetSessionId || busy || (action === 'revise' && !feedback.trim())) return
    setBusy(action)
    setError(null)
    try {
      await respond({
        sessionId: targetSessionId,
        requestId: block.requestId,
        action,
        feedback: action === 'revise' ? feedback.trim() : undefined,
      })
      setCommenting(false)
      setFeedback('')
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('workflow.common.actionFailed'))
    } finally {
      setBusy(null)
    }
  }

  if (!pending) return null

  if (commenting) {
    return (
      <div className="w-full">
        <textarea
          value={feedback}
          onChange={(event) => setFeedback(event.target.value)}
          disabled={busy !== null}
          rows={2}
          autoFocus
          placeholder={t('workflow.task.commentPlaceholder')}
          className="w-full resize-none rounded-md border border-border-subtle bg-bg-input px-3 py-2 text-sm text-text-primary outline-none focus:border-brand-blue disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => setCommenting(false)}
            className="h-8 rounded-md px-2.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            {t('workflow.common.cancel')}
          </button>
          <button
            type="button"
            disabled={busy !== null || !feedback.trim()}
            onClick={() => void submit('revise')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-blue px-3 text-xs font-semibold text-white disabled:opacity-50"
          >
            {Icons.send(13)} {busy === 'revise' ? t('workflow.task.submitting') : t('workflow.task.submitComment')}
          </button>
        </div>
        {error && <div className="mt-2 text-xs text-status-error">{error}</div>}
      </div>
    )
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {pendingComments > 0 && (
        <span className="text-xs text-status-warning">{t('workflow.task.pendingComments', { n: pendingComments })}</span>
      )}
      <button
        type="button"
        disabled={busy !== null || pendingComments > 0}
        onClick={() => setCommenting(true)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold text-text-secondary hover:bg-bg-hover disabled:opacity-50"
      >
        {Icons.chat(13)} {t('workflow.task.comment')}
      </button>
      <button
        type="button"
        disabled={busy !== null || pendingComments > 0}
        onClick={() => void submit('confirm')}
        className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[image:var(--brand-gradient)] px-3 text-xs font-semibold text-text-on-brand disabled:opacity-50"
      >
        {Icons.check(13)} {busy === 'confirm' ? t('workflow.task.confirming') : t('workflow.common.confirm')}
      </button>
      {error && <div className="w-full text-right text-xs text-status-error">{error}</div>}
    </div>
  )
}
