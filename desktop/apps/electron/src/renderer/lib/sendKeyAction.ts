/**
 * Classify one keyboard keydown into send / newline / pass-through per the "send key" setting.
 *
 * Single source of truth: the two comment inputs (SpecPreviewPane's selected-comment box,
 * CommentFeedbackPanel's batch-instruction box) share one set of send / newline / IME
 * semantics, matching word for word the Enter decision of the chat composer
 * `FreeFormInput` (see its send branch).
 *
 * Pure function, no side effects, no React dependency — directly unit-testable with bun:test.
 *
 * Key invariants:
 *  - During IME composition (`nativeEvent.isComposing`) always pass through — pressing
 *    Enter to confirm a Chinese / Japanese candidate must not trigger a send.
 *  - Non-Enter keys are not this function's business; always pass through.
 */

/** The minimal shape of a keydown, compatible with `React.KeyboardEvent`. */
export interface SendKeyEvent {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  nativeEvent: { isComposing: boolean }
}

/** The classification result: submit, insert a newline, or don't intercept and hand back to native. */
export type SendKeyAction = 'send' | 'newline' | 'ignore'

/**
 * Classify one keydown per the `sendKey` setting.
 *
 * @param sendKey - The chat composer's send-key setting (`settingsAtom.composer.inputSendKey`)
 */
export function resolveSendKeyAction(e: SendKeyEvent, sendKey: 'enter' | 'cmd-enter'): SendKeyAction {
  if (e.nativeEvent.isComposing) return 'ignore'
  if (e.key !== 'Enter') return 'ignore'
  const hasModifier = e.metaKey || e.ctrlKey
  if (sendKey === 'enter') return e.shiftKey ? 'newline' : 'send'
  return hasModifier ? 'send' : 'newline'
}
