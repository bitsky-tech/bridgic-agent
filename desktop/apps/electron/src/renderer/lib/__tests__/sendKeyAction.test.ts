/**
 * Tests for lib/sendKeyAction.ts — send, newline, and pass-through classification by resolveSendKeyAction.
 */
import { describe, it, expect } from 'bun:test'
import {
  resolveSendKeyAction,
  type SendKeyAction,
  type SendKeyEvent,
} from '../sendKeyAction'

/** Build a minimal keydown event with no composition state or modifiers by default. */
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
