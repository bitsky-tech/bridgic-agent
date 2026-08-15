import { Quote, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ComposerMessageQuote } from '@/atoms/composer-quote'
import { Tooltip } from '@/components/amphi/Tooltip'

export interface ComposerQuoteCardProps {
  quote: ComposerMessageQuote
  onRemove: () => void
}

/** Compact, removable quote preview inside the composer surface. */
export function ComposerQuoteCard({ quote, onRemove }: ComposerQuoteCardProps) {
  const { t } = useTranslation()
  const source = quote.sourceRole === 'user'
    ? t('composer.quote.userSource')
    : t('composer.quote.agentSource')
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md bg-bg-hover px-2.5 py-2">
      <span className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden="true">
        <Quote size={14} strokeWidth={1.5} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 text-[11px] font-medium text-text-secondary">{source}</div>
        <div className="line-clamp-2 whitespace-pre-wrap break-words text-xs leading-relaxed text-text-tertiary">
          {quote.text}
        </div>
      </div>
      <Tooltip content={t('composer.quote.remove')}>
        <button
          type="button"
          onClick={onRemove}
          className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-tertiary hover:bg-bg-active hover:text-text-primary"
          aria-label={t('composer.quote.remove')}
        >
          <X size={13} />
        </button>
      </Tooltip>
    </div>
  )
}
