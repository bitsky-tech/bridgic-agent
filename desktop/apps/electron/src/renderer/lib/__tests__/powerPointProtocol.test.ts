import { describe, expect, it } from 'bun:test'
import { createBlankPresentationDocument, type PresentationWorkspace } from '@/atoms/presentation'
import { executePowerPointRequest } from '../powerPointProtocol'
import { presentationTextStyleAt } from '../presentationText'

function workspace(): PresentationWorkspace {
  const document = createBlankPresentationDocument('Quarterly review')
  return { activeDocumentId: document.id, documents: [document] }
}

describe('PowerPoint renderer protocol', () => {
  it('respects explicit Agent run sizes alongside base formatting and retains numbering through later edits', async () => {
    const initial = workspace()
    const slide = initial.documents[0]!.slides[0]!
    slide.elements = [{ id: 'rich', type: 'text', text: '标题 English', x: 20, y: 20, width: 600, height: 120, rotation: 0,
      fontSize: 40, fontFamily: 'Arial', fontWeight: 700, color: '#111111', align: 'left',
      textRuns: [{ start: 3, end: 10, style: { fontSize: 20, fontWeight: 400, color: '#0088CC' } }],
    }]
    const read = await executePowerPointRequest(initial, { method: 'get_ppt_page', params: { page_id: slide.id } })
    const page = (read.result as { page: { markdown: string; revision: string } }).page
    const runs = JSON.stringify([{ start: 3, end: 10, style: { fontSize: 40, fontWeight: 400, color: '#0088CC', opacity: 0.25 } }]).replaceAll('"', '&quot;')
    const paragraphs = JSON.stringify([{ start: 0, end: 10, style: { listStyle: 'number', listStartAt: 9, listNumberFormat: 'romanUcPeriod' } }]).replaceAll('"', '&quot;')
    const replacement = page.markdown.match(/<PptText\b[\s\S]*?<\/PptText>/)![0]
      .replace('fontSize="40"', 'fontSize="80"').replace(/textRuns="[^"]*"/, `textRuns="${runs}" paragraphs="${paragraphs}"`)
    const result = await executePowerPointRequest(initial, { method: 'edit_ppt_page', params: {
      page_id: slide.id, ref: 'rich', expected_revision: page.revision, replacement,
    } })
    const text = result.workspace?.documents[0]?.slides[0]?.elements[0]
    if (text?.type !== 'text') throw new Error(JSON.stringify(result.result))
    expect(presentationTextStyleAt(text, 3)).toMatchObject({ fontSize: 40, fontWeight: 400, color: '#0088CC' })
    expect(text.paragraphs?.[0]?.style.listStartAt).toBe(9)
    expect(text.paragraphs?.[0]?.style.listNumberFormat).toBe('romanUcPeriod')
    expect(presentationTextStyleAt(text, 3).opacity).toBe(0.25)
    const updated = await executePowerPointRequest(result.workspace!, { method: 'get_ppt_page', params: { page_id: slide.id } })
    expect((updated.result as { page: { markdown: string } }).page.markdown).toContain('listStartAt&quot;:9')
  })
  it('keeps middle run and paragraph formatting when the Agent changes several separated words', async () => {
    const initial = workspace()
    const slide = initial.documents[0]!.slides[0]!
    slide.elements = [{
      id: 'rich', type: 'text', text: '标题 English 结尾\n正文', x: 20, y: 20, width: 500, height: 200, rotation: 0,
      fontSize: 40, fontFamily: 'Arial', fontWeight: 700, color: '#111111', align: 'left', lineSpacing: 48,
      textRuns: [{ start: 3, end: 10, style: { fontSize: 20, fontWeight: 400, color: '#0088CC' } }],
      paragraphs: [{ start: 0, end: 13, style: { align: 'center', lineSpacing: 48 } },
        { start: 14, end: 16, style: { align: 'right', lineSpacing: 28, spaceBefore: 12 } }],
    }]
    const read = await executePowerPointRequest(initial, { method: 'get_ppt_page', params: { page_id: slide.id } })
    const page = (read.result as { page: { markdown: string; revision: string } }).page
    expect(page.markdown).toContain('paragraphs=')
    for (const omitAttributes of [false, true]) {
      let replacement = page.markdown.match(/<PptText\b[\s\S]*?<\/PptText>/)![0].replace('标题', '新标题').replace('结尾', '新结尾').replace('正文', '新正文')
      if (omitAttributes) replacement = replacement.replace(/ (textRuns|paragraphs)="[^"]*"/g, '')
      const edited = await executePowerPointRequest(initial, { method: 'edit_ppt_page', params: {
        page_id: slide.id, ref: 'rich', expected_revision: page.revision, replacement,
      } })
      const text = edited.workspace?.documents[0]?.slides[0]?.elements[0]
      if (text?.type !== 'text') throw new Error(JSON.stringify(edited.result))
      expect(presentationTextStyleAt(text, 4)).toMatchObject({ fontSize: 20, fontWeight: 400, color: '#0088CC' })
      expect(text.paragraphs).toEqual([
        { start: 0, end: 15, style: expect.objectContaining({ align: 'center', lineSpacing: 48 }) },
        { start: 16, end: 19, style: expect.objectContaining({ align: 'right', lineSpacing: 28, spaceBefore: 12 }) },
      ])
    }
  })

  it('retains authored blank-line size when the Agent edits the surrounding text', async () => {
    const initial = workspace()
    const slide = initial.documents[0]!.slides[0]!
    slide.elements = [{ id: 'blank-lines', type: 'text', text: 'Before\n\nAfter', x: 0, y: 0, width: 600, height: 400, rotation: 0,
      fontSize: 32, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left',
      paragraphs: [{ start: 0, end: 6, style: {} }, { start: 7, end: 7, style: {}, endStyle: { fontSize: 128 } }, { start: 8, end: 13, style: {} }],
    }]
    const read = await executePowerPointRequest(initial, { method: 'get_ppt_page', params: { page_id: slide.id } })
    const page = (read.result as { page: { markdown: string; revision: string } }).page
    for (const omitAttributes of [false, true]) {
      let replacement = page.markdown.match(/<PptText\b[\s\S]*?<\/PptText>/)![0].replace('Before', 'New Before').replace('After', 'New After')
      if (omitAttributes) replacement = replacement.replace(/ paragraphs="[^"]*"/g, '')
      const edited = await executePowerPointRequest(initial, { method: 'edit_ppt_page', params: { page_id: slide.id, ref: 'blank-lines', expected_revision: page.revision, replacement } })
      expect(edited.workspace?.documents[0]?.slides[0]?.elements[0]).toMatchObject({ text: 'New Before\n\nNew After',
        paragraphs: [{ start: 0, end: 10 }, { start: 11, end: 11, endStyle: { fontSize: 128 } }, { start: 12, end: 21 }],
      })
    }
  })

  it('rejects malformed paragraph partitions and styles without mutating the document', async () => {
    const initial = workspace()
    const slide = initial.documents[0]!.slides[0]!
    const read = await executePowerPointRequest(initial, { method: 'get_ppt_page', params: { page_id: slide.id } })
    for (const paragraphs of [[], [{ start: 1, end: 4, style: {} }], [{ start: 0, end: 99, style: {} }],
      [{ start: 0, end: 4, style: { lineSpacing: -1 } }], [{ start: 0, end: 4, style: { align: 'invalid' } }],
      [{ start: 0, end: 1, style: {} }, { start: 2, end: 4, style: {} }],
      ...[null, { fontSize: -1 }, { opacity: 2 }, { fontFamily: 12 }].map(endStyle => [{ start: 0, end: 4, style: {}, endStyle }]),
      ...[0, -1, 1.5, 32768, '5'].map(listStartAt => [{ start: 0, end: 4, style: { listStartAt } }])]) {
      const serialized = JSON.stringify(paragraphs).replaceAll('"', '&quot;')
      const result = await executePowerPointRequest(initial, { method: 'insert_ppt_element', params: {
        page_id: slide.id, expected_revision: (read.result as { page: { revision: string } }).page.revision,
        element: `<PptText paragraphs="${serialized}">Text</PptText>`,
      } })
      expect(result.result).toMatchObject({ status: 'invalid' })
      expect(result.workspace).toBeUndefined()
    }
    expect(slide.elements).toEqual([])
  })

  it('preserves rich text through agent moves, source edits and explicit frame formatting', async () => {
    const initial = workspace()
    const slide = initial.documents[0]!.slides[0]!
    slide.elements = [{
      id: 'rich-text', type: 'text', text: '标题 English', x: 20, y: 100, width: 400, height: 100, rotation: 0,
      fontSize: 40, fontFamily: 'Arial', fontWeight: 700, color: '#111111', align: 'left', lineSpacing: 48,
      textRuns: [{ start: 3, end: 10, style: { fontSize: 20, fontWeight: 400, color: '#0088CC' } }],
    }]
    const readPage = async (state: PresentationWorkspace) => {
      const read = await executePowerPointRequest(state, { method: 'get_ppt_page', params: { page_id: slide.id } })
      return (read.result as { page: { markdown: string; revision: string } }).page
    }
    const change = async (state: PresentationWorkspace, transform: (markdown: string) => string) => {
      const page = await readPage(state)
      const element = page.markdown.match(/<PptText\b[\s\S]*?<\/PptText>/)![0]
      const result = await executePowerPointRequest(state, { method: 'edit_ppt_page', params: {
        page_id: slide.id, ref: 'rich-text', expected_revision: page.revision, replacement: transform(element),
      } })
      expect(result.workspace).toBeDefined()
      return result.workspace!
    }
    expect((await readPage(initial)).markdown).toContain('textRuns=')
    const moved = await change(initial, markdown => markdown.replace('x="20"', 'x="35"'))
    const movedText = moved.documents[0]!.slides[0]!.elements[0]!
    expect(movedText).toMatchObject({ x: 35, lineSpacing: 48 })
    if (movedText.type !== 'text') throw new Error('Expected text')
    expect(presentationTextStyleAt(movedText, 3)).toMatchObject({ fontSize: 20, color: '#0088CC', fontWeight: 400 })
    const edited = await change(moved, markdown => markdown.replace('标题 English', '新标题 English'))
    const editedText = edited.documents[0]!.slides[0]!.elements[0]!
    if (editedText.type !== 'text') throw new Error('Expected text')
    expect(presentationTextStyleAt(editedText, 4)).toMatchObject({ fontSize: 20, color: '#0088CC', fontWeight: 400 })
    const colored = await change(edited, markdown => markdown.replace('color="#111111"', 'color="#FF0000"'))
    const coloredText = colored.documents[0]!.slides[0]!.elements[0]!
    if (coloredText.type !== 'text') throw new Error('Expected text')
    expect(presentationTextStyleAt(coloredText, 4)).toMatchObject({ fontSize: 20, color: '#FF0000' })
    expect(slide.elements[0]).toMatchObject({ text: '标题 English', x: 20 })
  })

  it('rejects invalid inline style ranges without changing the document', async () => {
    const initial = workspace()
    const slide = initial.documents[0]!.slides[0]!
    const read = await executePowerPointRequest(initial, { method: 'get_ppt_page', params: { page_id: slide.id } })
    for (const textRuns of [
      [{ start: 0, end: 99, style: { fontSize: 20 } }],
      [{ start: 0, end: 1, style: { fontSize: -1 } }],
      [{ start: 0, end: 1, style: { unexpected: true } }],
    ]) {
      const serialized = JSON.stringify(textRuns).replaceAll('"', '&quot;')
      const result = await executePowerPointRequest(initial, { method: 'insert_ppt_element', params: {
        page_id: slide.id, expected_revision: (read.result as { page: { revision: string } }).page.revision,
        element: `<PptText textRuns="${serialized}">Text</PptText>`,
      } })
      expect(result.result).toMatchObject({ status: 'invalid' })
      expect(result.workspace).toBeUndefined()
    }
    expect(slide.elements).toEqual([])
  })

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
