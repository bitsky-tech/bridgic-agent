import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { MessageBlock } from '@/atoms/agent'
import { thinkingModeFamily } from '@/atoms/agent'
import {
  presentationPaneViewFamily,
  respondPresentationOutlineAtom,
} from '@/atoms/presentation-plan'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'

export type PresentationOutlineConfirmBlock = Extract<
  MessageBlock,
  { type: 'presentation_outline_confirm' }
>

export function PresentationOutlineConfirmCard({ block, sessionId, floating = false }: {
  block: PresentationOutlineConfirmBlock
  sessionId?: string
  floating?: boolean
}) {
  const { t } = useTranslation()
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const targetSessionId = sessionId ?? activeSessionId ?? ''
  const position = useAtomValue(thinkingModeFamily(targetSessionId))
  const openPane = useSetAtom(presentationPaneViewFamily(targetSessionId))
  const respond = useSetAtom(respondPresentationOutlineAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = block.status ?? 'pending'
  const chapters = position?.mode === 'presentation' ? position.presentationOutline ?? [] : []
  const slideCount = chapters.reduce((total, chapter) => total + chapter.slides.length, 0)
  const pending = status === 'pending'

  const confirm = async () => {
    if (!targetSessionId || chapters.length === 0 || slideCount === 0 || busy) return
    setBusy(true)
    setError(null)
    try {
      await respond({
        sessionId: targetSessionId,
        requestId: block.requestId,
        chapters,
      })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('workflow.common.actionFailed'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={cn(
        floating ? 'w-full' : 'max-w-xl rounded-lg border border-border-subtle bg-bg-elevated p-3.5 shadow-sm',
      )}
      data-testid="presentation-outline-confirm-card"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-blue-subtle text-text-accent">
          {Icons.presentation(17)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('presentationMode.outline.confirmCardTitle')}
            </h3>
            {!pending && (
              <span className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-2xs font-semibold',
                status === 'confirmed'
                  ? 'bg-status-success-bg text-status-success'
                  : 'bg-status-warning-bg text-status-warning',
              )}>
                {status === 'confirmed' ? Icons.check(11) : Icons.edit(11)}
                {t(status === 'confirmed'
                  ? 'presentationMode.outline.confirmed'
                  : 'presentationMode.outline.revising')}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {t(pending
              ? 'presentationMode.outline.confirmCardDescription'
              : 'presentationMode.outline.confirmCardDone')}
          </p>
          {chapters.length > 0 && (
            <p className="mt-1 text-2xs text-text-tertiary">
              {t('presentationMode.outline.summary', { chapters: chapters.length, slides: slideCount })}
            </p>
          )}
        </div>
      </div>

      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
          <button
            type="button"
            onClick={() => openPane('outline')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-xs font-semibold text-text-accent hover:bg-bg-hover"
          >
            {Icons.eye(14)} {t('presentationMode.outline.openEditor')}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy || chapters.length === 0 || slideCount === 0}
            onClick={() => void confirm()}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[image:var(--brand-gradient)] px-3 text-xs font-semibold text-text-on-brand disabled:opacity-50"
          >
            {Icons.check(13)} {busy
              ? t('presentationMode.outline.confirming')
              : t('presentationMode.outline.confirmDirectly')}
          </button>
        </div>
      )}
      {status === 'revision_requested' && block.feedback && (
        <div className="mt-3 border-l-2 border-status-warning pl-2.5 text-sm leading-6 text-text-secondary">
          {block.feedback}
        </div>
      )}
      {error && <div className="mt-2 text-xs text-status-error">{error}</div>}
    </div>
  )
}
