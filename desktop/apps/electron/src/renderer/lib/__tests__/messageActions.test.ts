import { describe, expect, it } from 'bun:test'
import type { MessageBlock } from '@/atoms/agent'
import { messageActionText } from '../messageActions'

const text = (value: string): MessageBlock => ({ type: 'text', text: value })

describe('messageActionText', () => {
  it('copies the visible user message', () => {
    expect(messageActionText({ role: 'user', content: '  帮我检查一下  ' })).toBe('帮我检查一下')
  })

  it('uses the authoritative final answer without process or tool output', () => {
    expect(messageActionText({
      role: 'ai',
      content: '中间过程\n最终回答',
      blocks: [
        { type: 'thinking', text: '内部思考' },
        { type: 'tool', toolUseId: 'tool-1', name: 'bash', input: { command: 'secret' } },
        text('最终回答'),
      ],
      finalAnswer: '最终回答',
    })).toBe('最终回答')
  })

  it('keeps an authoritative empty answer empty instead of leaking process text', () => {
    expect(messageActionText({
      role: 'ai',
      content: '尚未完成的过程',
      blocks: [text('尚未完成的过程')],
      finalAnswer: '',
    })).toBe('')
  })

  it('falls back to the trailing legacy answer', () => {
    expect(messageActionText({
      role: 'ai',
      content: '旧消息',
      blocks: [
        { type: 'thinking', text: '分析' },
        { type: 'tool', toolUseId: 'tool-2', name: 'read', input: {} },
        text('第一段'),
        text('第二段'),
      ],
    })).toBe('第一段\n\n第二段')
  })

  it('does not fall back to process text when structured legacy output has no answer', () => {
    expect(messageActionText({
      role: 'ai',
      content: '执行中的中间文字',
      blocks: [
        text('执行中的中间文字'),
        { type: 'tool', toolUseId: 'tool-3', name: 'bash', input: { command: 'private' } },
      ],
    })).toBe('')
  })

  it('keeps useful stopped and error text when no answer exists', () => {
    expect(messageActionText({ role: 'ai', content: '部分输出', finalAnswer: '', stopped: true })).toBe('部分输出')
    expect(messageActionText({ role: 'ai', content: '', finalAnswer: '', error: '连接失败' })).toBe('连接失败')
  })
})
