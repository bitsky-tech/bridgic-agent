import { atom } from 'jotai'
import { isDocxFileName } from '@/lib/fileTypes'
import { setRightPanelCollapsedAtom } from './layout'
import { viewedSessionIdAtom } from './navigation'
import { SessionWorkbenchSurface, setSessionWorkbenchSurfaceAtom } from './workbench'

type WordStateUpdate<T> = T | ((current: T) => T)

const expandedWordSessionsAtom = atom<ReadonlySet<string>>(new Set<string>())

export interface WordFileOpenRequest {
  id: string
  name: string
  path: string
  sessionId: string
}

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

export const completeWordFileOpenAtom = atom(null, (get, set, requestId: string) => {
  const sessionId = get(viewedSessionIdAtom)
  if (!sessionId) return
  const current = get(wordFileOpenRequestsAtom).get(sessionId)
  if (current?.id !== requestId) return
  const requests = new Map(get(wordFileOpenRequestsAtom))
  requests.delete(sessionId)
  set(wordFileOpenRequestsAtom, requests)
})

/** Whether Word owns the complete center + right work area for the viewed Session. */
export const wordExpandedAtom = atom(
  (get) => {
    const sessionId = get(viewedSessionIdAtom)
    return sessionId ? get(expandedWordSessionsAtom).has(sessionId) : false
  },
  (get, set, update: WordStateUpdate<boolean>) => {
    const sessionId = get(viewedSessionIdAtom)
    if (!sessionId) return
    const current = get(expandedWordSessionsAtom)
    const nextValue = typeof update === 'function' ? update(current.has(sessionId)) : update
    if (nextValue === current.has(sessionId)) return
    const next = new Set(current)
    if (nextValue) next.add(sessionId)
    else next.delete(sessionId)
    set(expandedWordSessionsAtom, next)
  },
)

/** Release the transient renderer projection after an Agent Session is deleted. */
export const purgeWordStateAtom = atom(null, (get, set, sessionId: string) => {
  const current = get(expandedWordSessionsAtom)
  if (current.has(sessionId)) {
    const next = new Set(current)
    next.delete(sessionId)
    set(expandedWordSessionsAtom, next)
  }
  const requests = get(wordFileOpenRequestsAtom)
  if (requests.has(sessionId)) {
    const next = new Map(requests)
    next.delete(sessionId)
    set(wordFileOpenRequestsAtom, next)
  }
})
