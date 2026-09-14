import { useState } from 'react'
import { useAtom, useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { MessageBlock } from '@/atoms/agent'
import { thinkingModeFamily } from '@/atoms/agent'
import {
  presentationPaneViewFamily,
  presentationTemplateSelectionFamily,
  respondPresentationTemplateAtom,
} from '@/atoms/presentation-plan'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { cn } from '@/lib/cn'
import { Icons } from './Icons'

export type PresentationTemplateSelectionBlock = Extract<
  MessageBlock,
  { type: 'presentation_template_selection' }
>

export function PresentationTemplateSelectionCard({ block, sessionId, floating = false }: {
  block: PresentationTemplateSelectionBlock
  sessionId?: string
  floating?: boolean
}) {
  const { t } = useTranslation()
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const targetSessionId = sessionId ?? activeSessionId ?? ''
  const position = useAtomValue(thinkingModeFamily(targetSessionId))
  const openPane = useSetAtom(presentationPaneViewFamily(targetSessionId))
  const respond = useSetAtom(respondPresentationTemplateAtom)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const status = block.status ?? 'pending'
  const pending = status === 'pending'
  const [selectedId, setSelectedId] = useAtom(
    presentationTemplateSelectionFamily(pending ? block.requestId : ''),
  )
  const liveCandidates = position?.mode === 'presentation'
    && position.presentationTemplateSelectionId === block.requestId
    ? position.presentationTemplateCandidates ?? []
    : []
  const candidates = liveCandidates.length > 0 ? liveCandidates : block.candidates ?? []
  const retrievalError = position?.mode === 'presentation'
    && position.presentationTemplateSelectionId === block.requestId
    ? position.presentationTemplateSelectionError ?? null
    : null
  const currentSelectedTemplate = status === 'selected'
    ? position?.presentationSelectedTemplate ?? null
    : null
  const resolvedSelectedId = selectedId
    ?? block.selectedTemplateId
    ?? currentSelectedTemplate?.templateId
    ?? null
  const selected = candidates.find(candidate => candidate.templateId === resolvedSelectedId)
    ?? (currentSelectedTemplate?.templateId === resolvedSelectedId
      ? currentSelectedTemplate
      : null)
  let statusTone = 'bg-status-warning-bg text-status-warning'
  if (status === 'selected') statusTone = 'bg-status-success-bg text-status-success'
  else if (status === 'skipped') statusTone = 'bg-bg-subtle text-text-secondary'

  const answer = async (action: 'select' | 'skip' | 'refresh') => {
    if (!targetSessionId || busy || (action === 'select' && !resolvedSelectedId)) return
    setBusy(true)
    setError(null)
    try {
      await respond({
        sessionId: targetSessionId,
        requestId: block.requestId,
        action,
        ...(action === 'select' && resolvedSelectedId ? { templateId: resolvedSelectedId } : {}),
      })
      if (action !== 'select') setSelectedId(null)
      openPane('progress')
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
      data-testid="presentation-template-selection-card"
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-accent-blue-subtle text-text-accent">
          {Icons.presentation(17)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('presentationMode.templates.confirmCardTitle')}
            </h3>
            {!pending && (
              <span className={cn(
                'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-1 text-2xs font-semibold',
                statusTone,
              )}>
                {status === 'selected' ? Icons.check(11) : Icons.edit(11)}
                {t(`presentationMode.templates.status.${status}`)}
              </span>
            )}
          </div>
          <p className="mt-1 text-xs leading-5 text-text-secondary">
            {pending
              ? t(candidates.length > 0
                  ? 'presentationMode.templates.confirmCardDescription'
                  : 'presentationMode.templates.confirmCardUnavailable', { count: candidates.length })
              : t('presentationMode.templates.confirmCardDone')}
          </p>
          {pending && retrievalError && (
            <p className="mt-1.5 text-2xs leading-4 text-status-warning" data-testid="presentation-template-error">
              {retrievalError}
            </p>
          )}
          {(selected || resolvedSelectedId) && (
            <div className="mt-2 rounded-lg bg-bg-subtle px-2.5 py-2">
              <p className="truncate text-xs font-semibold text-text-primary">
                {selected?.title ?? resolvedSelectedId}
              </p>
              {selected?.agenticReason && (
                <p className="mt-0.5 line-clamp-2 text-2xs leading-4 text-text-tertiary">
                  {selected.agenticReason}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {pending && (
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border-subtle pt-3">
          <button
            type="button"
            onClick={() => openPane('templates')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border-subtle px-2.5 text-xs font-semibold text-text-accent hover:bg-bg-hover"
          >
            {Icons.eye(14)} {t('presentationMode.templates.openGallery')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer('refresh')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            {Icons.refresh(13)} {t(candidates.length > 0
              ? 'presentationMode.templates.refresh'
              : 'presentationMode.templates.retry')}
          </button>
          <span className="flex-1" />
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer('skip')}
            className="inline-flex h-8 items-center rounded-md px-2.5 text-xs font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            {t('presentationMode.templates.skip')}
          </button>
          <button
            type="button"
            disabled={busy || !resolvedSelectedId}
            onClick={() => void answer('select')}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[image:var(--brand-gradient)] px-3 text-xs font-semibold text-text-on-brand disabled:opacity-50"
          >
            {Icons.check(13)} {busy
              ? t('presentationMode.templates.confirming')
              : t('presentationMode.templates.confirm')}
          </button>
        </div>
      )}
      {error && <div className="mt-2 text-xs text-status-error">{error}</div>}
    </div>
  )
}
