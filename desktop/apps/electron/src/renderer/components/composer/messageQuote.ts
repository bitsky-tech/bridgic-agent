import type { ChatBlock, MessageBlock } from '@shared/types'
import type { ComposerMessageQuote, ComposerQuoteRole } from '@/atoms/composer-quote'

const QUOTE_OPEN = '<quoted_message source="'
const QUOTE_OPEN_END = '">\n'
const QUOTE_CLOSE = '\n</quoted_message>\n\n'

/** Serialize a visual composer quote into one ordinary text block for the Agent prompt. */
export function messageQuoteToChatBlock(quote: ComposerMessageQuote): Extract<ChatBlock, { type: 'text' }> {
  return {
    type: 'text',
    value: `${QUOTE_OPEN}${quote.sourceRole}${QUOTE_OPEN_END}${quote.text}${QUOTE_CLOSE}`,
  }
}

/** Recognize only blocks emitted by {@link messageQuoteToChatBlock}. */
export function messageQuoteFromBlock(block: ChatBlock | MessageBlock): ComposerMessageQuote | null {
  if (block.type !== 'text') return null
  const value = 'value' in block ? block.value : block.text
  if (!value.startsWith(QUOTE_OPEN) || !value.endsWith(QUOTE_CLOSE)) return null
  const roleEnd = value.indexOf(QUOTE_OPEN_END, QUOTE_OPEN.length)
  if (roleEnd < 0) return null
  const sourceRole = value.slice(QUOTE_OPEN.length, roleEnd)
  if (!isQuoteRole(sourceRole)) return null
  return {
    sourceRole,
    text: value.slice(roleEnd + QUOTE_OPEN_END.length, -QUOTE_CLOSE.length),
  }
}

function isQuoteRole(value: string): value is ComposerQuoteRole {
  return value === 'user' || value === 'assistant'
}
