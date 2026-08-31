import type { MessageBlock } from '@/atoms/agent'
import type { ChatBlock } from '@shared/types'
import { Quote } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import { getMentionBadgeClass, getMentionPrefix, SLASH_BADGE_CLASS } from '@/components/composer/segments'
import { messageQuoteFromBlock } from '@/components/composer/messageQuote'

type StructuredInputBlock = MessageBlock | ChatBlock

export interface StructuredInputProps {
  blocks: readonly StructuredInputBlock[]
  className?: string
}

/** Render persisted composer input while preserving mention and slash tokens.
 *
 *  Text is rendered verbatim: what the user typed is never re-interpreted, so a pasted path stays
 *  the characters they wrote rather than becoming a link or an inline preview. Guessing where a path
 *  ends is not decidable from the text alone — paths may contain spaces, so `/tmp/a.docx make a deck`
 *  parsed as one path and swallowed the request into the link target. */
export function StructuredInput({ blocks, className }: StructuredInputProps) {
  const { t } = useTranslation()
  const badge = 'inline-flex items-center align-baseline px-1.5 py-0.5 mx-0.5 rounded-sm text-xs select-none'
  return (
    <span className={cn('whitespace-pre-wrap break-words', className)}>
      {blocks.map((block, index) => {
        const quote = messageQuoteFromBlock(block)
        if (quote) {
          const source = quote.sourceRole === 'user'
            ? t('composer.quote.userSource')
            : t('composer.quote.agentSource')
          return (
            <span
              key={index}
              data-message-quote={quote.sourceRole}
              className="mb-2 flex min-w-0 items-start gap-2 rounded-md border border-border-subtle bg-bg-surface px-2.5 py-2"
            >
              <span className="mt-0.5 shrink-0 text-text-tertiary" aria-hidden="true">
                <Quote size={14} strokeWidth={1.5} />
              </span>
              <span className="min-w-0">
                <span className="mb-0.5 block text-xs font-medium text-text-secondary">{source}</span>
                <span className="line-clamp-3 block whitespace-pre-wrap break-words text-xs leading-relaxed text-text-tertiary">
                  {quote.text}
                </span>
              </span>
            </span>
          )
        }
        if (block.type === 'mention') {
          return (
            <span key={index} data-input-token="mention" className={cn(badge, getMentionBadgeClass(block.group))}>
              {getMentionPrefix(block.group)}{block.label}
            </span>
          )
        }
        if (block.type === 'slash') {
          return (
            <span key={index} data-input-token="slash" className={cn(badge, SLASH_BADGE_CLASS)}>
              /{block.resource ? block.label : block.id}
            </span>
          )
        }
        if (block.type === 'text') {
          return <span key={index}>{'value' in block ? block.value : block.text}</span>
        }
        return null
      })}
    </span>
  )
}
