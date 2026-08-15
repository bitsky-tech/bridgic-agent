/**
 * Send gate — "the input box is usable" and "sending is allowed right now" are two different things.
 *
 * Invariant: while a turn runs (`streaming`) the input box is deliberately kept usable so the user can type the next
 * message; but the backend is serial-chat — calling `chat` again on the same session before the previous turn finishes
 * returns `cmd_error: "A turn is already running …"` from the daemon's chat handler, so sending must be blocked until
 * this turn ends. Merging the two into a single `disabled` would regress to the
 * old behaviour of "you cannot even type while it runs".
 *
 * FreeFormInput's submit early-return and the send button's `canSubmit` share this function, so the condition is not
 * written twice and cannot drift — the consequence of drift is that the message really is sent to the daemon and rejected,
 * and all the user sees is one silent failure.
 *
 * It is a separate file (rather than staying in FreeFormInput.tsx) to make it unit-testable: the component file statically
 * imports the whole atom dependency chain, which blows up at module load under bun:test. The sibling `matchesFilter.ts` /
 * `pasteClassify.ts` exist for the same reason.
 */

/** Whether the input may be sent right now. All three conditions are required. */
export function canSendNow(
  sessionId: string | null,
  disabled: boolean,
  streaming: boolean,
): boolean {
  return sessionId !== null && !disabled && !streaming
}
