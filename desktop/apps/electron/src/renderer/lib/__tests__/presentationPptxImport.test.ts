import { describe, expect, it } from 'bun:test'
import JSZip from 'jszip'
import { PRESENTATION_PAGE_SIZES } from '@/atoms/presentation'
import { createPresentationTestDocument as createInitialPresentationDocument } from '@/test-fixtures/presentation'
import { createPresentationPptx } from '../presentationPptx'

describe('importPresentationPptx', () => {
  it('round-trips editable slides, geometry, notes and page size', async () => {
    const source = createInitialPresentationDocument()
    source.pageSize = PRESENTATION_PAGE_SIZES.standard
    source.slides[0]!.notes = 'Presenter note'
    const animated = source.slides[0]!.elements.find((element) => element.type === 'text')!
    animated.animation = 'split'
    if (animated.type === 'text') animated.characterSpacing = 125
    const bytes = await createPresentationPptx(source)
    const { importPresentationPptx } = await import('../presentationPptxImport')

    const imported = await importPresentationPptx(bytes, 'round-trip.pptx')

    expect(imported.title).toBe('round-trip')
    expect(imported.pageSize).toEqual(PRESENTATION_PAGE_SIZES.standard)
    expect(imported.slides).toHaveLength(source.slides.length)
    expect(imported.slides[0]!.notes).toContain('Presenter note')
    expect(imported.slides[0]!.elements.some((element) => element.type === 'text')).toBe(true)
    const importedText = imported.slides[0]!.elements.find((element) => element.type === 'text')
    expect(importedText?.animation).toBe('split')
    expect(importedText?.type).toBe('text')
    if (importedText?.type === 'text') expect(importedText.characterSpacing).toBeCloseTo(125, 1)
    expect(imported.slides[0]!.elements.some((element) => element.type !== 'text')).toBe(true)
  })

  it('preserves mixed shape-picture z-order, source crop and text-box layout', async () => {
    const source = createInitialPresentationDocument()
    const slide = source.slides[0]!
    source.slides = [slide]
    source.selectedSlideId = slide.id
    slide.elements = [
      {
        id: 'background-shape',
        type: 'rect',
        x: 0,
        y: 0,
        width: 640,
        height: 360,
        rotation: 0,
        fill: '#F7F4EC',
        borderColor: 'transparent',
        borderWidth: 0,
      },
      {
        id: 'middle-picture',
        type: 'image',
        x: 80,
        y: 40,
        width: 320,
        height: 200,
        rotation: 0,
        altText: 'cropped picture',
        fit: 'cover',
        crop: { left: 0.1, top: 0.2, right: 0.15, bottom: 0.05 },
        source: {
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z9N8AAAAASUVORK5CYII=',
          fileName: 'pixel.png',
          mimeType: 'image/png',
        },
      },
      {
        id: 'foreground-text',
        type: 'text',
        x: 120,
        y: 80,
        width: 180,
        height: 80,
        rotation: 0,
        text: 'Do not wrap this title',
        fontSize: 28,
        fontFamily: 'Aptos',
        fontWeight: 700,
        color: '#20202B',
        align: 'left',
        wordWrap: false,
        textInsets: { left: 4, top: 6, right: 8, bottom: 10 },
      },
    ]
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await createPresentationPptx(source), 'layered.pptx')
    const elements = imported.slides[0]!.elements

    expect(elements.map((element) => element.type)).toEqual(['rect', 'image', 'text'])
    const image = elements[1]
    const text = elements[2]
    expect(image?.type).toBe('image')
    if (image?.type === 'image') {
      expect(image.crop?.left).toBeCloseTo(0.1, 3)
      expect(image.crop?.top).toBeCloseTo(0.2, 3)
      expect(image.crop?.right).toBeCloseTo(0.15, 3)
      expect(image.crop?.bottom).toBeCloseTo(0.05, 3)
    }
    expect(text?.type).toBe('text')
    if (text?.type === 'text') {
      expect(text.wordWrap).toBe(false)
      expect(text.textInsets?.left).toBeCloseTo(4, 1)
      expect(text.textInsets?.top).toBeCloseTo(6, 1)
    }
  })

  it('prefers the East Asian run font for CJK text', async () => {
    const source = createInitialPresentationDocument()
    const slide = source.slides[0]!
    source.slides = [slide]
    source.selectedSlideId = slide.id
    slide.elements = [{
      id: 'cjk-text',
      type: 'text',
      x: 80,
      y: 80,
      width: 360,
      height: 100,
      rotation: 0,
      text: '佛教历史',
      fontSize: 28,
      fontFamily: 'Aptos',
      fontWeight: 400,
      color: '#20202B',
      align: 'left',
      wordWrap: true,
    }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const slideXml = await slideFile.async('text')
    const withEastAsianFont = slideXml.replace(
      /<a:latin\b[^>]*\/>/,
      '<a:latin typeface="Latin Font"/><a:ea typeface="East Asian Font"/>',
    )
    expect(withEastAsianFont).not.toBe(slideXml)
    archive.file('ppt/slides/slide1.xml', withEastAsianFont)
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await archive.generateAsync({ type: 'uint8array' }), 'cjk-font.pptx')
    const text = imported.slides[0]!.elements.find((element) => element.type === 'text')

    expect(text?.type).toBe('text')
    if (text?.type === 'text') expect(text.fontFamily).toBe('East Asian Font')
  })

  it('keeps custom geometry as a fidelity-preserving SVG object', async () => {
    const source = createInitialPresentationDocument()
    const slide = source.slides[0]!
    source.slides = [slide]
    source.selectedSlideId = slide.id
    slide.elements = [{
      id: 'accent',
      type: 'rect',
      x: 40,
      y: 40,
      width: 300,
      height: 180,
      rotation: 0,
      fill: '#A8351A',
      borderColor: 'transparent',
      borderWidth: 0,
    }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const slideXml = await slideFile.async('text')
    const customGeometry = '<a:custGeom><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/><a:rect l="l" t="t" r="r" b="b"/><a:pathLst><a:path w="100" h="100"><a:moveTo><a:pt x="0" y="0"/></a:moveTo><a:lnTo><a:pt x="100" y="0"/></a:lnTo><a:lnTo><a:pt x="100" y="8"/></a:lnTo><a:lnTo><a:pt x="0" y="8"/></a:lnTo><a:close/></a:path></a:pathLst></a:custGeom>'
    archive.file('ppt/slides/slide1.xml', slideXml.replace(/<a:prstGeom prst="rect">.*?<\/a:prstGeom>/, customGeometry))
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await archive.generateAsync({ type: 'uint8array' }), 'custom-shape.pptx')
    const customShape = imported.slides[0]!.elements[0]

    expect(customShape?.type).toBe('image')
    if (customShape?.type === 'image') {
      expect(customShape.source.mimeType).toBe('image/svg+xml')
      expect(customShape.source.dataUrl).toStartWith('data:image/svg+xml;base64,')
    }
  })

  it('imports an Office SVG extension when the picture has no raster fallback relationship', async () => {
    const source = createInitialPresentationDocument()
    const slide = source.slides[0]!
    source.slides = [slide]
    source.selectedSlideId = slide.id
    slide.elements = [{
      id: 'svg-picture',
      type: 'image',
      x: 420,
      y: 180,
      width: 320,
      height: 320,
      rotation: 0,
      opacity: 0.1,
      altText: 'concentric circles',
      fit: 'contain',
      source: {
        dataUrl: `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle cx="50" cy="50" r="40" fill="none" stroke="#A8351A"/></svg>')}`,
        fileName: 'circles.svg',
        mimeType: 'image/svg+xml',
      },
    }]
    const archive = await JSZip.loadAsync(await createPresentationPptx(source))
    const slideFile = archive.file('ppt/slides/slide1.xml')!
    const slideXml = await slideFile.async('text')
    const extensionOnly = slideXml.replace(/<a:blip r:embed="rId\d+">/, '<a:blip>')
    expect(extensionOnly).not.toBe(slideXml)
    expect(extensionOnly).toContain('svgBlip')
    archive.file('ppt/slides/slide1.xml', extensionOnly)
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await archive.generateAsync({ type: 'uint8array' }), 'svg-extension.pptx')
    const image = imported.slides[0]!.elements.find((element) => element.type === 'image')

    expect(image?.type).toBe('image')
    if (image?.type === 'image') {
      expect(image.source.mimeType).toBe('image/svg+xml')
      expect(image.opacity).toBeCloseTo(0.1, 4)
    }
  })

  it('imports common editable tables and charts', async () => {
    const source = createInitialPresentationDocument()
    const slide = source.slides[0]!
    source.slides = [slide]
    source.selectedSlideId = slide.id
    slide.elements = [
      {
        id: 'table',
        type: 'table',
        x: 40,
        y: 60,
        width: 420,
        height: 240,
        rotation: 0,
        cells: [['Period', 'Users'], ['Q1', '12'], ['Q2', '18']],
        headerRow: true,
        headerFill: '#EAE6FF',
        bodyFill: '#FFFFFF',
        textColor: '#20202B',
        borderColor: '#D9D7E2',
        fontSize: 15,
      },
      {
        id: 'chart',
        type: 'chart',
        x: 500,
        y: 60,
        width: 560,
        height: 320,
        rotation: 0,
        chartType: 'column',
        categories: ['Q1', 'Q2'],
        series: [{ name: 'Users', values: [12, 18] }],
        showLegend: true,
        title: 'Quarterly users',
        colors: ['#6957D9'],
      },
    ]
    const { importPresentationPptx } = await import('../presentationPptxImport')
    const imported = await importPresentationPptx(await createPresentationPptx(source), 'data.pptx')
    const table = imported.slides[0]!.elements.find((element) => element.type === 'table')
    const chart = imported.slides[0]!.elements.find((element) => element.type === 'chart')

    expect(table?.type).toBe('table')
    if (table?.type === 'table') expect(table.cells).toEqual([['Period', 'Users'], ['Q1', '12'], ['Q2', '18']])
    expect(chart?.type).toBe('chart')
    if (chart?.type === 'chart') {
      expect(chart.chartType).toBe('column')
      expect(chart.categories).toEqual(['Q1', 'Q2'])
      expect(chart.series[0]?.values).toEqual([12, 18])
    }
  })
})
