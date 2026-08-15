/**
 * Tests for lib/sendKeyAction.ts — resolveSendKeyAction 的发送/换行/放行归类。
 */
import { describe, it, expect } from 'bun:test'
import {
  resolveSendKeyAction,
  type SendKeyAction,
  type SendKeyEvent,
} from '../sendKeyAction'

/** 造一个最小 keydown,默认非组合态、无修饰键。 */
function mk(partial: Partial<SendKeyEvent> & { key: string }): SendKeyEvent {
  return {
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    nativeEvent: { isComposing: false },
    ...partial,
  }
}

describe('resolveSendKeyAction', () => {
  it('implements both send-key modes without intercepting composition or other keys', () => {
    const cases: Array<[SendKeyEvent, 'enter' | 'cmd-enter', SendKeyAction]> = [
      [mk({ key: 'Enter' }), 'enter', 'send'],
      [mk({ key: 'Enter', shiftKey: true }), 'enter', 'newline'],
      [mk({ key: 'Enter', metaKey: true }), 'enter', 'send'],
      [mk({ key: 'Enter', metaKey: true }), 'cmd-enter', 'send'],
      [mk({ key: 'Enter', ctrlKey: true }), 'cmd-enter', 'send'],
      [mk({ key: 'Enter' }), 'cmd-enter', 'newline'],
      [mk({ key: 'Enter', nativeEvent: { isComposing: true } }), 'enter', 'ignore'],
      [mk({ key: 'Enter', nativeEvent: { isComposing: true } }), 'cmd-enter', 'ignore'],
      [mk({ key: 'a' }), 'enter', 'ignore'],
      [mk({ key: 'Escape' }), 'cmd-enter', 'ignore'],
    ]

    for (const [event, mode, expected] of cases) {
      expect(resolveSendKeyAction(event, mode)).toBe(expected)
    }
  })
})
