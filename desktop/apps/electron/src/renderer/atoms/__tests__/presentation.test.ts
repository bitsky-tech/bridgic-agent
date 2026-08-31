import { describe, expect, it } from 'bun:test'
import { createStore } from 'jotai'
import { activeSessionIdAtom } from '../sessions'
import {
  PRESENTATION_PAGE_SIZES,
  createBlankPresentationSlide,
  createBlankPresentationDocument,
  createInitialPresentationDocument,
  currentPresentationDocumentAtom,
  currentPresentationWorkspaceAtom,
  presentationExpandedAtom,
  purgePresentationSessionAtom,
  formatPresentationText,
  layoutPresentationVerticalText,
  stripPresentationListMarkers,
  stripPresentationTextFormatting,
} from '../presentation'

describe('presentation atoms', () => {
  it('creates documents with an explicit widescreen page size', () => {
    expect(createInitialPresentationDocument().pageSize).toEqual(PRESENTATION_PAGE_SIZES.wide)
    expect(createBlankPresentationDocument('Blank').pageSize).toEqual(PRESENTATION_PAGE_SIZES.wide)
  })

  it('gives every generated slide an explicit no-transition default', () => {
    expect(createBlankPresentationSlide('Blank').transition).toEqual({ effect: 'none', durationMs: 1_000 })
    const initialDocument = createInitialPresentationDocument()
    expect(initialDocument.slides.every((slide) => (
      slide.transition.effect === 'none' && slide.transition.durationMs === 1_000
    ))).toBe(true)
    expect(initialDocument.slides.every((slide) => slide.footer === undefined)).toBe(true)
  })

  it('starts with one unnamed slide containing ordinary editable text boxes instead of bundled sample content', () => {
    const document = createInitialPresentationDocument()
    expect(document.title).toBe('')
    expect(document.slides).toHaveLength(1)
    expect(document.selectedSlideId).toBe(document.slides[0]!.id)
    expect(document.slides[0]).toMatchObject({
      background: '#FFFFFF',
      layout: 'title',
      name: 'Slide 1',
      notes: '',
    })
    expect(document.slides[0]!.elements).toHaveLength(3)
    expect(document.slides[0]!.elements.every((element) => element.type === 'text')).toBe(true)
    expect(document.slides[0]!.elements.every((element) => element.type !== 'text' || element.text.length > 0)).toBe(true)
    expect(document.slides[0]!.elements.every((element) => !('placeholder' in element))).toBe(true)
    expect(JSON.stringify(document)).not.toContain('Ideas that move forward')
  })

  it('formats list markers for display without polluting editable text', () => {
    const element = {
      id: 'list-text',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 300,
      height: 120,
      rotation: 0,
      text: 'First point\nSecond point',
      fontSize: 24,
      fontFamily: 'Aptos',
      fontWeight: 400 as const,
      color: '#1D1D28',
      align: 'left' as const,
      listStyle: 'number' as const,
    }

    const displayText = formatPresentationText(element)
    expect(displayText).toBe('1. First point\n2. Second point')
    expect(stripPresentationListMarkers(displayText, element.listStyle)).toBe(element.text)
  })

  it('lays out East Asian vertical text as right-to-left columns without changing its source', () => {
    const element = {
      id: 'vertical-text',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 120,
      height: 240,
      rotation: 0,
      text: '甲乙\n丙丁',
      fontSize: 24,
      fontFamily: 'Aptos',
      fontWeight: 400 as const,
      color: '#1D1D28',
      align: 'left' as const,
      textDirection: 'eastAsianVertical' as const,
    }

    const displayText = formatPresentationText(element)
    expect(displayText).toBe('丙　甲\n丁　乙')
    expect(stripPresentationTextFormatting(displayText, element)).toBe(element.text)
  })

  it('wraps East Asian vertical text to the text-frame height instead of overflowing in paragraph columns', () => {
    const element = {
      id: 'vertical-poem',
      type: 'text' as const,
      x: 0,
      y: 0,
      width: 311,
      height: 173,
      rotation: 0,
      text: '万木冻欲折孤根暖独回 前村深雪里昨夜一枝开 \n风递幽香出禽窥素艳来 明年如应律先发映春台',
      fontSize: 30.1067,
      fontFamily: '叶根友毛笔行书2.0版',
      fontWeight: 400 as const,
      color: '#000000',
      align: 'left' as const,
      textDirection: 'eastAsianVertical' as const,
      textInsets: { left: 9.6, top: 4.8, right: 9.6, bottom: 4.8 },
    }

    const layout = layoutPresentationVerticalText(element)

    expect(layout.rowsPerColumn).toBe(5)
    expect(layout.columns).toEqual([
      '万木冻欲折',
      '孤根暖独回',
      '前村深雪里',
      '昨夜一枝开',
      '风递幽香出',
      '禽窥素艳来',
      '明年如应律',
      '先发映春台',
    ])
    expect(stripPresentationTextFormatting(formatPresentationText(element), element)).toBe(element.text)
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
