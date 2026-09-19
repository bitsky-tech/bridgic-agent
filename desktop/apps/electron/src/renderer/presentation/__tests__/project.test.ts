import { describe, expect, it } from 'bun:test'
import { createBlankPresentationDocument, createBlankPresentationSlide } from '@/atoms/presentation'
import { createPresentationImageElement } from '@/lib/presentationInsert'
import { editPresentationDocument, validatePresentationDocument } from '../model/reducer'
import {
  clearPresentationHyperlinksToPages,
  createPresentationAsset,
  detachPresentationCommentsFromElements,
  duplicatePresentationSlide,
  migratePresentationDocument,
  normalizePresentationProject,
  presentationElementSource,
  presentationProjectOf,
} from '../project'
import { presentationProjectSchema } from '../schema'

const imageSource = {
  dataUrl: 'data:image/png;base64,iVBORw==',
  fileName: 'cover.png',
  mimeType: 'image/png',
}

describe('PresentationProject model', () => {
  it('stores order under slides and media once under assets', () => {
    const document = createBlankPresentationDocument('Project model')
    const page = document.slides.pages[0]!
    const image = createPresentationImageElement(imageSource)
    document.assets = [createPresentationAsset('image', imageSource, image.sourceAssetId)]
    const edited = editPresentationDocument(document, {
      ...document,
      slides: { ...document.slides, pages: [{ ...page, elements: [image] }] },
    })

    expect(edited).toMatchObject({ schemaVersion: 1, version: 1, revision: 2 })
    expect(edited.slides.slideOrder).toEqual([page.id])
    expect(edited.assets).toHaveLength(1)
    expect(edited.slides.pages[0]!.elements[0]).toMatchObject({ sourceAssetId: edited.assets[0]!.id })
    expect(edited.slides.pages[0]!.elements[0]).not.toHaveProperty('source')
    expect(presentationElementSource(edited, edited.slides.pages[0]!.elements[0] as typeof image)).toEqual({
      ...edited.assets[0]!.source,
      assetId: edited.assets[0]!.id,
    })
    expect(presentationProjectSchema.safeParse(presentationProjectOf(edited)).success).toBe(true)
  })

  it('uses element array order for stacking without a second order representation', () => {
    const document = createBlankPresentationDocument('Stacking')
    const page = document.slides.pages[0]!
    const first = { id: 'first', type: 'rect' as const, x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: '#fff', borderColor: '#000', borderWidth: 0 }
    const second = { ...first, id: 'second' }
    const edited = editPresentationDocument(document, {
      ...document,
      slides: { ...document.slides, pages: [{ ...page, elements: [second, first] }] },
    })

    expect(edited.slides.pages[0]!.elements.map((element) => element.id)).toEqual(['second', 'first'])
    expect(edited.slides).not.toHaveProperty('elementOrder')
    expect(edited.slides.pages[0]!.elements[0]).not.toHaveProperty('zIndex')
  })

  it('migrates the former flat document without retaining duplicate media payloads', () => {
    const current = createBlankPresentationDocument('Legacy')
    const page = current.slides.pages[0]!
    const legacy = {
      id: current.id,
      master: current.theme,
      pageSize: current.pageSize,
      selectedSlideId: page.id,
      slides: [{ ...page, elements: [{ ...createPresentationImageElement(imageSource), source: imageSource } as never] }],
      title: current.title,
      version: 7,
    }
    const migrated = migratePresentationDocument(legacy)

    expect(migrated).toMatchObject({ schemaVersion: 1, version: 1, revision: 7 })
    expect(migrated.theme).toEqual(current.theme)
    expect(migrated.slides.selectedPageId).toBe(page.id)
    expect(migrated.assets).toHaveLength(1)
    expect(() => validatePresentationDocument(migrated)).not.toThrow()
  })

  it('does not serialize current asset payloads while normalizing routine edits', () => {
    const document = createBlankPresentationDocument('Large assets')
    const page = document.slides.pages[0]!
    const image = { ...createPresentationImageElement(imageSource), sourceAssetId: 'large-asset' }
    let payloadReads = 0
    const source = { fileName: 'large.png', mimeType: 'image/png' } as typeof imageSource
    Object.defineProperty(source, 'dataUrl', {
      enumerable: true,
      get: () => {
        payloadReads += 1
        return 'data:image/png;base64,large-payload'
      },
    })
    document.assets = [{ id: 'large-asset', kind: 'image', name: source.fileName, source }]
    document.slides.pages = [{ ...page, elements: [image] }]

    expect(normalizePresentationProject(document)).toBe(document)
    expect(payloadReads).toBe(0)
  })

  it('prunes assets after their last media element is removed', () => {
    const document = createBlankPresentationDocument('Asset cleanup')
    const page = document.slides.pages[0]!
    const image = { ...createPresentationImageElement(imageSource), sourceAssetId: 'used-asset' }
    document.assets = [
      createPresentationAsset('image', imageSource, 'used-asset'),
      createPresentationAsset('image', { ...imageSource, fileName: 'orphan.png' }, 'orphan-asset'),
    ]
    document.slides.pages = [{ ...page, elements: [image] }]

    expect(normalizePresentationProject(document).assets.map((asset) => asset.id)).toEqual(['used-asset'])
    document.slides.pages = [{ ...page, elements: [] }]
    expect(normalizePresentationProject(document).assets).toEqual([])
  })

  it('repairs comments and slide links when their targets are removed', () => {
    const document = createBlankPresentationDocument('Relationships')
    const first = document.slides.pages[0]!
    const second = createBlankPresentationSlide('Second')
    const linked = {
      id: 'linked', type: 'rect' as const, x: 0, y: 0, width: 10, height: 10, rotation: 0,
      fill: '#fff', borderColor: '#000', borderWidth: 0, hyperlink: { type: 'slide' as const, slideId: second.id },
    }
    const reviewed = {
      ...first,
      elements: [linked],
      comments: [{ id: 'comment', author: 'Reviewer', createdAt: new Date(0).toISOString(), resolved: false, text: 'Review', elementId: linked.id }],
    }

    const detached = detachPresentationCommentsFromElements(reviewed, new Set([linked.id]))
    expect(detached.comments?.[0]).not.toHaveProperty('elementId')
    expect(detached.comments?.[0]?.text).toBe('Review')
    const pages = clearPresentationHyperlinksToPages([detached, second], new Set([second.id]))
    expect(pages[0]!.elements[0]).not.toHaveProperty('hyperlink')
  })

  it('duplicates comments with independent identities and remapped element targets', () => {
    const document = createBlankPresentationDocument('Duplicate')
    const slide = document.slides.pages[0]!
    const element = {
      id: 'reviewed', type: 'rect' as const, x: 0, y: 0, width: 10, height: 10, rotation: 0,
      fill: '#fff', borderColor: '#000', borderWidth: 0,
    }
    const source = {
      ...slide,
      elements: [element],
      comments: [{ id: 'comment', author: 'Reviewer', createdAt: new Date(0).toISOString(), resolved: false, text: 'Review', elementId: element.id }],
    }
    const duplicate = duplicatePresentationSlide(source, 'Copy')

    expect(duplicate.id).not.toBe(source.id)
    expect(duplicate.elements[0]!.id).not.toBe(element.id)
    expect(duplicate.comments?.[0]!.id).not.toBe(source.comments[0]!.id)
    expect(duplicate.comments?.[0]!.elementId).toBe(duplicate.elements[0]!.id)
    expect(() => validatePresentationDocument({
      ...document,
      slides: { pages: [source, duplicate], slideOrder: [source.id, duplicate.id], selectedPageId: duplicate.id },
    })).not.toThrow()
  })

  it('rejects broken slide ordering at the model boundary', () => {
    const document = createBlankPresentationDocument('Invalid')
    expect(() => validatePresentationDocument({
      ...document,
      slides: { ...document.slides, slideOrder: ['missing-page'] },
    })).toThrow('slideOrder')
  })

  it('honors slideOrder and commits pages in one canonical order', () => {
    const document = createBlankPresentationDocument('Ordered')
    const first = document.slides.pages[0]!
    const second = createBlankPresentationSlide('Second')
    const validated = validatePresentationDocument({
      ...document,
      slides: { pages: [first, second], slideOrder: [second.id, first.id], selectedPageId: first.id },
    })

    expect(validated.slides.pages.map((page) => page.id)).toEqual([second.id, first.id])
    expect(validated.slides.slideOrder).toEqual([second.id, first.id])
  })

  it('rejects unsupported project versions instead of silently downgrading them', () => {
    const document = createBlankPresentationDocument('Future')
    expect(() => migratePresentationDocument({ ...document, schemaVersion: 99 })).toThrow('Unsupported PowerPoint schema version')
    expect(() => migratePresentationDocument({ ...document, version: 99 })).toThrow('Unsupported PowerPoint project version')
  })

  it('rejects element kinds that the editor cannot create or render', () => {
    const document = createBlankPresentationDocument('Strict elements')
    const page = document.slides.pages[0]!
    const invalid = {
      id: 'unsupported', type: 'unsupported-widget', x: 0, y: 0, width: 10, height: 10, rotation: 0,
    }
    expect(() => validatePresentationDocument({
      ...document,
      slides: { ...document.slides, pages: [{ ...page, elements: [invalid as never] }] },
    })).toThrow('slides.pages.0.elements.0')
  })

  it('rejects malformed rich-text ranges and dangling comment targets at the model boundary', () => {
    const document = createBlankPresentationDocument('Strict relationships')
    const page = document.slides.pages[0]!
    const text = {
      id: 'copy', type: 'text' as const, text: 'Hello', x: 0, y: 0, width: 100, height: 50, rotation: 0,
      fontSize: 20, fontFamily: 'Aptos', fontWeight: 400 as const, color: '#000000', align: 'left' as const,
      textRuns: [{ start: 2, end: 8, style: { color: '#FF0000' } }],
    }
    expect(() => validatePresentationDocument({
      ...document,
      slides: { ...document.slides, pages: [{ ...page, elements: [text] }] },
    })).toThrow('textRuns')
    expect(() => validatePresentationDocument({
      ...document,
      slides: {
        ...document.slides,
        pages: [{
          ...page,
          comments: [{ id: 'comment', author: 'Reviewer', createdAt: new Date(0).toISOString(), resolved: false, text: 'Missing', elementId: 'missing' }],
        }],
      },
    })).toThrow('elementId')
  })

  it('rejects conflicting legacy media that reuse one asset identity', () => {
    const document = createBlankPresentationDocument('Legacy collision')
    const page = document.slides.pages[0]!
    const legacyImage = (dataUrl: string) => ({
      id: createPresentationImageElement(imageSource).id,
      type: 'image', sourceAssetId: 'shared-asset', source: { ...imageSource, dataUrl },
      altText: '', fit: 'contain', x: 0, y: 0, width: 100, height: 100, rotation: 0,
    })
    expect(() => migratePresentationDocument({
      id: document.id,
      master: document.theme,
      pageSize: document.pageSize,
      selectedSlideId: page.id,
      slides: [{ ...page, elements: [legacyImage('data:image/png;base64,YQ=='), legacyImage('data:image/png;base64,Yg==')] }],
      title: document.title,
      version: 1,
    })).toThrow('identity collision')
  })
})
