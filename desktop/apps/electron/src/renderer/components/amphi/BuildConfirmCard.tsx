import { useState } from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useTranslation } from 'react-i18next'
import type { MessageBlock } from '@/atoms/agent'
import { respondBuildConfirmAtom } from '@/atoms/build'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { MarkdownMessage } from '@/components/markdown/MarkdownMessage'
import { Icons } from './Icons'

type BuildConfirmBlock = Extract<MessageBlock, { type: 'build_confirm' }>

/** Main's proposal to turn the current request into a reusable Workflow. */
export function BuildConfirmCard({
  block,
  sessionId,
  floating = false,
}: {
  block: BuildConfirmBlock
  sessionId?: string
  floating?: boolean
}) {
  const { t } = useTranslation()
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const respond = useSetAtom(respondBuildConfirmAtom)
  const [busy, setBusy] = useState<'confirm' | 'cancel' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const targetSessionId = sessionId ?? activeSessionId
  const pending = (block.status ?? 'pending') === 'pending'

  async function submit(action: 'confirm' | 'cancel') {
    if (!targetSessionId || busy) return
    setBusy(action)
    setError(null)
    try {
      await respond({ sessionId: targetSessionId, requestId: block.requestId, action })
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t('workflow.common.actionFailed'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={floating ? 'w-full' : 'max-w-xl rounded-lg border border-border-subtle bg-bg-elevated p-4 shadow-sm'}>
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-accent-purple-subtle text-brand-purple">
          {Icons.workflow(17)}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-text-primary">{t('workflow.build.title')}</div>
          <div className="mt-1 text-sm leading-6 text-text-secondary">
            {t('workflow.build.desc')}
          </div>
        </div>
      </div>

      <div className="mt-3 border-l-2 border-brand-purple pl-3">
        <div className="text-xs font-medium text-text-tertiary">{t('workflow.build.ready')}</div>
        <MarkdownMessage content={block.goal} density="compact" className="mt-1 text-sm leading-6 text-text-primary" />
        {block.reason && (
          <MarkdownMessage content={block.reason} density="compact" className="mt-1 text-xs leading-5 text-text-tertiary" />
        )}
      </div>

      {pending && (
        <div className="mt-4 flex items-center justify-end gap-2 border-t border-border-subtle pt-3">
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void submit('cancel')}
            className="h-9 rounded-md px-3 text-sm font-medium text-text-secondary hover:bg-bg-hover disabled:opacity-50"
          >
            {busy === 'cancel' ? t('workflow.build.processing') : t('workflow.build.runOnce')}
          </button>
          <button
            type="button"
            disabled={busy !== null}
            onClick={() => void submit('confirm')}
            className="inline-flex h-9 items-center gap-1.5 rounded-md bg-[image:var(--brand-gradient)] px-3.5 text-sm font-semibold text-text-on-brand disabled:opacity-50"
          >
            {Icons.check(14)} {busy === 'confirm' ? t('workflow.build.entering') : t('workflow.build.start')}
          </button>
        </div>
      )}
      {error && <div role="alert" className="mt-2 text-right text-xs text-status-error">{error}</div>}
    </div>
  )
}
