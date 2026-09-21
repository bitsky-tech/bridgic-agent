import { describe, expect, it } from 'bun:test'
import {
  createBlankPresentationProject,
  createBlankPresentationSlide,
} from '@/atoms/presentation'
import { createPresentationAsset } from '@/presentation/project'
import { executePowerPointRequest, type PowerPointProjectCollection } from '../powerPointProtocol'

function workspace(): PowerPointProjectCollection {
  const document = createBlankPresentationProject('Quarterly review')
  return { activeProjectId: document.id, projects: [document] }
}

async function readDeck(state: PowerPointProjectCollection) {
  const document = state.projects[0]!
  return executePowerPointRequest(state, { method: 'read_deck', params: { document_id: document.id, include_theme: true } })
}

async function readPage(state: PowerPointProjectCollection, pageId: string, format = 'compact') {
  const document = state.projects[0]!
  return executePowerPointRequest(state, { method: 'read_page', params: { document_id: document.id, page_id: pageId, format } })
}

describe('PowerPoint renderer protocol', () => {
  it('opens a new target and reuses the exact Session document', async () => {
    const opened = await executePowerPointRequest(workspace(), {
      method: 'open', params: { target: '/workspace/roadmap.pptx', file_name: 'roadmap.pptx' },
    })
    expect(opened.target).toBe('/workspace/roadmap.pptx')
    expect(opened.result).toMatchObject({
      revision: expect.any(String),
      deck: { id: expect.any(String), file_name: 'roadmap.pptx', total_pages: 1, pages: [{ index: 0, has_content: false }] },
      reused: false,
    })
    const reopened = await executePowerPointRequest(opened.projects!, {
      method: 'open', params: { target: '/workspace/roadmap.pptx', file_name: 'roadmap.pptx' },
    }, { currentTarget: opened.target! })
    expect(reopened.projects).toBeUndefined()
    expect(reopened.result).toMatchObject({ reused: true })
  })

  it('reports the requested document file name independently of the active tab', async () => {
    const first = createBlankPresentationProject('First')
    const second = createBlankPresentationProject('Second')
    const initial = { activeProjectId: second.id, projects: [first, second] }
    const result = await executePowerPointRequest(initial, {
      method: 'read_deck', params: { document_id: first.id },
    }, { currentTarget: '/workspace/second.pptx', fileNameOf: (projectId) => projectId === first.id ? 'first.pptx' : 'second.pptx' })
    expect(result.result).toMatchObject({ deck: { id: first.id, file_name: 'first.pptx' } })
    expect(result.projects?.activeProjectId).toBe(first.id)
  })

  it('offers compact Markdown and an exact structured model without using Markdown for edits', async () => {
    const initial = workspace()
    const slide = initial.projects[0]!.slides.pages[0]!
    slide.elements = [{
      id: 'title', type: 'text', text: 'Before', x: 37, y: 91, width: 620, height: 110, rotation: 4,
      fontSize: 44, fontFamily: 'Arial', fontWeight: 700, color: '#112233', align: 'center',
    }]
    slide.comments = [{ id: 'review', author: 'Reviewer', createdAt: new Date(0).toISOString(), resolved: false, text: 'Tighten this', elementId: 'title' }]
    const compact = await readPage(initial, slide.id)
    expect((compact.result as { page: { markdown: string } }).page.markdown).toContain('<PptText ref="title">')
    const model = await readPage(initial, slide.id, 'model')
    expect(model.result).toMatchObject({ page: { model: {
      comments: [{ id: 'review', text: 'Tighten this', elementId: 'title' }],
      elements: [{ id: 'title', x: 37, fontSize: 44 }],
    } } })
  })

  it('patches native elements while preserving every omitted property', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    slide.elements = [{
      id: 'title', type: 'text', text: 'Before', x: 37, y: 91, width: 620, height: 110, rotation: 4,
      fontSize: 44, fontFamily: 'Arial', fontWeight: 700, color: '#112233', align: 'center',
      textInsets: { left: 5, top: 6, right: 7, bottom: 8 },
    }]
    const read = await readPage(initial, slide.id)
    const revision = (read.result as { revision: string }).revision
    const updated = await executePowerPointRequest(initial, { method: 'edit_page', params: {
      document_id: document.id, page_id: slide.id, expected_revision: revision,
      operations: [{ type: 'patch', id: 'title', element_type: 'text', patch: { text: 'After', x: 55 } }],
    } })
    expect(updated.projects!.projects[0]!.slides.pages[0]!.elements[0]).toMatchObject({
      id: 'title', text: 'After', x: 55, y: 91, width: 620, fontSize: 44,
      textInsets: { left: 5, top: 6, right: 7, bottom: 8 },
    })
  })

  it('keeps an explicit fill opacity when an Agent replaces a gradient fill', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    slide.elements = [{
      id: 'accent', type: 'rect', x: 10, y: 10, width: 100, height: 60, rotation: 0,
      fill: '#FF0000', borderColor: 'transparent', borderWidth: 0,
      gradientFill: { type: 'linear', angle: 0, stops: [
        { offset: 0, color: '#FF0000', opacity: 1 },
        { offset: 1, color: '#0000FF', opacity: 1 },
      ] },
    }]
    const read = await readPage(initial, slide.id)
    const updated = await executePowerPointRequest(initial, { method: 'edit_page', params: {
      document_id: document.id, page_id: slide.id,
      expected_revision: (read.result as { revision: string }).revision,
      operations: [{ type: 'patch', id: 'accent', element_type: 'rect', patch: { fill: '#00FF00', fillOpacity: 0.35 } }],
    } })
    expect(updated.projects!.projects[0]!.slides.pages[0]!.elements[0]).toMatchObject({ fill: '#00FF00', fillOpacity: 0.35 })
    expect(updated.projects!.projects[0]!.slides.pages[0]!.elements[0]).not.toHaveProperty('gradientFill')
  })

  it('adds, patches, and removes comments atomically', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    slide.elements = [{
      id: 'title', type: 'text', text: 'Title', x: 37, y: 91, width: 620, height: 110, rotation: 0,
      fontSize: 44, fontFamily: 'Arial', fontWeight: 700, color: '#112233', align: 'center',
    }]
    slide.comments = [{ id: 'obsolete', author: 'Reviewer', createdAt: new Date(0).toISOString(), resolved: false, text: 'Remove me' }]
    const read = await readPage(initial, slide.id)
    const updated = await executePowerPointRequest(initial, { method: 'edit_page', params: {
      document_id: document.id,
      page_id: slide.id,
      expected_revision: (read.result as { revision: string }).revision,
      operations: [
        { type: 'add-comment', comment: { id: 'review', text: 'Tighten this', elementId: 'title' } },
        { type: 'patch-comment', id: 'review', patch: { text: 'Looks good', resolved: true, elementId: null } },
        { type: 'remove-comment', id: 'obsolete' },
      ],
    } })
    expect(updated.projects!.projects[0]!.slides.pages[0]!.comments).toEqual([
      expect.objectContaining({ id: 'review', author: 'Agent', resolved: true, text: 'Looks good' }),
    ])
    expect(updated.projects!.projects[0]!.slides.pages[0]!.comments![0]).not.toHaveProperty('elementId')
  })

  it('rejects an element patch whose declared type does not match the live element', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    slide.elements = [{
      id: 'title', type: 'text', text: 'Title', x: 37, y: 91, width: 620, height: 110, rotation: 0,
      fontSize: 44, fontFamily: 'Arial', fontWeight: 700, color: '#112233', align: 'center',
    }]
    const read = await readPage(initial, slide.id)
    await expect(executePowerPointRequest(initial, { method: 'edit_page', params: {
      document_id: document.id,
      page_id: slide.id,
      expected_revision: (read.result as { revision: string }).revision,
      operations: [{ type: 'patch', id: 'title', element_type: 'image', patch: { altText: 'Nope' } }],
    } })).rejects.toThrow('title is text, not image')
    await expect(executePowerPointRequest(initial, { method: 'edit_page', params: {
      document_id: document.id,
      page_id: slide.id,
      expected_revision: (read.result as { revision: string }).revision,
      operations: [{ type: 'patch', id: 'title', element_type: 'text', patch: { fill: '#FF0000' } }],
    } })).rejects.toThrow('Unsupported patch.patch property: fill')
  })

  it('applies deck design, insertion, movement, and deletion as one transaction', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const cover = document.slides.pages[0]!
    cover.id = 'cover'
    const obsolete = createBlankPresentationSlide('Obsolete')
    obsolete.id = 'obsolete'
    document.slides = { pages: [cover, obsolete], slideOrder: ['cover', 'obsolete'], selectedPageId: 'cover' }
    const read = await readDeck(initial)
    const revision = (read.result as { revision: string }).revision
    const result = await executePowerPointRequest(initial, { method: 'manage_deck', params: {
      document_id: document.id,
      expected_revision: revision,
      operations: [
        { type: 'set-design', patch: { title: 'Updated deck', theme: 'midnight' } },
        { type: 'insert-page', page: { id: 'evidence', name: 'Evidence' }, after: 'cover' },
        { type: 'remove-page', pageId: 'obsolete' },
      ],
    } })
    const next = result.projects!.projects[0]!
    expect(next.title).toBe('Updated deck')
    expect(next.theme.background).toBe('#17182B')
    expect(next.slides.pages.map((page) => page.id)).toEqual(['cover', 'evidence'])
    expect(result.result).toMatchObject({ status: 'ready', changed_page_ids: expect.arrayContaining(['cover', 'obsolete', 'evidence']) })
  })

  it('merges a partial deck transition with the selected page transition', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    slide.transition = { effect: 'reveal', durationMs: 750, direction: 'left', throughBlack: true }
    const read = await readDeck(initial)
    const result = await executePowerPointRequest(initial, { method: 'manage_deck', params: {
      document_id: document.id,
      expected_revision: (read.result as { revision: string }).revision,
      operations: [{ type: 'set-design', patch: { transition: { durationMs: 1250 } } }],
    } })
    expect(result.projects!.projects[0]!.slides.pages[0]!.transition).toEqual({
      effect: 'reveal', durationMs: 1250, direction: 'left', throughBlack: true,
    })
  })

  it('does not publish a partial workspace when any operation is invalid', async () => {
    const initial = workspace()
    const original = structuredClone(initial)
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    const read = await readPage(initial, slide.id)
    await expect(executePowerPointRequest(initial, { method: 'edit_page', params: {
      document_id: document.id,
      page_id: slide.id,
      expected_revision: (read.result as { revision: string }).revision,
      operations: [
        { type: 'add', element: { id: 'valid', type: 'text', text: 'Valid' } },
        { type: 'add', element: { id: 'broken', type: 'not-a-shape' } },
      ],
    } })).rejects.toThrow('Unsupported PowerPoint element type')
    expect(initial).toEqual(original)
  })

  it('rejects stale page and deck revisions before applying commands', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    await expect(executePowerPointRequest(initial, { method: 'edit_page', params: {
      document_id: document.id, page_id: slide.id, expected_revision: 'stale',
      operations: [{ type: 'set-page', patch: { name: 'Nope' } }],
    } })).rejects.toEqual(expect.objectContaining({ code: 'page_changed' }))
    await expect(executePowerPointRequest(initial, { method: 'manage_deck', params: {
      document_id: document.id, expected_revision: 'stale',
      operations: [{ type: 'set-design', patch: { title: 'Nope' } }],
    } })).rejects.toEqual(expect.objectContaining({ code: 'document_changed' }))
  })

  it('supports validation without publishing or incrementing a revision', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    const read = await readPage(initial, slide.id)
    const revision = (read.result as { revision: string }).revision
    const result = await executePowerPointRequest(initial, { method: 'edit_page', params: {
      document_id: document.id, page_id: slide.id, expected_revision: revision,
      operations: [{ type: 'set-page', patch: { name: 'Validated' } }], validate_only: true,
    } })
    expect(result.projects).toBeUndefined()
    expect(result.result).toMatchObject({ status: 'validated' })
    expect(document.slides.pages[0]!.name).not.toBe('Validated')
  })

  it('clears optional properties and detaches comments through explicit commands', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    slide.background = '#123456'
    slide.elements = [{ id: 'remove', type: 'text', text: 'Remove', x: 20, y: 20, width: 200, height: 60,
      rotation: 0, fontSize: 24, fontFamily: 'Aptos', fontWeight: 400, color: '#111111', align: 'left' }]
    slide.comments = [{ id: 'comment', author: 'Reviewer', createdAt: new Date(0).toISOString(), resolved: false, text: 'Keep', elementId: 'remove' }]
    const read = await readPage(initial, slide.id)
    const result = await executePowerPointRequest(initial, { method: 'edit_page', params: {
      document_id: document.id, page_id: slide.id, expected_revision: (read.result as { revision: string }).revision,
      operations: [{ type: 'set-page', patch: { background: null } }, { type: 'remove', id: 'remove' }],
    } })
    const next = result.projects!.projects[0]!.slides.pages[0]!
    expect(next.background).toBeUndefined()
    expect(next.elements).toEqual([])
    expect(next.comments?.[0]).not.toHaveProperty('elementId')
  })

  it('selects an exact live page for rendering and returns embedded assets safely', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const first = document.slides.pages[0]!
    const second = createBlankPresentationSlide('Second')
    document.slides = { pages: [first, second], slideOrder: [first.id, second.id], selectedPageId: first.id }
    document.assets = [createPresentationAsset('image', {
      dataUrl: 'data:image/png;base64,cG5n', fileName: 'hero.png', mimeType: 'image/png',
    }, 'hero-asset')]
    second.elements = [{ id: 'hero', type: 'image', sourceAssetId: 'hero-asset', altText: 'Hero', fit: 'cover', x: 20, y: 20, width: 320, height: 180, rotation: 0 }]
    const rendered = await executePowerPointRequest(initial, { method: 'inspect', params: { document_id: document.id, kind: 'render', page_id: second.id } })
    expect(rendered.result).toMatchObject({ document_revision: 1, page_id: second.id, index: 1, revision: expect.any(String) })
    expect(rendered.projects!.projects[0]!.slides.selectedPageId).toBe(second.id)
    const read = await readPage(initial, second.id, 'both')
    expect(read.result).toMatchObject({ assets: [{ path: '.ppt-assets/hero-asset-hero.png', data_url: 'data:image/png;base64,cG5n' }] })
    expect(read.result).toMatchObject({ page: { model: { elements: [{ id: 'hero', src: '.ppt-assets/hero-asset-hero.png' }] } } })
    expect(JSON.stringify(read.result)).not.toContain('sourceAssetId')
  })

  it('projects source-backed text through the same asset contract as media', async () => {
    const initial = workspace()
    const document = initial.projects[0]!
    const slide = document.slides.pages[0]!
    document.assets = [createPresentationAsset('text', {
      dataUrl: 'data:text/plain;base64,SGVsbG8=', fileName: 'speaker-notes.txt', mimeType: 'text/plain',
    }, 'text-asset')]
    slide.elements = [{
      id: 'source-text', type: 'text', sourceAssetId: 'text-asset', text: 'Hello', x: 20, y: 20,
      width: 320, height: 80, rotation: 0, fontSize: 24, fontFamily: 'Aptos', fontWeight: 400,
      color: '#111111', align: 'left',
    }]

    const read = await readPage(initial, slide.id, 'both')
    expect(read.result).toMatchObject({
      assets: [{ path: '.ppt-assets/text-asset-speaker-notes.txt', data_url: 'data:text/plain;base64,SGVsbG8=' }],
      page: { model: { elements: [{ id: 'source-text', src: '.ppt-assets/text-asset-speaker-notes.txt', text: 'Hello' }] } },
    })
    expect((read.result as { page: { markdown: string } }).page.markdown).toContain('<PptText ref="source-text" src="@existing/source-text">')
    expect(JSON.stringify(read.result)).not.toContain('sourceAssetId')
  })
})
