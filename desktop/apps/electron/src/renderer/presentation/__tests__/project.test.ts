import { describe, expect, it } from 'bun:test'
import { createBlankPresentationProject, createBlankPresentationSlide } from '@/atoms/presentation'
import { createPresentationImageElement } from '@/lib/presentationInsert'
import { editPresentationProject, validatePresentationProject } from '../model/reducer'
import {
  clearPresentationHyperlinksToPages,
  createPresentationAsset,
  detachPresentationCommentsFromElements,
  duplicatePresentationSlide,
  migratePresentationProject,
  normalizePresentationProject,
  presentationAssetsForPages,
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
    const document = createBlankPresentationProject('Project model')
    const page = document.slides.pages[0]!
    const image = createPresentationImageElement(imageSource)
    document.assets = [createPresentationAsset('image', imageSource, image.sourceAssetId)]
    const edited = editPresentationProject(document, {
      ...document,
      slides: { ...document.slides, pages: [{ ...page, elements: [image] }] },
    })

    expect(edited).toMatchObject({ schemaVersion: 1, version: 1 })
    expect(edited).not.toHaveProperty('revision')
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

  it('strips former host and file metadata at the project validation boundary', () => {
    const project = createBlankPresentationProject('Pure model')
    const legacyEnvelope = {
      ...project,
      revision: 9,
      savedRevision: 8,
      source: { path: '/Pure model.pptx', mtimeMs: 42 },
      sourceProtected: true,
    } as typeof project

    const validated = validatePresentationProject(legacyEnvelope)
    expect(validated).toEqual(project)
    expect(validated).not.toHaveProperty('revision')
    expect(validated).not.toHaveProperty('savedRevision')
    expect(validated).not.toHaveProperty('source')
    expect(validated).not.toHaveProperty('sourceProtected')
  })

  it('uses element array order for stacking without a second order representation', () => {
    const document = createBlankPresentationProject('Stacking')
    const page = document.slides.pages[0]!
    const first = { id: 'first', type: 'rect' as const, x: 0, y: 0, width: 10, height: 10, rotation: 0, fill: '#fff', borderColor: '#000', borderWidth: 0 }
    const second = { ...first, id: 'second' }
    const edited = editPresentationProject(document, {
      ...document,
      slides: { ...document.slides, pages: [{ ...page, elements: [second, first] }] },
    })

    expect(edited.slides.pages[0]!.elements.map((element) => element.id)).toEqual(['second', 'first'])
    expect(edited.slides).not.toHaveProperty('elementOrder')
    expect(edited.slides.pages[0]!.elements[0]).not.toHaveProperty('zIndex')
  })

  it('migrates the former flat document without retaining duplicate media payloads', () => {
    const current = createBlankPresentationProject('Legacy')
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
    const migrated = migratePresentationProject(legacy)

    expect(migrated).toMatchObject({ schemaVersion: 1, version: 1 })
    expect(migrated).not.toHaveProperty('revision')
    expect(migrated.theme).toEqual(current.theme)
    expect(migrated.slides.selectedPageId).toBe(page.id)
    expect(migrated.assets).toHaveLength(1)
    expect(() => validatePresentationProject(migrated)).not.toThrow()
  })

  it('does not serialize current asset payloads while normalizing routine edits', () => {
    const document = createBlankPresentationProject('Large assets')
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

  it('retains reusable project assets until a caller explicitly scopes them to pages', () => {
    const document = createBlankPresentationProject('Asset cleanup')
    const page = document.slides.pages[0]!
    const image = { ...createPresentationImageElement(imageSource), sourceAssetId: 'used-asset' }
    document.assets = [
      createPresentationAsset('image', imageSource, 'used-asset'),
      createPresentationAsset('image', { ...imageSource, fileName: 'orphan.png' }, 'orphan-asset'),
    ]
    document.slides.pages = [{ ...page, elements: [image] }]

    const normalized = normalizePresentationProject(document)
    expect(normalized.assets.map((asset) => asset.id)).toEqual(['used-asset', 'orphan-asset'])
    expect(presentationAssetsForPages(normalized.assets, normalized.slides.pages).map((asset) => asset.id)).toEqual(['used-asset'])
    document.slides.pages = [{ ...page, elements: [] }]
    expect(normalizePresentationProject(document).assets.map((asset) => asset.id)).toEqual(['used-asset', 'orphan-asset'])
    expect(presentationAssetsForPages(document.assets, document.slides.pages)).toEqual([])
  })

  it('repairs comments and slide links when their targets are removed', () => {
    const document = createBlankPresentationProject('Relationships')
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
    const document = createBlankPresentationProject('Duplicate')
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
    expect(() => validatePresentationProject({
      ...document,
      slides: { pages: [source, duplicate], slideOrder: [source.id, duplicate.id], selectedPageId: duplicate.id },
    })).not.toThrow()
  })

  it('rejects broken slide ordering at the model boundary', () => {
    const document = createBlankPresentationProject('Invalid')
    expect(() => validatePresentationProject({
      ...document,
      slides: { ...document.slides, slideOrder: ['missing-page'] },
    })).toThrow('slideOrder')
  })

  it('honors slideOrder and commits pages in one canonical order', () => {
    const document = createBlankPresentationProject('Ordered')
    const first = document.slides.pages[0]!
    const second = createBlankPresentationSlide('Second')
    const validated = validatePresentationProject({
      ...document,
      slides: { pages: [first, second], slideOrder: [second.id, first.id], selectedPageId: first.id },
    })

    expect(validated.slides.pages.map((page) => page.id)).toEqual([second.id, first.id])
    expect(validated.slides.slideOrder).toEqual([second.id, first.id])
  })

  it('rejects unsupported project versions instead of silently downgrading them', () => {
    const document = createBlankPresentationProject('Future')
    expect(() => migratePresentationProject({ ...document, schemaVersion: 99 })).toThrow('Unsupported PowerPoint schema version')
    expect(() => migratePresentationProject({ ...document, version: 99 })).toThrow('Unsupported PowerPoint project version')
  })

  it('rejects element kinds that the editor cannot create or render', () => {
    const document = createBlankPresentationProject('Strict elements')
    const page = document.slides.pages[0]!
    const invalid = {
      id: 'unsupported', type: 'unsupported-widget', x: 0, y: 0, width: 10, height: 10, rotation: 0,
    }
    expect(() => validatePresentationProject({
      ...document,
      slides: { ...document.slides, pages: [{ ...page, elements: [invalid as never] }] },
    })).toThrow('slides.pages.0.elements.0')
  })

  it('rejects malformed rich-text ranges and dangling comment targets at the model boundary', () => {
    const document = createBlankPresentationProject('Strict relationships')
    const page = document.slides.pages[0]!
    const text = {
      id: 'copy', type: 'text' as const, text: 'Hello', x: 0, y: 0, width: 100, height: 50, rotation: 0,
      fontSize: 20, fontFamily: 'Aptos', fontWeight: 400 as const, color: '#000000', align: 'left' as const,
      textRuns: [{ start: 2, end: 8, style: { color: '#FF0000' } }],
    }
    expect(() => validatePresentationProject({
      ...document,
      slides: { ...document.slides, pages: [{ ...page, elements: [text] }] },
    })).toThrow('textRuns')
    expect(() => validatePresentationProject({
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
    const document = createBlankPresentationProject('Legacy collision')
    const page = document.slides.pages[0]!
    const legacyImage = (dataUrl: string) => ({
      id: createPresentationImageElement(imageSource).id,
      type: 'image', sourceAssetId: 'shared-asset', source: { ...imageSource, dataUrl },
      altText: '', fit: 'contain', x: 0, y: 0, width: 100, height: 100, rotation: 0,
    })
    expect(() => migratePresentationProject({
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
