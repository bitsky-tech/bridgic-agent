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

  it('reads and atomically updates one page from semantic Markdown', async () => {
    const initial = workspace()
    const slideId = initial.documents[0]!.selectedSlideId
    const read = await executePowerPointRequest(initial, {
      method: 'get_ppt_page',
      params: { page_id: slideId },
    })
    const revision = (read.result as { page: { revision: string } }).page.revision
    const applied = await executePowerPointRequest(initial, {
      method: 'update_ppt_page',
      params: {
        page_id: slideId,
        expected_revision: revision,
        markdown: `---\nid: ${slideId}\nname: Results\n---\n\n# Revenue grew 24%`,
        assets: {},
      },
    })

    const document = applied.workspace!.documents[0]!
    expect(document.slides[0]!.elements[0]).toMatchObject({
      type: 'text',
      text: 'Revenue grew 24%',
    })
    expect(document.version).toBe(initial.documents[0]!.version + 1)
    expect(initial.documents[0]!.slides[0]!.elements).toEqual([])
  })

  it('rejects a stale page token without publishing a workspace', async () => {
    const initial = workspace()
    const slideId = initial.documents[0]!.selectedSlideId
    await expect(executePowerPointRequest(initial, {
      method: 'update_ppt_page',
      params: {
        page_id: slideId,
        expected_revision: 'stale',
        markdown: `---\nid: ${slideId}\n---\n\n# Changed`,
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
      method: 'update_ppt_page',
      params: {
        page_id: slideId,
        expected_revision: revision,
        markdown: '# Missing frontmatter',
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
