/**
 * A Promise-ized state bridge for the external-link open confirmation dialog (modeled on
 * confirm.ts).
 *
 * `requestExternalLink(url)` returns Promise<boolean> — the dialog is rendered by
 * ExternalLinkDialog and resolves when the user picks "open link / cancel". Once the user
 * ticks "don't ask again this session" and chooses open, `_skip` flips to true and later
 * calls resolve(true) straight through (in-memory state, reset on app restart = "this
 * session").
 *
 * Invariant: only one pending request is held at any moment (clicking a markdown link is a
 * serial manual user action).
 */
import { atom } from 'jotai'

/** One external-link confirmation request's payload + resolver. */
export interface ExternalLinkRequest {
  url: string
  resolve: (open: boolean) => void
}

const _request = atom<ExternalLinkRequest | null>(null)
/** The "don't ask again" marker for this session (in-memory state). */
const _skip = atom(false)

/** Read — subscribed by ExternalLinkDialog to decide whether to render the confirmation box. */
export const externalLinkRequestAtom = atom((get) => get(_request))

/** Write — raise one external-link confirmation. If "don't ask again" is already set → let it through immediately. Returns Promise<boolean>. */
export const requestExternalLinkAtom = atom(
  null,
  (get, set, url: string): Promise<boolean> => {
    if (get(_skip)) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => set(_request, { url, resolve }))
  },
)

/** Write — the user's decision: open = whether to open; dontAsk = whether "don't ask again" was
 *  ticked. skip is set only when **opening AND ticked** (ticking on cancel is meaningless —
 *  otherwise it would bind "auto-open from now on" to a single refusal). Resolves and clears the slot. */
export const resolveExternalLinkAtom = atom(
  null,
  (get, set, decision: { open: boolean; dontAsk: boolean }) => {
    const req = get(_request)
    if (!req) return
    if (decision.open && decision.dontAsk) set(_skip, true)
    req.resolve(decision.open)
    set(_request, null)
  },
)
