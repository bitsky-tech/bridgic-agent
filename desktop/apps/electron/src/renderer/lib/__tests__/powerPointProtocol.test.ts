import { describe, expect, it } from 'bun:test'
import { createBlankPresentationDocument, type PresentationWorkspace } from '@/atoms/presentation'
import { executePowerPointRequest } from '../powerPointProtocol'

function workspace(): PresentationWorkspace {
  const document = createBlankPresentationDocument('Quarterly review')
  return { activeDocumentId: document.id, documents: [document] }
}

describe('PowerPoint renderer protocol', () => {
  it('applies a structured batch and returns generated ids', () => {
    const initial = workspace()
    const slideId = initial.documents[0]!.selectedSlideId
    const applied = executePowerPointRequest(initial, {
      method: 'apply',
      params: {
        operations: [
          {
            type: 'add_element',
            slide_id: slideId,
            element: { type: 'text', text: 'Revenue grew 24%', x: 80, y: 90 },
          },
        ],
      },
    })

    const result = applied.result as { results: Array<{ element_id: string }> }
    const document = applied.workspace!.documents[0]!
    expect(result.results[0]!.element_id).toStartWith('text-')
    expect(document.slides[0]!.elements[0]).toMatchObject({
      id: result.results[0]!.element_id,
      type: 'text',
      text: 'Revenue grew 24%',
    })
    expect(document.version).toBe(initial.documents[0]!.version + 1)
    expect(initial.documents[0]!.slides[0]!.elements).toEqual([])
  })

  it('adds animations through the same domain model used by the editor', () => {
    const initial = workspace()
    const slide = initial.documents[0]!.slides[0]!
    const withElement = executePowerPointRequest(initial, {
      method: 'apply',
      params: { operations: [{ type: 'add_element', element: { id: 'headline', type: 'text' } }] },
    }).workspace!
    const animated = executePowerPointRequest(withElement, {
      method: 'apply',
      params: {
        operations: [{
          type: 'add_animation',
          slide_id: slide.id,
          element_id: 'headline',
          effect: 'fade',
          start: 'afterPrevious',
          duration: 0.8,
        }],
      },
    }).workspace!

    expect(animated.documents[0]!.slides[0]!.elements[0]).toMatchObject({
      animation: 'fade',
      animationStart: 'afterPrevious',
      animationDuration: 0.8,
    })
  })

  it('rejects an invalid batch before publishing a replacement workspace', () => {
    const initial = workspace()
    expect(() => executePowerPointRequest(initial, {
      method: 'apply',
      params: {
        operations: [
          { type: 'rename_document', title: 'Changed only in the draft' },
          { type: 'delete_slide' },
        ],
      },
    })).toThrow('must keep at least one slide')
    expect(initial.documents[0]!.title).toBe('Quarterly review')
  })
})
