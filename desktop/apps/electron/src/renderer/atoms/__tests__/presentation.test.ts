import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { activeSessionIdAtom } from '../sessions'
import {
  createInitialPresentationDocument,
  currentPresentationDocumentAtom,
  presentationExpandedAtom,
  purgePresentationSessionAtom,
} from '../presentation'

describe('presentation atoms', () => {
  it('keeps documents and expanded state independent between Sessions', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-a')
    const sessionADocument = {
      ...createInitialPresentationDocument(),
      title: 'Session A deck',
    }
    store.set(currentPresentationDocumentAtom, sessionADocument)
    store.set(presentationExpandedAtom, true)

    store.set(activeSessionIdAtom, 'session-b')
    expect(store.get(currentPresentationDocumentAtom).title).not.toBe('Session A deck')
    expect(store.get(presentationExpandedAtom)).toBe(false)

    store.set(activeSessionIdAtom, 'session-a')
    expect(store.get(currentPresentationDocumentAtom).title).toBe('Session A deck')
    expect(store.get(presentationExpandedAtom)).toBe(true)
  })

  it('removes a deleted Session document and expansion state', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-delete')
    store.set(currentPresentationDocumentAtom, {
      ...createInitialPresentationDocument(),
      title: 'Delete me',
    })
    store.set(presentationExpandedAtom, true)

    store.set(purgePresentationSessionAtom, 'session-delete')

    expect(store.get(currentPresentationDocumentAtom).title).not.toBe('Delete me')
    expect(store.get(presentationExpandedAtom)).toBe(false)
  })
})
