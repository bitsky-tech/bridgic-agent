/** Persistent per-Session attention state for newly added Files. */
import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'

const filesAttentionSessionIdsAtom = atom<ReadonlySet<string>>(new Set<string>())

/** Read whether one Session has newly added Files waiting in the background. */
export const filesNeedsAttentionFamily = atomFamily((sessionId: string) => atom((get) => (
  get(filesAttentionSessionIdsAtom).has(sessionId)
)))

/** Mark or clear one Session's persistent Files attention state. */
export const setFilesNeedsAttentionAtom = atom(
  null,
  (get, set, update: { sessionId: string; needsAttention: boolean }) => {
    if (!update.sessionId) return
    const current = get(filesAttentionSessionIdsAtom)
    if (current.has(update.sessionId) === update.needsAttention) return
    const next = new Set(current)
    if (update.needsAttention) next.add(update.sessionId)
    else next.delete(update.sessionId)
    set(filesAttentionSessionIdsAtom, next)
  },
)

/** Drop one deleted Session's Files attention state and cached selector. */
export const purgeFilesAttentionAtom = atom(null, (get, set, sessionId: string) => {
  const current = get(filesAttentionSessionIdsAtom)
  if (current.has(sessionId)) {
    const next = new Set(current)
    next.delete(sessionId)
    set(filesAttentionSessionIdsAtom, next)
  }
  filesNeedsAttentionFamily.remove(sessionId)
})
