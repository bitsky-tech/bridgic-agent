import { describe, expect, it } from 'bun:test'
import { blocksToSegments } from '../segments'
import { messageQuoteFromBlock, messageQuoteToChatBlock } from '../messageQuote'

describe('composer message quote', () => {
  it('round-trips user and agent quote content without changing it', () => {
    const quote = {
      sourceRole: 'assistant' as const,
      text: '第一行\n包含 `Markdown` 与 <标签>',
      messageId: 'message-1',
      turnId: 'turn-1',
    }
    const block = messageQuoteToChatBlock(quote)

    expect(messageQuoteFromBlock(block)).toEqual({
      sourceRole: 'assistant',
      text: quote.text,
    })
  })

  it('does not restore the serialized quote into editable history', () => {
    const quoteBlock = messageQuoteToChatBlock({ sourceRole: 'user', text: '原始问题' })
    expect(blocksToSegments([
      { type: 'text', text: quoteBlock.value },
      { type: 'text', text: '继续追问' },
    ])).toEqual([{ type: 'text', value: '继续追问' }])
  })

  it('does not treat ordinary text as a quote', () => {
    expect(messageQuoteFromBlock({ type: 'text', value: '引用：普通文本' })).toBeNull()
  })
})
