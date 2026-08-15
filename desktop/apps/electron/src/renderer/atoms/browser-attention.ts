/**
 * Persistent per-Session attention state for unseen embedded-Browser activity.
 *
 * The Agent event reducer and browser snapshot bridge can raise attention even
 * while Session UI is unmounted. Presentation code clears it only after the
 * Browser is actually exposed or the user explicitly selects its rail entry.
 */
import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'

const browserAttentionSessionIdsAtom = atom<ReadonlySet<string>>(new Set<string>())

/** Read whether one Session has unseen Browser activity. */
export const browserNeedsAttentionFamily = atomFamily((sessionId: string) => atom((get) => (
  get(browserAttentionSessionIdsAtom).has(sessionId)
)))

/** Mark or clear one Session's persistent Browser attention state. */
export const setBrowserNeedsAttentionAtom = atom(
  null,
  (get, set, update: { sessionId: string; needsAttention: boolean }) => {
    if (!update.sessionId) return
    const current = get(browserAttentionSessionIdsAtom)
    if (current.has(update.sessionId) === update.needsAttention) return
    const next = new Set(current)
    if (update.needsAttention) next.add(update.sessionId)
    else next.delete(update.sessionId)
    set(browserAttentionSessionIdsAtom, next)
  },
)

/** Drop one deleted Session's Browser attention state and cached selector. */
export const purgeBrowserAttentionAtom = atom(null, (get, set, sessionId: string) => {
  const current = get(browserAttentionSessionIdsAtom)
  if (current.has(sessionId)) {
    const next = new Set(current)
    next.delete(sessionId)
    set(browserAttentionSessionIdsAtom, next)
  }
  browserNeedsAttentionFamily.remove(sessionId)
})
