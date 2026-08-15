import type { MessageBlock } from '@/atoms/agent'
import { splitProcessAndAnswer } from './qaSegments'

export interface MessageActionTextInput {
  role: 'ai' | 'user'
  content: string
  blocks?: MessageBlock[]
  finalAnswer?: string | null
  error?: string
  stopped?: boolean
}

/** Return exactly the user-visible message text used by copy, quote, and feedback. */
export function messageActionText(input: MessageActionTextInput): string {
  if (input.role === 'user') return input.content.trim()

  if (input.finalAnswer !== undefined) {
    const authoritative = (input.finalAnswer ?? '').trim()
    if (authoritative) return authoritative
    if (input.error?.trim()) return input.error.trim()
    return input.stopped && (!input.blocks || input.blocks.length === 0)
      ? input.content.trim()
      : ''
  }

  if (input.blocks && input.blocks.length > 0) {
    const { answer } = splitProcessAndAnswer(input.blocks)
    const answerText = answer
      .filter((block): block is Extract<MessageBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
      .trim()
    if (answerText) return answerText
    return input.error?.trim() ?? ''
  }

  return input.content.trim() || input.error?.trim() || ''
}
