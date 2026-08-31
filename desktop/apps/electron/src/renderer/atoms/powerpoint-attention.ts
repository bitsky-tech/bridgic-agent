/** Persistent per-Session attention state for unseen PowerPoint activity. */
import { atom } from 'jotai'
import { atomFamily } from 'jotai-family'

const powerPointAttentionSessionIdsAtom = atom<ReadonlySet<string>>(new Set<string>())

/** Read whether one Session has unseen PowerPoint activity. */
export const powerPointNeedsAttentionFamily = atomFamily((sessionId: string) => atom((get) => (
  get(powerPointAttentionSessionIdsAtom).has(sessionId)
)))

/** Mark or clear one Session's persistent PowerPoint attention state. */
export const setPowerPointNeedsAttentionAtom = atom(
  null,
  (get, set, update: { sessionId: string; needsAttention: boolean }) => {
    if (!update.sessionId) return
    const current = get(powerPointAttentionSessionIdsAtom)
    if (current.has(update.sessionId) === update.needsAttention) return
    const next = new Set(current)
    if (update.needsAttention) next.add(update.sessionId)
    else next.delete(update.sessionId)
    set(powerPointAttentionSessionIdsAtom, next)
  },
)

/** Drop one deleted Session's PowerPoint attention state and cached selector. */
export const purgePowerPointAttentionAtom = atom(null, (get, set, sessionId: string) => {
  const current = get(powerPointAttentionSessionIdsAtom)
  if (current.has(sessionId)) {
    const next = new Set(current)
    next.delete(sessionId)
    set(powerPointAttentionSessionIdsAtom, next)
  }
  powerPointNeedsAttentionFamily.remove(sessionId)
})
