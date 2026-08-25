import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { activeSessionIdAtom } from '../sessions'
import {
  createBlankPresentationSlide,
  createBlankPresentationDocument,
  createInitialPresentationDocument,
  currentPresentationDocumentAtom,
  currentPresentationWorkspaceAtom,
  presentationExpandedAtom,
  purgePresentationSessionAtom,
  formatPresentationText,
  stripPresentationListMarkers,
} from '../presentation'

describe('presentation atoms', () => {
  it('gives every generated slide an explicit no-transition default', () => {
    expect(createBlankPresentationSlide('Blank').transition).toEqual({ effect: 'none', durationMs: 500 })
    expect(createInitialPresentationDocument().slides.every((slide) => (
      slide.transition.effect === 'none' && slide.transition.durationMs === 500
    ))).toBe(true)
  })

  it('formats list markers for display without polluting editable text', () => {
    const document = createInitialPresentationDocument()
    const element = document.slides[0]?.elements.find((item) => item.type === 'text')
    if (!element || element.type !== 'text') throw new Error('Expected a text element')
    element.text = 'First point\nSecond point'
    element.listStyle = 'number'

    const displayText = formatPresentationText(element)
    expect(displayText).toBe('1. First point\n2. Second point')
    expect(stripPresentationListMarkers(displayText, element.listStyle)).toBe(element.text)
  })

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

  it('keeps multiple open presentations independent within one Session', () => {
    const store = createStore()
    store.set(activeSessionIdAtom, 'session-tabs')
    const firstWorkspace = store.get(currentPresentationWorkspaceAtom)
    const firstDocument = firstWorkspace.documents[0]!
    const secondDocument = createBlankPresentationDocument('Second deck')

    store.set(currentPresentationWorkspaceAtom, {
      activeDocumentId: secondDocument.id,
      documents: [...firstWorkspace.documents, secondDocument],
    })
    store.set(currentPresentationDocumentAtom, {
      ...store.get(currentPresentationDocumentAtom),
      title: 'Edited second deck',
    })

    const withEditedSecond = store.get(currentPresentationWorkspaceAtom)
    store.set(currentPresentationWorkspaceAtom, {
      ...withEditedSecond,
      activeDocumentId: firstDocument.id,
    })

    expect(store.get(currentPresentationDocumentAtom).id).toBe(firstDocument.id)
    expect(store.get(currentPresentationDocumentAtom).title).toBe(firstDocument.title)
    expect(store.get(currentPresentationWorkspaceAtom).documents.find((item) => (
      item.id === secondDocument.id
    ))?.title).toBe('Edited second deck')
  })
})
