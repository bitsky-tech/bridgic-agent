import { describe, expect, it } from 'bun:test'
import { createBlankPresentationDocument, type PresentationWorkspace } from '@/atoms/presentation'
import { executePowerPointRequest } from '../powerPointProtocol'

function workspace(): PresentationWorkspace {
  const document = createBlankPresentationDocument('Quarterly review')
  return { activeDocumentId: document.id, documents: [document] }
}

describe('PowerPoint renderer protocol', () => {
  it('opens a new target with metadata and one blank page summary', async () => {
    const opened = await executePowerPointRequest(workspace(), {
      method: 'view_ppt',
      params: { target: '/workspace/roadmap.pptx', file_name: 'roadmap.pptx' },
    })

    expect(opened.target).toBe('/workspace/roadmap.pptx')
    expect(opened.persist).toBeTrue()
    expect(opened.result).toMatchObject({
      identity: { document_id: expect.any(String), file_name: 'roadmap.pptx' },
      meta: { total_pages: 1, current_position: 1 },
      pages: [{ index: 0, has_content: false }],
      reused: false,
    })

    const reopened = await executePowerPointRequest(opened.workspace!, {
      method: 'view_ppt',
      params: { target: '/workspace/roadmap.pptx', file_name: 'roadmap.pptx' },
    }, { currentTarget: opened.target!, fileName: 'roadmap.pptx' })
    expect(reopened.workspace).toBeUndefined()
    expect(reopened.result).toMatchObject({ reused: true })
  })

  it('reads refs and atomically inserts one native element', async () => {
    const initial = workspace()
    const slideId = initial.documents[0]!.selectedSlideId
    const read = await executePowerPointRequest(initial, {
      method: 'get_ppt_page',
      params: { page_id: slideId },
    })
    const revision = (read.result as { page: { revision: string } }).page.revision
    expect((read.result as { page: { refs: string[] } }).page.refs).toEqual([])
    const applied = await executePowerPointRequest(initial, {
      method: 'insert_ppt_element',
      params: {
        page_id: slideId,
        expected_revision: revision,
        element: '<PptText x="40" y="40" width="600" height="80">Revenue grew 24%</PptText>',
        assets: {},
      },
    })

    const document = applied.workspace!.documents[0]!
    expect(document.slides[0]!.elements[0]).toMatchObject({
      type: 'text',
      text: 'Revenue grew 24%',
    })
    expect(document.version).toBe(initial.documents[0]!.version + 1)
    expect(document.selectedSlideId).toBe(slideId)
    expect(applied.agentChange).toEqual({
      elementIds: [expect.any(String)],
      kind: 'content',
      slideId,
    })
    const result = applied.result as { element_ref: string; page: { markdown: string; refs: string[] } }
    expect(result.page.refs).toEqual([result.element_ref])
    expect(result.page.markdown).toContain(`ref="${result.element_ref}"`)
    expect(initial.documents[0]!.slides[0]!.elements).toEqual([])
  })

  it('edits one referenced element without replacing its identity or siblings', async () => {
    const initial = workspace()
    const slideId = initial.documents[0]!.selectedSlideId
    initial.documents[0]!.slides[0]!.elements = [
      {
        id: 'stable', type: 'text', text: 'Same', x: 20, y: 20, width: 200, height: 60,
        rotation: 0, fontSize: 24, fontFamily: 'Aptos', fontWeight: 400, color: '#111111', align: 'left',
      },
      {
        id: 'changed', type: 'text', text: 'Before', x: 20, y: 100, width: 200, height: 60,
        rotation: 0, fontSize: 24, fontFamily: 'Aptos', fontWeight: 400, color: '#111111', align: 'left',
      },
    ]
    const read = await executePowerPointRequest(initial, {
      method: 'get_ppt_page', params: { page_id: slideId },
    })
    const revision = (read.result as { page: { revision: string } }).page.revision
    const applied = await executePowerPointRequest(initial, {
      method: 'edit_ppt_page',
      params: {
        page_id: slideId,
        expected_revision: revision,
        ref: 'changed',
        replacement: '<PptText ref="changed" x="20" y="100" width="200" height="60" fontSize="24">After</PptText>',
        assets: {},
      },
    })

    expect(applied.agentChange?.elementIds).toEqual(['changed'])
    expect(applied.workspace!.documents[0]!.slides[0]!.elements).toEqual([
      initial.documents[0]!.slides[0]!.elements[0],
      expect.objectContaining({ id: 'changed', text: 'After' }),
    ])
  })

  it('removes one referenced element and rejects an invented ref', async () => {
    const initial = workspace()
    const slide = initial.documents[0]!.slides[0]!
    slide.elements = [{
      id: 'obsolete', type: 'text', text: 'Remove me', x: 20, y: 20, width: 200, height: 60,
      rotation: 0, fontSize: 24, fontFamily: 'Aptos', fontWeight: 400, color: '#111111', align: 'left',
    }]
    const read = await executePowerPointRequest(initial, {
      method: 'get_ppt_page', params: { page_id: slide.id },
    })
    const revision = (read.result as { page: { revision: string } }).page.revision
    const removed = await executePowerPointRequest(initial, {
      method: 'remove_ppt_element',
      params: { page_id: slide.id, ref: 'obsolete', expected_revision: revision },
    })

    expect(removed.workspace!.documents[0]!.slides[0]!.elements).toEqual([])
    expect((removed.result as { element_ref: string }).element_ref).toBe('obsolete')
    await expect(executePowerPointRequest(initial, {
      method: 'remove_ppt_element',
      params: { page_id: slide.id, ref: 'invented', expected_revision: revision },
    })).rejects.toThrow('Unknown PowerPoint element ref')
  })

  it('updates document-wide design with a private document revision', async () => {
    const initial = workspace()
    const overview = await executePowerPointRequest(initial, {
      method: 'view_ppt',
      params: { target: '/workspace/review.pptx', file_name: 'review.pptx' },
    }, { currentTarget: '/workspace/review.pptx', fileName: 'review.pptx' })
    const revision = (overview.result as { document_revision: string }).document_revision
    const applied = await executePowerPointRequest(initial, {
      method: 'update_ppt_design',
      params: {
        expected_document_revision: revision,
        design: {
          theme: 'midnight',
          page_size: 'standard',
          footer: { show_slide_number: true },
          transition: { effect: 'fade', duration_ms: 650, through_black: true },
        },
      },
    })

    const document = applied.workspace!.documents[0]!
    expect(document.master).toMatchObject({
      background: '#17182B',
      bodyFontFamily: 'Aptos',
      titleFontFamily: 'Aptos Display',
    })
    expect(document.pageSize.preset).toBe('standard')
    expect(document.slides[0]).toMatchObject({
      background: '#17182B',
      footer: { showSlideNumber: true },
      transition: { effect: 'fade', durationMs: 650, throughBlack: true },
    })
    expect(applied.agentChange).toMatchObject({ kind: 'design', slideId: document.selectedSlideId })
    expect(applied.persist).toBeTrue()
  })

  it('rejects a stale document-wide design change', async () => {
    const initial = workspace()
    await expect(executePowerPointRequest(initial, {
      method: 'update_ppt_design',
      params: { expected_document_revision: 'stale', design: { theme: 'paper' } },
    })).rejects.toEqual(expect.objectContaining({ code: 'document_changed' }))
  })

  it('rejects a stale page token without publishing a workspace', async () => {
    const initial = workspace()
    const slideId = initial.documents[0]!.selectedSlideId
    await expect(executePowerPointRequest(initial, {
      method: 'insert_ppt_element',
      params: {
        page_id: slideId,
        expected_revision: 'stale',
        element: '<PptText>Changed</PptText>',
      },
    })).rejects.toEqual(expect.objectContaining({ code: 'page_changed' }))
    expect(initial.documents[0]!.slides[0]!.elements).toEqual([])
  })

  it('returns compiler diagnostics without mutating the page', async () => {
    const initial = workspace()
    const slideId = initial.documents[0]!.selectedSlideId
    const read = await executePowerPointRequest(initial, {
      method: 'get_ppt_page', params: { page_id: slideId },
    })
    const revision = (read.result as { page: { revision: string } }).page.revision
    const invalid = await executePowerPointRequest(initial, {
      method: 'insert_ppt_element',
      params: {
        page_id: slideId,
        expected_revision: revision,
        element: '# Not a Ppt element',
      },
    })
    expect(invalid.workspace).toBeUndefined()
    expect(invalid.result).toMatchObject({ status: 'invalid' })
    expect(initial.documents[0]!.slides[0]!.elements).toEqual([])
  })

  it('returns a workspace path for embedded assets without exposing it in Markdown', async () => {
    const initial = workspace()
    const slide = initial.documents[0]!.slides[0]!
    slide.elements = [{
      id: 'hero',
      type: 'image',
      source: { dataUrl: 'data:image/png;base64,cG5n', fileName: 'hero.png', mimeType: 'image/png' },
      altText: 'Hero',
      fit: 'cover',
      x: 20,
      y: 20,
      width: 320,
      height: 180,
      rotation: 0,
    }]

    const read = await executePowerPointRequest(initial, {
      method: 'get_ppt_page', params: { page_id: slide.id },
    })
    const result = read.result as { assets: Array<Record<string, string>>; page: { markdown: string } }
    expect(result.assets[0]).toMatchObject({
      path: '.ppt-assets/hero-hero.png',
      data_url: 'data:image/png;base64,cG5n',
    })
    expect(result.page.markdown).toContain('src="@existing/hero"')
    expect(result.page.markdown).not.toContain('base64')
  })
})
