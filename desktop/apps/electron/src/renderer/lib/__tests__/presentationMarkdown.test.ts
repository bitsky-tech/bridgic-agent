import { describe, expect, it } from 'bun:test'
import { createBlankPresentationProject } from '@/atoms/presentation'
import { createPresentationAsset } from '@/presentation/project'
import { decompilePresentationSlideMarkdown } from '../presentationMarkdown'

describe('PowerPoint compact Markdown projection', () => {
  it('keeps stable refs and authored text while omitting routine native layout', () => {
    const document = createBlankPresentationProject('Review')
    const slide = document.slides.pages[0]!
    slide.name = 'Executive summary'
    slide.elements = [{
      id: 'title', type: 'text', text: 'Revenue\nup 20%', x: 37, y: 91, width: 620, height: 110, rotation: 4,
      fontSize: 44, fontFamily: 'Arial', fontWeight: 700, color: '#112233', align: 'center',
    }]
    const markdown = decompilePresentationSlideMarkdown(slide, document)
    expect(markdown).toContain('id: slide-')
    expect(markdown).toContain('name: Executive summary')
    expect(markdown).toContain('<PptText ref="title">')
    expect(markdown).toContain('Revenue&#10;up 20%')
    expect(markdown).not.toContain('x="37"')
    expect(markdown).not.toContain('fontSize="44"')
  })

  it('uses workspace paths for linked media and opaque refs for embedded media', () => {
    const document = createBlankPresentationProject('Media')
    const slide = document.slides.pages[0]!
    document.assets = [
      createPresentationAsset('image', {
        assetId: 'linked', dataUrl: 'data:image/png;base64,cG5n', fileName: 'linked.png', mimeType: 'image/png', path: 'assets/linked.png',
      }),
      createPresentationAsset('image', {
        assetId: 'embedded', dataUrl: 'data:image/png;base64,cG5n', fileName: 'embedded.png', mimeType: 'image/png',
      }),
    ]
    slide.elements = [
      { id: 'linked-image', type: 'image', sourceAssetId: 'linked', altText: 'Linked', fit: 'cover', x: 0, y: 0, width: 100, height: 100, rotation: 0 },
      { id: 'embedded-image', type: 'image', sourceAssetId: 'embedded', altText: 'Embedded', fit: 'contain', x: 100, y: 0, width: 100, height: 100, rotation: 0 },
    ]
    const markdown = decompilePresentationSlideMarkdown(slide, document)
    expect(markdown).toContain('src="assets/linked.png"')
    expect(markdown).toContain('src="@existing/embedded-image"')
    expect(markdown).not.toContain('base64')
  })

  it('projects tables, charts, notes, and non-default page metadata', () => {
    const document = createBlankPresentationProject('Data')
    const slide = document.slides.pages[0]!
    slide.background = '#123456'
    slide.notes = 'Explain the growth assumptions.'
    slide.footer = { text: 'Confidential', showDate: false, showSlideNumber: true }
    slide.transition = { effect: 'fade', durationMs: 500 }
    slide.elements = [
      { id: 'table', type: 'table', x: 0, y: 0, width: 500, height: 200, rotation: 0, cells: [['A', 'B'], ['1', '2']], headerRow: true, headerFill: '#000000', bodyFill: '#FFFFFF', textColor: '#111111', borderColor: '#CCCCCC', fontSize: 18 },
      { id: 'chart', type: 'chart', x: 0, y: 220, width: 500, height: 300, rotation: 0, chartType: 'column', categories: ['A'], series: [{ name: 'Revenue', values: [10] }], showLegend: false, colors: ['#123456'], title: 'Growth' },
    ]
    const markdown = decompilePresentationSlideMarkdown(slide, document)
    expect(markdown).toContain("background: '#123456'")
    expect(markdown).toContain('effect: fade')
    expect(markdown).toContain('<PptTable ref="table">')
    expect(markdown).toContain('| A | B |')
    expect(markdown).toContain('<PptChart ref="chart" type="column" showLegend="false" title="Growth">')
    expect(markdown).toContain('<!-- notes\nExplain the growth assumptions.\n-->')
  })

  it('fails loudly when a media element refers to a missing asset', () => {
    const document = createBlankPresentationProject('Broken')
    const slide = document.slides.pages[0]!
    slide.elements = [{
      id: 'hero', type: 'image', sourceAssetId: 'missing', altText: 'Hero', fit: 'cover',
      x: 0, y: 0, width: 100, height: 100, rotation: 0,
    }]
    expect(() => decompilePresentationSlideMarkdown(slide, document)).toThrow('has no source asset')
  })
})
