import { describe, expect, it } from 'bun:test'
import JSZip from 'jszip'
import {
  PRESENTATION_PAGE_SIZES,
  createBlankPresentationSlide,
  createInitialPresentationDocument as createEmptyPresentationDocument,
  type PresentationElement,
  type PresentationTransition,
} from '@/atoms/presentation'
import { createPresentationTestDocument as createInitialPresentationDocument } from '@/test-fixtures/presentation'
import { createPresentationPptx } from '../presentationPptx'

describe('createPresentationPptx', () => {
  async function exportTransitionSlides(transitions: PresentationTransition[]): Promise<JSZip> {
    const document = createInitialPresentationDocument()
    document.slides = transitions.map((transition, index) => ({
      ...createBlankPresentationSlide(`Transition ${index + 1}`),
      id: `transition-slide-${index + 1}`,
      transition,
    }))
    document.selectedSlideId = document.slides[0]!.id
    return JSZip.loadAsync(await createPresentationPptx(document))
  }

  async function readSlideXml(archive: JSZip, slideNumber: number): Promise<string> {
    const slide = archive.file(`ppt/slides/slide${slideNumber}.xml`)
    if (!slide) throw new Error(`Missing slide ${slideNumber}`)
    return slide.async('text')
  }

  it('does not export empty text boxes as slide content', async () => {
    const document = createEmptyPresentationDocument()
    document.slides[0]!.elements = [{
      id: 'empty-title-placeholder',
      type: 'text',
      x: 120,
      y: 245,
      width: 1040,
      height: 100,
      rotation: 0,
      text: '',
      fontSize: 42,
      fontFamily: 'Aptos Display',
      fontWeight: 700,
      color: '#20202B',
      align: 'center',
    }]

    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    const slideXml = await readSlideXml(archive, 1)

    expect(slideXml).not.toContain('Click to add title')
    expect(slideXml).not.toContain('<a:t>')
  })

  it('exports every slide into a valid PowerPoint Open XML archive', async () => {
    const document = createInitialPresentationDocument()
    const title = document.slides[0]?.elements.find((element) => element.type === 'text')
    if (document.slides[0]) {
      document.slides[0].notes = 'Speaker note exported from Bridgic.'
      document.slides[0].transition = { effect: 'fade', durationMs: 500 }
    }
    if (title?.type === 'text') {
      title.italic = true
      title.underline = true
      title.strikethrough = true
      title.baseline = 'superscript'
      title.highlightColor = '#FFF200'
      title.characterSpacing = 100
      title.lineHeight = 1.5
      title.listStyle = 'bullet'
      title.shadow = true
    }
    document.slides[0]?.elements.push(
      {
        id: 'heart-shape',
        type: 'heart',
        x: 900,
        y: 480,
        width: 180,
        height: 160,
        rotation: 0,
        fill: '#E85D75',
        borderColor: '#B02A45',
        borderWidth: 2,
      },
      {
        id: 'double-arrow-line',
        type: 'lineDoubleArrow',
        x: 820,
        y: 650,
        width: 260,
        height: 20,
        rotation: 0,
        fill: 'transparent',
        borderColor: '#8B7CFF',
        borderWidth: 3,
      },
    )
    const bytes = await createPresentationPptx(document)

    expect(bytes[0]).toBe(0x50)
    expect(bytes[1]).toBe(0x4B)

    const archive = await JSZip.loadAsync(bytes)
    expect(archive.file('[Content_Types].xml')).not.toBeNull()
    expect(archive.file('ppt/presentation.xml')).not.toBeNull()
    expect(archive.file('ppt/slides/slide1.xml')).not.toBeNull()
    expect(archive.file(`ppt/slides/slide${document.slides.length}.xml`)).not.toBeNull()

    const firstSlideXml = await archive.file('ppt/slides/slide1.xml')?.async('text')
    expect(firstSlideXml).toContain(' i="1"')
    expect(firstSlideXml).toContain(' u="sng"')
    expect(firstSlideXml).toContain(' strike="sngStrike"')
    expect(firstSlideXml).toContain('<a:highlight>')
    expect(firstSlideXml).toContain('<a:buChar')
    expect(firstSlideXml).toContain(' baseline="30000"')
    expect(firstSlideXml).toContain('prst="heart"')
    expect(firstSlideXml).toContain('<a:headEnd type="arrow"')
    expect(firstSlideXml).toContain('<a:tailEnd type="arrow"')
    const firstNotesXml = await archive.file('ppt/notesSlides/notesSlide1.xml')?.async('text')
    expect(firstNotesXml).toContain('Speaker note exported from Bridgic.')
  })

  it('exports the document page size instead of forcing widescreen', async () => {
    const document = createInitialPresentationDocument()
    document.pageSize = PRESENTATION_PAGE_SIZES.standard

    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    const presentationXml = await archive.file('ppt/presentation.xml')?.async('text')

    expect(presentationXml).toContain('<p:sldSz cx="9144000" cy="6858000"')
  })

  it('exports element animations as native PowerPoint timing targeted by object id', async () => {
    const document = createInitialPresentationDocument()
    const slide = document.slides[0]!
    const title = slide.elements.find((element) => element.type === 'text')!
    title.animation = 'fade'
    title.animationDuration = 860
    title.animationDelay = 275
    title.animationStart = 'onClick'
    title.animationTrigger = 'elementClick'
    slide.transition = { effect: 'fade', durationMs: 450 }
    slide.elements.push(
      {
        id: 'checker-shape',
        type: 'rect',
        x: 760,
        y: 160,
        width: 180,
        height: 120,
        rotation: 0,
        fill: '#6957D9',
        borderColor: '#4433AA',
        borderWidth: 1,
        animation: 'checkerboard',
        animationDuration: 640,
        animationStart: 'withPrevious',
      },
      {
        id: 'color-shape',
        type: 'ellipse',
        x: 970,
        y: 160,
        width: 140,
        height: 140,
        rotation: 0,
        fill: '#FFFFFF',
        borderColor: '#2678E8',
        borderWidth: 2,
        animation: 'fillColor',
        animationColor: '#F2B91F',
        animationDuration: 700,
        animationStart: 'afterPrevious',
      },
      {
        id: 'exit-shape',
        type: 'rect',
        x: 760,
        y: 330,
        width: 180,
        height: 120,
        rotation: 0,
        fill: '#E17B47',
        borderColor: '#A94F22',
        borderWidth: 1,
        animation: 'blindsOut',
        animationDuration: 510,
        animationStart: 'onClick',
      },
      {
        id: 'fly-shape',
        type: 'rect',
        x: 970,
        y: 330,
        width: 140,
        height: 120,
        rotation: 0,
        fill: '#52A47A',
        borderColor: '#23754E',
        borderWidth: 1,
        animation: 'flyIn',
        animationDuration: 620,
        animationStart: 'withPrevious',
      },
      {
        id: 'color-text',
        type: 'text',
        x: 760,
        y: 490,
        width: 350,
        height: 70,
        rotation: 0,
        text: 'Color emphasis',
        fontSize: 28,
        fontFamily: 'Aptos',
        fontWeight: 600,
        color: '#20202B',
        align: 'left',
        animation: 'textColor',
        animationColor: '#F04E98',
        animationDuration: 720,
        animationStart: 'afterPrevious',
      },
    )

    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    const xml = await readSlideXml(archive, 1)
    const shapeId = (objectName: string): string => {
      const tag = (xml.match(/<p:cNvPr\b[^>]*>/g) ?? []).find((candidate) => candidate.includes(`name="${objectName}"`))
      const id = tag && /\bid="(\d+)"/.exec(tag)?.[1]
      if (!id) throw new Error(`Missing exported object ${objectName}`)
      return id
    }

    const titleShapeId = shapeId(title.id)
    const checkerShapeId = shapeId('checker-shape')
    const colorShapeId = shapeId('color-shape')
    const exitShapeId = shapeId('exit-shape')
    const flyShapeId = shapeId('fly-shape')
    const colorTextShapeId = shapeId('color-text')
    expect(xml.indexOf('<p:transition')).toBeLessThan(xml.indexOf('<p:timing>'))
    expect(xml).toContain('<p:timing>')
    expect(xml).toContain('nodeType="clickEffect"')
    expect(xml).toContain('nodeType="withEffect"')
    expect(xml).toContain('nodeType="afterEffect"')
    expect(xml).toContain('delay="275"')
    expect(xml).toContain('dur="860"')
    expect(xml).toContain('filter="fade"')
    expect(xml).toContain('filter="checkerboard(across)"')
    expect(xml).toContain('filter="blinds(horizontal)"')
    expect(xml).toContain('filter="slide(fromBottom)"')
    expect(xml).not.toContain('#ppt_x-0.08')
    expect(xml).toContain('<a:srgbClr val="F2B91F"/>')
    expect(xml).toContain('<a:srgbClr val="F04E98"/>')
    expect(xml).toMatch(new RegExp(`presetID="5"[^>]*presetClass="entr"[^>]*presetSubtype="6"[\\s\\S]*?<p:spTgt spid="${checkerShapeId}"/>`))
    expect(xml).toMatch(new RegExp(`presetID="19"[^>]*presetClass="emph"[^>]*presetSubtype="0"[\\s\\S]*?<p:spTgt spid="${colorShapeId}"/>`))
    expect(xml).toMatch(new RegExp(`presetID="3"[^>]*presetClass="emph"[^>]*presetSubtype="2"[\\s\\S]*?<p:spTgt spid="${colorTextShapeId}"/>`))
    for (const id of [titleShapeId, checkerShapeId, colorShapeId, exitShapeId, flyShapeId, colorTextShapeId]) {
      expect(xml).toContain(`<p:spTgt spid="${id}"/>`)
      expect(xml).toContain(`<p:bldP spid="${id}"`)
    }
  })

  it('exports grouped card members in one synchronized native animation step', async () => {
    const document = createInitialPresentationDocument()
    const slide = document.slides[0]!
    slide.elements = [
      {
        id: 'group-card',
        groupId: 'card-group',
        type: 'rect',
        x: 120,
        y: 160,
        width: 360,
        height: 260,
        rotation: 0,
        fill: '#FFFFFF',
        borderColor: '#D7D8DE',
        borderWidth: 1,
        animation: 'fade',
        animationDuration: 700,
        animationDelay: 140,
        animationStart: 'onClick',
      },
      {
        id: 'group-number',
        groupId: 'card-group',
        type: 'text',
        x: 150,
        y: 190,
        width: 80,
        height: 40,
        rotation: 0,
        text: '01',
        fontSize: 20,
        fontFamily: 'Aptos',
        fontWeight: 700,
        color: '#6957D9',
        align: 'left',
      },
      {
        id: 'group-heading',
        groupId: 'card-group',
        type: 'text',
        x: 150,
        y: 260,
        width: 280,
        height: 60,
        rotation: 0,
        text: 'Frame the idea',
        fontSize: 28,
        fontFamily: 'Aptos Display',
        fontWeight: 700,
        color: '#20202B',
        align: 'left',
      },
    ]

    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    const xml = await readSlideXml(archive, 1)
    const shapeId = (objectName: string): string => {
      const tag = (xml.match(/<p:cNvPr\b[^>]*>/g) ?? []).find((candidate) => candidate.includes(`name="${objectName}"`))
      const id = tag && /\bid="(\d+)"/.exec(tag)?.[1]
      if (!id) throw new Error(`Missing exported object ${objectName}`)
      return id
    }

    for (const objectName of ['group-card', 'group-number', 'group-heading']) {
      const id = shapeId(objectName)
      expect(xml).toContain(`<p:spTgt spid="${id}"/>`)
      expect(xml).toContain(`<p:bldP spid="${id}"`)
    }
    expect(xml.match(/nodeType="clickEffect"/g)).toHaveLength(1)
    expect(xml.match(/nodeType="withEffect"/g)).toHaveLength(2)
    expect(xml.match(/dur="700"/g)).toHaveLength(3)
    expect(xml.match(/delay="140"/g)).toHaveLength(3)
  })

  it('preserves after-previous steps when a with-previous effect follows them', async () => {
    const document = createInitialPresentationDocument()
    const slide = document.slides[0]!
    const animatedShape = (id: string, animationStart: 'onClick' | 'withPrevious' | 'afterPrevious', animation: 'fade' | 'appear' | 'disappear', duration: number, x: number): PresentationElement => ({
      id,
      type: 'rect',
      x,
      y: 180,
      width: 180,
      height: 120,
      rotation: 0,
      fill: '#6957D9',
      borderColor: '#4433AA',
      borderWidth: 1,
      animation,
      animationDuration: duration,
      animationStart,
    })
    slide.elements = [
      animatedShape('order-a', 'onClick', 'fade', 400, 120),
      animatedShape('order-b', 'afterPrevious', 'appear', 3_000, 360),
      animatedShape('order-c', 'withPrevious', 'disappear', 2_500, 600),
    ]

    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    const xml = await readSlideXml(archive, 1)
    const shapeId = (objectName: string): string => {
      const tag = (xml.match(/<p:cNvPr\b[^>]*>/g) ?? []).find((candidate) => candidate.includes(`name="${objectName}"`))
      const id = tag && /\bid="(\d+)"/.exec(tag)?.[1]
      if (!id) throw new Error(`Missing exported object ${objectName}`)
      return id
    }
    const targetIndex = (id: string): number => xml.indexOf(`<p:spTgt spid="${shapeId(id)}"/>`)

    expect(targetIndex('order-a')).toBeLessThan(targetIndex('order-b'))
    expect(targetIndex('order-b')).toBeLessThan(targetIndex('order-c'))
    expect(xml).toContain('<p:cond delay="400"/>')
    expect(xml).not.toContain('dur="3000"')
    expect(xml).not.toContain('dur="2500"')
  })

  it('exports hyperlinks, embedded media, editable tables and charts, and slide footers', async () => {
    const document = createInitialPresentationDocument()
    const sourceSlide = document.slides[0]!
    const targetSlide = document.slides[1]!
    const pngDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5QAAAABJRU5ErkJggg=='
    const chartTypes = ['column', 'bar', 'line', 'pie', 'doughnut'] as const
    const elements: PresentationElement[] = [
      {
        id: 'linked-text',
        type: 'text',
        x: 30,
        y: 30,
        width: 240,
        height: 50,
        rotation: 0,
        text: 'External link',
        fontSize: 20,
        fontFamily: 'Aptos',
        fontWeight: 600,
        color: '#20202B',
        align: 'left',
        hyperlink: {
          type: 'url',
          url: 'https://example.com/docs?a=1&b=2',
          tooltip: 'Read the docs',
        },
      },
      {
        id: 'linked-shape',
        type: 'rect',
        x: 285,
        y: 30,
        width: 100,
        height: 50,
        rotation: 0,
        fill: '#6957D9',
        borderColor: '#4433AA',
        borderWidth: 1,
        hyperlink: { type: 'slide', slideId: targetSlide.id, tooltip: 'Next slide' },
      },
      {
        id: 'linked-image',
        type: 'image',
        x: 400,
        y: 30,
        width: 120,
        height: 80,
        rotation: 15,
        source: { dataUrl: pngDataUrl, fileName: 'pixel.png', mimeType: 'image/png' },
        altText: 'Tiny preview',
        fit: 'cover',
        hyperlink: { type: 'url', url: 'https://example.com/image?a=1&b=2' },
      },
      {
        id: 'contained-image',
        type: 'image',
        x: 530,
        y: 30,
        width: 50,
        height: 80,
        rotation: 0,
        source: { dataUrl: pngDataUrl, fileName: 'contained.png', mimeType: 'image/png' },
        altText: 'Contained preview',
        fit: 'contain',
      },
      {
        id: 'embedded-audio',
        type: 'audio',
        x: 30,
        y: 120,
        width: 260,
        height: 60,
        rotation: 0,
        source: {
          dataUrl: 'data:audio/mpeg;base64,SUQzAwAAAAAA',
          fileName: 'sample.mp3',
          mimeType: 'audio/mpeg',
        },
        autoplay: false,
        loop: false,
        muted: false,
      },
      {
        id: 'embedded-extensionless-audio',
        type: 'audio',
        x: 30,
        y: 300,
        width: 260,
        height: 60,
        rotation: 0,
        source: {
          dataUrl: 'data:audio/mpeg;base64,SUQzAwAAAAAA',
          fileName: 'extensionless-audio',
          mimeType: 'audio/mpeg',
        },
        autoplay: false,
        loop: false,
        muted: false,
      },
      {
        id: 'embedded-video',
        type: 'video',
        x: 310,
        y: 120,
        width: 260,
        height: 145,
        rotation: 0,
        source: {
          dataUrl: 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
          fileName: 'sample.mp4',
          mimeType: 'video/mp4',
        },
        autoplay: false,
        loop: false,
        muted: false,
      },
      {
        id: 'embedded-m4a',
        type: 'audio',
        x: 310,
        y: 270,
        width: 120,
        height: 40,
        rotation: 0,
        source: {
          dataUrl: 'data:audio/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
          fileName: 'sample.m4a',
          mimeType: 'audio/mp4',
        },
        autoplay: false,
        loop: false,
        muted: false,
      },
      {
        id: 'embedded-mov',
        type: 'video',
        x: 450,
        y: 270,
        width: 120,
        height: 68,
        rotation: 0,
        source: {
          dataUrl: 'data:video/quicktime;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
          fileName: 'sample.mov',
          mimeType: 'video/quicktime',
        },
        autoplay: false,
        loop: false,
        muted: false,
      },
      {
        id: 'editable-table',
        type: 'table',
        x: 590,
        y: 30,
        width: 640,
        height: 220,
        rotation: 0,
        cells: [
          ['Name', 'Q1', 'Q2'],
          ['North', '12', '18'],
          ['South', '9', '14'],
        ],
        headerRow: true,
        headerFill: '#6957D9',
        bodyFill: '#FFFFFF',
        textColor: '#20202B',
        borderColor: '#D8D9E0',
        fontSize: 14,
      },
      ...chartTypes.map((chartType, index): PresentationElement => ({
        id: `editable-chart-${chartType}`,
        type: 'chart',
        chartType,
        x: 30 + index * 245,
        y: 290,
        width: 225,
        height: 300,
        rotation: 0,
        categories: ['Jan', 'Feb', 'Mar'],
        series: [
          { name: 'Revenue', values: [12, 19, 15] },
          { name: 'Costs', values: [8, 11, 10] },
          { name: 'Margin', values: [4, 8, 5] },
        ],
        showLegend: true,
        title: `${chartType} chart`,
        colors: ['#6957D9', '#2F8B78'],
      })),
    ]
    sourceSlide.elements = elements
    sourceSlide.transition = { effect: 'fade', durationMs: 750 }
    sourceSlide.footer = {
      text: 'Bridgic confidential',
      showDate: true,
      showSlideNumber: true,
    }

    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    const slideXml = await readSlideXml(archive, 1)
    const slideRelationships = await archive.file('ppt/slides/_rels/slide1.xml.rels')?.async('text')
    if (!slideRelationships) throw new Error('Missing slide relationships')

    const linkedTextRun = /<a:r>[\s\S]*?<a:t>External link<\/a:t><\/a:r>/.exec(slideXml)?.[0]
    expect(linkedTextRun).toContain('u="sng"')
    expect(linkedTextRun).toContain('<a:srgbClr val="2563EB"/>')
    expect(slideXml).toContain('descr="Tiny preview"')
    expect(slideXml).toContain('descr="Contained preview"')
    expect(slideXml).toContain('rot="900000"')
    expect(slideXml).toMatch(/<a:srcRect l="0" r="0" t="\d+" b="\d+"\/>/)
    expect(slideXml).toMatch(/<a:srcRect l="0" r="0" t="-\d+" b="-\d+"\/>/)
    expect(slideXml).toContain('<a:tbl>')
    expect(slideXml).toContain('<a:audioFile')
    expect(slideXml).toContain('<a:videoFile')
    expect(slideXml).toContain('<p:transition spd="med" p14:dur="750"><p:fade/></p:transition>')
    expect(slideXml).toContain('Bridgic confidential')
    expect(slideXml).toContain(new Intl.DateTimeFormat().format(new Date()))
    expect(slideXml).toContain('type="slidenum"')
    expect(slideRelationships).toContain('relationships/image')
    expect(slideRelationships).toContain('relationships/audio')
    expect(slideRelationships).toContain('relationships/video')
    expect(slideRelationships).toContain('relationships/chart')
    expect(slideRelationships).toContain('Target="../charts/chart')
    expect(slideRelationships).not.toContain('Target="/ppt/charts/')
    expect(slideRelationships).toContain('relationships/hyperlink')
    expect(slideRelationships).toContain('Target="https://example.com/docs?a=1&amp;b=2"')
    expect(slideRelationships).toContain('Target="https://example.com/image?a=1&amp;b=2"')
    expect(slideRelationships).toContain('Target="slide2.xml"')
    expect(slideRelationships.match(/TargetMode="External"/g)?.length).toBe(2)

    const mediaPaths = Object.keys(archive.files).filter((path) => path.startsWith('ppt/media/') && !path.endsWith('/'))
    expect(mediaPaths.some((path) => path.endsWith('.png'))).toBe(true)
    expect(mediaPaths.filter((path) => path.endsWith('.mp3'))).toHaveLength(2)
    expect(mediaPaths.some((path) => path.endsWith('.m4a'))).toBe(true)
    expect(mediaPaths.some((path) => path.endsWith('.mp4'))).toBe(true)
    expect(mediaPaths.some((path) => path.endsWith('.mov'))).toBe(true)
    await Promise.all(mediaPaths.map(async (path) => {
      expect((await archive.file(path)?.async('uint8array'))?.length).toBeGreaterThan(0)
    }))

    const contentTypesXml = await archive.file('[Content_Types].xml')?.async('text')
    if (!contentTypesXml) throw new Error('Missing content types')
    expect(contentTypesXml).toContain('<Default Extension="mp3" ContentType="audio/mpeg"/>')
    expect(contentTypesXml).toContain('<Default Extension="m4a" ContentType="audio/mp4"/>')
    expect(contentTypesXml).toContain('<Default Extension="mov" ContentType="video/quicktime"/>')
    expect(contentTypesXml).not.toContain('ContentType="audio/mp3"')
    expect(contentTypesXml).not.toContain('ContentType="audio/m4a"')
    expect(contentTypesXml).not.toContain('ContentType="video/mov"')

    const chartPaths = Object.keys(archive.files).filter((path) => /^ppt\/charts\/chart\d+\.xml$/.test(path))
    const embeddingPaths = Object.keys(archive.files).filter((path) => /^ppt\/embeddings\/.*\.xlsx$/.test(path))
    expect(chartPaths).toHaveLength(chartTypes.length)
    expect(embeddingPaths).toHaveLength(chartTypes.length)
    const chartXmlFiles = await Promise.all(chartPaths.map(async (path) => archive.file(path)!.async('text')))
    const chartXml = chartXmlFiles.join('\n')
    expect(chartXml).toContain('<c:barDir val="col"/>')
    expect(chartXml).toContain('<c:barDir val="bar"/>')
    expect(chartXml).toContain('<c:lineChart>')
    expect(chartXml).toContain('<c:pieChart>')
    expect(chartXml).toContain('<c:doughnutChart>')
    for (const axialChartXml of chartXmlFiles.filter((xml) => xml.includes('<c:barChart>') || xml.includes('<c:lineChart>'))) {
      const declaredAxisIds = new Set(Array.from(axialChartXml.matchAll(
        /<c:(?:catAx|dateAx|valAx|serAx)\b[^>]*>\s*<c:axId\b[^>]*\bval="([^"]+)"[^>]*\/>/g,
      ), (match) => match[1]!))
      const referencedAxisIds = Array.from(axialChartXml.matchAll(
        /<c:(?:barChart|lineChart)>[\s\S]*?<\/c:(?:barChart|lineChart)>/g,
      )).flatMap((match) => Array.from(match[0].matchAll(/<c:axId\b[^>]*\bval="([^"]+)"[^>]*\/>/g), (axis) => axis[1]!))
      expect(referencedAxisIds.every((axisId) => declaredAxisIds.has(axisId))).toBe(true)
    }
    for (const pieFamilyXml of chartXmlFiles.filter((xml) => xml.includes('<c:pieChart>') || xml.includes('<c:doughnutChart>'))) {
      expect(pieFamilyXml.match(/<a:srgbClr val="6957D9"\/>/g)?.length).toBeGreaterThanOrEqual(2)
      expect(pieFamilyXml).toContain('<a:srgbClr val="2F8B78"/>')
    }
    await Promise.all(embeddingPaths.map(async (path) => {
      expect((await archive.file(path)?.async('uint8array'))?.length).toBeGreaterThan(0)
    }))
  })

  it('canonicalizes QuickTime content types without relying on audio or transitions', async () => {
    const document = createInitialPresentationDocument()
    document.slides[0]!.elements = [{
      id: 'quicktime-only',
      type: 'video',
      x: 10,
      y: 10,
      width: 320,
      height: 180,
      rotation: 0,
      source: {
        dataUrl: 'data:video/quicktime;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
        fileName: 'quicktime-only.mov',
        mimeType: 'video/quicktime',
      },
      autoplay: false,
      loop: false,
      muted: false,
    }]
    document.slides[0]!.transition = { effect: 'none', durationMs: 1_000 }

    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    const contentTypesXml = await archive.file('[Content_Types].xml')?.async('text')
    if (!contentTypesXml) throw new Error('Missing content types')
    expect(contentTypesXml).toContain('<Default Extension="mov" ContentType="video/quicktime"/>')
    expect(contentTypesXml).not.toContain('ContentType="video/mov"')
  })

  it('skips malformed legacy elements and dangling hyperlinks without failing export', async () => {
    const document = createInitialPresentationDocument()
    const elements = document.slides[0]!.elements as unknown[]
    elements.push(
      { id: 'legacy-object', type: 'legacyWidget', x: 10, y: 10, width: 100, height: 100, rotation: 0 },
      {
        id: 'broken-image',
        type: 'image',
        x: 10,
        y: 10,
        width: 100,
        height: 100,
        rotation: 0,
        source: { dataUrl: 'not-a-data-url', fileName: 'broken.png', mimeType: 'image/png' },
        altText: 'Broken image',
        fit: 'contain',
      },
      {
        id: 'mismatched-image',
        type: 'image',
        x: 120,
        y: 10,
        width: 100,
        height: 100,
        rotation: 0,
        source: {
          dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z5QAAAABJRU5ErkJggg==',
          fileName: 'mismatch.jpg',
          mimeType: 'image/png',
        },
        altText: 'Mismatched image',
        fit: 'contain',
      },
      {
        id: 'mismatched-audio',
        type: 'audio',
        x: 230,
        y: 10,
        width: 100,
        height: 50,
        rotation: 0,
        source: { dataUrl: 'data:audio/mpeg;base64,SUQzAwAAAAAA', fileName: 'mismatch.ogg', mimeType: 'audio/mpeg' },
        autoplay: false,
        loop: false,
        muted: false,
      },
      {
        id: 'bad-signature-audio',
        type: 'audio',
        x: 340,
        y: 10,
        width: 100,
        height: 50,
        rotation: 0,
        source: { dataUrl: 'data:audio/mpeg;base64,AAAA', fileName: 'broken.mp3', mimeType: 'audio/mpeg' },
        autoplay: false,
        loop: false,
        muted: false,
      },
      {
        id: 'mismatched-video',
        type: 'video',
        x: 450,
        y: 10,
        width: 100,
        height: 50,
        rotation: 0,
        source: {
          dataUrl: 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDE=',
          fileName: 'mismatch.mov',
          mimeType: 'video/mp4',
        },
        autoplay: false,
        loop: false,
        muted: false,
      },
      {
        id: 'dangling-shape-link',
        type: 'rect',
        x: 10,
        y: 10,
        width: 100,
        height: 100,
        rotation: 0,
        fill: '#FFFFFF',
        borderColor: '#000000',
        borderWidth: 1,
        hyperlink: { type: 'slide', slideId: 'missing-slide' },
      },
    )

    const archive = await JSZip.loadAsync(await createPresentationPptx(document))
    const slideXml = await readSlideXml(archive, 1)
    const relationships = await archive.file('ppt/slides/_rels/slide1.xml.rels')?.async('text')
    expect(slideXml).not.toContain('legacyWidget')
    expect(slideXml).not.toContain('Broken image')
    expect(slideXml).not.toContain('Mismatched image')
    expect(relationships).not.toContain('missing-slide')
    expect(relationships).not.toContain('relationships/audio')
    expect(relationships).not.toContain('relationships/video')
    expect(Object.keys(archive.files).filter((path) => path.startsWith('ppt/media/') && !path.endsWith('/'))).toHaveLength(0)
  })

  it('writes standard transitions with exact duration, fallback speed, direction, and through-black options', async () => {
    const archive = await exportTransitionSlides([
      { effect: 'none', durationMs: 500 },
      { effect: 'fade', durationMs: 750, throughBlack: true },
      { effect: 'push', durationMs: 1_500, direction: 'right' },
      { effect: 'wipe', durationMs: 500, direction: 'up' },
      { effect: 'cover', durationMs: 1_000, direction: 'down' },
      { effect: 'zoom', durationMs: 600, direction: 'out' },
    ])

    const noneXml = await readSlideXml(archive, 1)
    const fadeXml = await readSlideXml(archive, 2)
    const pushXml = await readSlideXml(archive, 3)
    const wipeXml = await readSlideXml(archive, 4)
    const coverXml = await readSlideXml(archive, 5)
    const zoomXml = await readSlideXml(archive, 6)

    expect(noneXml).not.toContain('<p:transition')
    expect(noneXml).not.toContain('xmlns:p14=')
    expect(fadeXml).toContain('xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"')
    expect(fadeXml).toContain('xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"')
    expect(fadeXml).toContain('mc:Ignorable="p14"')
    expect(fadeXml).toContain('<p:transition spd="med" p14:dur="750"><p:fade thruBlk="1"/></p:transition>')
    expect(pushXml).toContain('<p:transition spd="slow" p14:dur="1500"><p:push dir="l"/></p:transition>')
    expect(wipeXml).toContain('<p:transition spd="fast" p14:dur="500"><p:wipe dir="d"/></p:transition>')
    expect(coverXml).toContain('<p:transition spd="med" p14:dur="1000"><p:cover dir="u"/></p:transition>')
    expect(zoomXml).toContain('<p:transition spd="med" p14:dur="600"><p:zoom dir="out"/></p:transition>')
    expect(fadeXml).not.toContain('<mc:AlternateContent>')
    expect(fadeXml.indexOf('</p:clrMapOvr>')).toBeLessThan(fadeXml.indexOf('<p:transition'))
    expect(fadeXml.indexOf('<p:transition')).toBeLessThan(fadeXml.indexOf('</p:sld>'))
  })

  it('normalizes a legacy cut transition to no transition instead of exporting p:cut', async () => {
    const legacyCut = { effect: 'cut', durationMs: 250, throughBlack: true } as unknown as PresentationTransition
    const archive = await exportTransitionSlides([legacyCut])
    const slideXml = await readSlideXml(archive, 1)

    expect(slideXml).not.toContain('<p:transition')
    expect(slideXml).not.toContain('<p:cut')
    expect(slideXml).not.toContain('xmlns:p14=')
  })

  it('wraps Office extension transitions with a standard fade fallback', async () => {
    const archive = await exportTransitionSlides([
      { effect: 'reveal', durationMs: 1_500, direction: 'right', throughBlack: true },
      { effect: 'flip', durationMs: 900, direction: 'left' },
      { effect: 'cube', durationMs: 500, direction: 'down' },
    ])

    const revealXml = await readSlideXml(archive, 1)
    const flipXml = await readSlideXml(archive, 2)
    const cubeXml = await readSlideXml(archive, 3)

    expect(revealXml).toContain('<mc:AlternateContent><mc:Choice Requires="p14">')
    expect(revealXml).toContain('<p:transition spd="slow" p14:dur="1500"><p14:reveal dir="l" thruBlk="1"/></p:transition>')
    expect(revealXml).toContain('<mc:Fallback><p:transition spd="slow"><p:fade thruBlk="1"/></p:transition></mc:Fallback>')
    expect(flipXml).toContain('<p:transition spd="med" p14:dur="900"><p14:flip dir="r"/></p:transition>')
    expect(flipXml).toContain('<mc:Fallback><p:transition spd="med"><p:fade/></p:transition></mc:Fallback>')
    // PowerPoint serializes the cube-style effect as the Office 2010 prism extension.
    expect(cubeXml).toContain('<p14:prism dir="u" isContent="0" isInverted="0"/>')
    expect(cubeXml).not.toContain('<p14:cube')
    expect(cubeXml).toContain('<mc:Fallback><p:transition spd="fast"><p:fade/></p:transition></mc:Fallback>')
    expect(cubeXml.indexOf('</p:clrMapOvr>')).toBeLessThan(cubeXml.indexOf('<mc:AlternateContent>'))
    expect(cubeXml.indexOf('<mc:AlternateContent>')).toBeLessThan(cubeXml.indexOf('</p:sld>'))
  })
})
