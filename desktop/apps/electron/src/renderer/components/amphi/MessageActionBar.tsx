import { Check, Copy, Flag, Quote } from 'lucide-react'
import { useAtomValue, useSetAtom } from 'jotai'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { activeSessionIdAtom } from '@/atoms/sessions'
import { setComposerQuoteAtom } from '@/atoms/composer-quote'
import { showToastAtom } from '@/atoms/toast'
import { rlog } from '@/lib/logger'
import { Tooltip } from './Tooltip'

export interface MessageActionBarProps {
  role: 'ai' | 'user'
  text: string
  messageId?: string
  turnId?: string
  sessionId?: string
  onReport?: () => void
}

/** Compact message actions revealed when their message is hovered or focused. */
export function MessageActionBar({
  role,
  text,
  messageId,
  turnId,
  sessionId,
  onReport,
}: MessageActionBarProps) {
  const { t } = useTranslation()
  const activeSessionId = useAtomValue(activeSessionIdAtom)
  const setComposerQuote = useSetAtom(setComposerQuoteAtom)
  const showToast = useSetAtom(showToastAtom)
  const [copied, setCopied] = useState(false)
  const copyTimerRef = useRef<number | null>(null)
  const targetSessionId = sessionId ?? activeSessionId ?? undefined
  const hasText = text.trim().length > 0

  useEffect(() => () => {
    if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
  }, [])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      showToast(t('session.pipeline.action.copied'))
      if (copyTimerRef.current !== null) window.clearTimeout(copyTimerRef.current)
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1300)
    } catch (error) {
      rlog.warn('[message-actions] clipboard write failed', error)
      showToast(t('session.pipeline.action.copyFailed'))
    }
  }

  const quote = () => {
    if (!targetSessionId || !hasText) return
    setComposerQuote({
      sessionId: targetSessionId,
      quote: {
        sourceRole: role === 'user' ? 'user' : 'assistant',
        text,
        ...(messageId ? { messageId } : {}),
        ...(turnId ? { turnId } : {}),
      },
    })
  }

  return (
    <div
      className="flex min-h-7 items-center gap-0.5 opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100"
      role="group"
      aria-label={t('session.pipeline.action.groupAria')}
    >
      {hasText && (
        <Tooltip content={t('session.pipeline.action.copy')}>
          <button
            type="button"
            onClick={() => { void copy() }}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            aria-label={t('session.pipeline.action.copy')}
          >
            {copied ? <Check size={14} /> : <Copy size={14} strokeWidth={1.6} />}
          </button>
        </Tooltip>
      )}
      {hasText && targetSessionId && (
        <Tooltip content={t('session.pipeline.action.quote')}>
          <button
            type="button"
            onClick={quote}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            aria-label={t('session.pipeline.action.quote')}
          >
            <Quote size={14} strokeWidth={1.5} />
          </button>
        </Tooltip>
      )}
      {role === 'ai' && onReport && (
        <Tooltip content={t('session.pipeline.action.report')}>
          <button
            type="button"
            onClick={onReport}
            className="inline-flex h-7 w-7 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-hover hover:text-text-primary"
            aria-label={t('session.pipeline.action.report')}
          >
            <Flag size={14} strokeWidth={1.6} />
          </button>
        </Tooltip>
      )}
    </div>
  )
}
