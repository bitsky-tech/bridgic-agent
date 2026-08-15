import { atom } from 'jotai'

export type ComposerQuoteRole = 'user' | 'assistant'

export interface ComposerMessageQuote {
  sourceRole: ComposerQuoteRole
  text: string
  messageId?: string
  turnId?: string
}

const _composerQuotes = atom<Record<string, ComposerMessageQuote>>({})

/** Per-session quoted message shown above the editable composer body. */
export const composerQuotesAtom = atom((get) => get(_composerQuotes))

/** Replace the current Session's quote without touching its unsent editable draft. */
export const setComposerQuoteAtom = atom(
  null,
  (get, set, payload: { sessionId: string; quote: ComposerMessageQuote }) => {
    set(_composerQuotes, { ...get(_composerQuotes), [payload.sessionId]: payload.quote })
  },
)

/** Remove one Session's quote after dismissal or successful submit. */
export const clearComposerQuoteAtom = atom(null, (get, set, sessionId: string) => {
  const current = get(_composerQuotes)
  if (!(sessionId in current)) return
  const next = { ...current }
  delete next[sessionId]
  set(_composerQuotes, next)
})
