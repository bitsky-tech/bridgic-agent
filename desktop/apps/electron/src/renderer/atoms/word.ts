import { atom } from 'jotai'
import type { WordHostOpenRequest, WordHostSnapshot } from '@shared/types'
import { isDocxFileName } from '@/lib/fileTypes'
import { setRightPanelCollapsedAtom } from './layout'
import { viewedSessionIdAtom } from './navigation'
import { SessionWorkbenchSurface, setSessionWorkbenchSurfaceAtom } from './workbench'

export const wordHostSnapshotAtom = atom<WordHostSnapshot>({ sessions: [] })

export const activeWordHostSessionAtom = atom((get) => {
  const sessionId = get(viewedSessionIdAtom)
  return get(wordHostSnapshotAtom).sessions.find((entry) => entry.sessionId === sessionId) ?? null
})

export const wordDocumentCountAtom = atom((get) => get(activeWordHostSessionAtom)?.documentCount ?? null)
export const wordExpandedAtom = atom((get) => get(activeWordHostSessionAtom)?.expanded ?? false)
export type WordFileOpenRequest = WordHostOpenRequest

const wordFileOpenRequestsAtom = atom<ReadonlyMap<string, WordFileOpenRequest>>(new Map())

export const wordFileOpenRequestAtom = atom((get): WordFileOpenRequest | null => {
  const sessionId = get(viewedSessionIdAtom)
  return sessionId ? get(wordFileOpenRequestsAtom).get(sessionId) ?? null : null
})

/** Route an explicit file click into the viewed Session's Word surface. */
export const requestWordFileOpenAtom = atom(
  null,
  (get, set, file: { name: string; path: string }) => {
    const sessionId = get(viewedSessionIdAtom)
    if (!sessionId || !isDocxFileName(file.name)) return
    const requests = new Map(get(wordFileOpenRequestsAtom))
    if (requests.get(sessionId)?.path === file.path) return
    requests.set(sessionId, {
      id: typeof crypto?.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
      name: file.name,
      path: file.path,
      sessionId,
    })
    set(wordFileOpenRequestsAtom, requests)
    set(setSessionWorkbenchSurfaceAtom, SessionWorkbenchSurface.Word)
    set(setRightPanelCollapsedAtom, false)
  },
)

/** Complete the original Session request even if the user has since navigated elsewhere. */
export const completeWordFileOpenAtom = atom(null, (get, set, request: { sessionId: string; requestId: string }) => {
  const current = get(wordFileOpenRequestsAtom).get(request.sessionId)
  if (current?.id !== request.requestId) return
  const requests = new Map(get(wordFileOpenRequestsAtom))
  requests.delete(request.sessionId)
  set(wordFileOpenRequestsAtom, requests)
})

/** Release only the deleted Session's renderer projections. */
export const purgeWordStateAtom = atom(null, (get, set, sessionId: string) => {
  const snapshot = get(wordHostSnapshotAtom)
  if (snapshot.sessions.some((entry) => entry.sessionId === sessionId)) {
    set(wordHostSnapshotAtom, { sessions: snapshot.sessions.filter((entry) => entry.sessionId !== sessionId) })
  }
  const requests = get(wordFileOpenRequestsAtom)
  if (requests.has(sessionId)) {
    const next = new Map(requests)
    next.delete(sessionId)
    set(wordFileOpenRequestsAtom, next)
  }
})
