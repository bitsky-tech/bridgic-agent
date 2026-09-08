import { describe, expect, it } from 'bun:test'
import JSZip from 'jszip'
import { renderToStaticMarkup } from 'react-dom/server'
import { PresentationSlidePreview } from '../../components/app/PresentationSlidePreview'
import { importPresentationPptx } from '../presentationPptxImport'
import { createPresentationPptx } from '../presentationPptx'
import { presentationTextStyleAt, presentationTextDisplaySegments } from '../presentationText'
import { createBlankPresentationDocument } from '../../atoms/presentation'
import { DOMParser, XMLSerializer } from '@xmldom/xmldom'
import { compilePresentationSlideMarkdown, decompilePresentationSlideMarkdown } from '../presentationMarkdown'

const ns = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
const emu = (px: number) => Math.round(px * 9525)

function shape(id: number, x: number, textBody = '', y = 100) {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="probe-${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(100)}" cy="${emu(50)}"/></a:xfrm><a:prstGeom prst="rect"/><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:spPr>${textBody}</p:sp>`
}

function textBody(direction = '', runs = '<a:r><a:rPr sz="1800"/><a:t>标题 Heading</a:t></a:r>') {
  return `<p:txBody><a:bodyPr ${direction ? `vert="${direction}"` : ''} wrap="none"/><a:p>${runs}</a:p></p:txBody>`
}

async function readFixture(tree: string, height = 6858000, width = 12192000, extraFiles: Record<string, string> = {}, slideAttributes = '') {
  const zip = new JSZip()
  zip.file('ppt/presentation.xml', `<p:presentation ${ns}><p:sldSz cx="${width}" cy="${height}"/></p:presentation>`)
  zip.file('ppt/slides/slide1.xml', `<p:sld ${ns} ${slideAttributes}><p:cSld><p:spTree>${tree}</p:spTree></p:cSld></p:sld>`)
  for (const [path, content] of Object.entries(extraFiles)) zip.file(path, content)
  return importPresentationPptx(await zip.generateAsync({ type: 'uint8array' }))
}

function preview(model: Awaited<ReturnType<typeof readFixture>>) {
  return renderToStaticMarkup(<PresentationSlidePreview slide={model.slides[0]!} pageSize={model.pageSize} width={1280} selected={false} />)
}

function firstText(model: Awaited<ReturnType<typeof readFixture>>) {
  const text = model.slides[0]!.elements.find(element => element.type === 'text')
  if (!text || text.type !== 'text') throw new Error('Missing text')
  return text
}

describe('PowerPoint display fidelity', () => {
  it.each([0, 1, 2])('keeps category/value indices when chart point %s is absent', async (missingIndex) => {
    const model = createBlankPresentationDocument('Sparse data')
    model.slides[0]!.elements = [{ id: 'chart', type: 'chart', chartType: 'column', x: 100, y: 100, width: 800, height: 400, rotation: 0,
      categories: ['Jan', 'Feb', 'Mar'], series: [{ name: 'North', values: [10, 20, 30] }, { name: 'South', values: [40, 50, 60] }], colors: ['#2266EE', '#00AA88'], showLegend: true }]
    const zip = await JSZip.loadAsync(await createPresentationPptx(model))
    const path = Object.keys(zip.files).find(path => /^ppt\/charts\/chart\d+\.xml$/.test(path))!
    const source = await zip.file(path)!.async('text')
    const tree = new DOMParser().parseFromString(source, 'text/xml')
    const firstSeries = tree.getElementsByTagName('c:ser')[0]!
    for (const tag of ['c:val', 'c:cat']) {
      const point = Array.from(firstSeries.getElementsByTagName(tag)[0]!.getElementsByTagName('c:pt')).find(node => node.getAttribute('idx') === String(missingIndex))!
      point.parentNode!.removeChild(point)
    }
    const xml = new XMLSerializer().serializeToString(tree)
    expect(xml).not.toBe(source)
    zip.file(path, xml)
    let reopened = await importPresentationPptx(await zip.generateAsync({ type: 'uint8array' }))
    for (let round = 0; round < 2; round++) {
      expect(reopened.slides[0]!.elements[0]).toMatchObject({
        categories: ['Jan', 'Feb', 'Mar'].map((value, index) => index === missingIndex ? '' : value),
        series: [{ name: 'North', values: [10, 20, 30].map((value, index) => index === missingIndex ? null : value) }, { name: 'South', values: [40, 50, 60] }],
      })
      reopened = await importPresentationPptx(await createPresentationPptx(reopened))
    }
  })

  it.each(['', '<c:ptCount val="3"/>'])('retains sparse indices without relying on an ordered or complete cache (%s)', async (count) => {
    const model = createBlankPresentationDocument('Unordered cache')
    model.slides[0]!.elements = [{ id: 'chart', type: 'chart', chartType: 'line', x: 100, y: 100, width: 800, height: 400, rotation: 0,
      categories: ['Jan', 'Feb', 'Mar'], series: [{ name: 'Sales', values: [10, 20, 30] }], colors: ['#2266EE'], showLegend: true }]
    const zip = await JSZip.loadAsync(await createPresentationPptx(model))
    const path = Object.keys(zip.files).find(path => /^ppt\/charts\/chart\d+\.xml$/.test(path))!
    const xml = await zip.file(path)!.async('text')
    zip.file(path, xml.replace(/(<c:val>[\s\S]*?<c:numCache>)[\s\S]*?(<\/c:numCache>)/, `$1${count}<c:pt idx="2"><c:v>30</c:v></c:pt><c:pt idx="0"><c:v>10</c:v></c:pt>$2`))
    const reopened = await importPresentationPptx(await zip.generateAsync({ type: 'uint8array' }))
    expect(reopened.slides[0]!.elements[0]).toMatchObject({ series: [{ values: [10, null, 30] }] })
  })

  it.each(['headEnd', 'tailEnd', 'both'])('retains native %s arrow direction through export, reimport and Agent editing', async (ends) => {
    const markers = (ends === 'both' ? ['headEnd', 'tailEnd'] : [ends]).map(end => `<a:${end} type="arrow"/>`).join('')
    let model = await readFixture(`<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="1" name="Native arrow"/></p:nvCxnSpPr><p:spPr><a:xfrm rot="2700000" flipH="1"><a:off x="${emu(100)}" y="${emu(100)}"/><a:ext cx="${emu(800)}" cy="${emu(400)}"/></a:xfrm><a:prstGeom prst="line"/><a:ln w="38100"><a:solidFill><a:srgbClr val="111111"/></a:solidFill>${markers}</a:ln></p:spPr></p:cxnSp>`)
    const original = model.slides[0]!.elements[0]!
    if (!('connectorPath' in original)) throw new Error('Missing native arrow geometry')
    expect(original.type).toBe(ends === 'both' ? 'lineDoubleArrow' : 'lineArrow')
    expect(original.connectorPath).toStartWith('M 0 0 L 100 100')
    expect(original.connectorPath!.match(/ M /g)?.length).toBe(ends === 'both' ? 2 : 1)
    for (let round = 0; round < 2; round++) {
      model.slides = [compilePresentationSlideMarkdown(decompilePresentationSlideMarkdown(model.slides[0]!), { document: model }).slide]
      model = await importPresentationPptx(await createPresentationPptx(model))
      const arrow = model.slides[0]!.elements[0]!
      if (!('connectorPath' in arrow)) throw new Error('Lost arrow geometry')
      const numbers = (path: string) => path.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number)
      numbers(arrow.connectorPath!).forEach((value, index) => expect(value).toBeCloseTo(numbers(original.connectorPath!)[index]!, 3))
      expect(arrow.type).toBe(original.type)
      expect(arrow.rotation).toBe(original.rotation)
      expect(arrow.flipHorizontal).toBe(true)
      expect(arrow.x).toBeCloseTo(original.x, 2)
      expect(arrow.y).toBeCloseTo(original.y, 2)
    }
  })

  it.each(['', ' firstRow="0"', ' firstRow="false"', ' firstRow="1"', ' firstRow="true"'])('preserves authored table header semantics and text colors (%s)', async (flag) => {
    const headerRow = flag.includes('"1"') || flag.includes('"true"')
    const cell = (text: string, color: string) => `<a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:rPr sz="2400"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></a:txBody><a:tcPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:tcPr></a:tc>`
    let model = await readFixture(`<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="1" name="Table"/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(100)}" y="${emu(100)}"/><a:ext cx="${emu(800)}" cy="${emu(400)}"/></p:xfrm><a:graphic><a:graphicData><a:tbl><a:tblPr${flag}/><a:tblGrid><a:gridCol w="${emu(400)}"/><a:gridCol w="${emu(400)}"/></a:tblGrid><a:tr h="${emu(200)}">${cell('Revenue', '000000')}${cell('100', '000000')}</a:tr><a:tr h="${emu(200)}">${cell('Cost', '000000')}${cell('60', '000000')}</a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>`)
    for (let round = 0; round < 2; round++) {
      const table = model.slides[0]!.elements[0]!
      expect(table).toMatchObject({ type: 'table', headerRow, textColor: '#000000', bodyFill: '#FFFFFF' })
      if (headerRow) expect(table).toMatchObject({ headerTextColor: '#000000', headerFill: '#FFFFFF' })
      const markup = new DOMParser().parseFromString(preview(model), 'text/html')
      expect(markup.getElementsByTagName('td')[0]!.getAttribute('style')).toContain('color:#000000')
      const edited = compilePresentationSlideMarkdown(decompilePresentationSlideMarkdown(model.slides[0]!), { document: model }).slide
      expect(edited.elements[0]).toMatchObject({ headerRow, ...(headerRow ? { headerTextColor: '#000000' } : {}) })
      model.slides = [edited]
      const bytes = await createPresentationPptx(model)
      const xml = await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('text')
      expect(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('a:tblPr')[0]!.getAttribute('firstRow')).toBe(headerRow ? '1' : '0')
      model = await importPresentationPptx(bytes)
    }
  })

  it('retains the existing white-on-accent default header separately from black body text', async () => {
    const model = createBlankPresentationDocument('Header colors')
    model.slides[0]!.elements = [{ id: 'table', type: 'table', x: 80, y: 80, width: 600, height: 300, rotation: 0,
      cells: [['Header', 'Value'], ['Body', '10']], headerRow: true, headerFill: '#6957D9', bodyFill: '#FFFFFF', textColor: '#000000', borderColor: '#D8D9E0', fontSize: 24 }]
    const reopened = await importPresentationPptx(await createPresentationPptx(model))
    expect(reopened.slides[0]!.elements[0]).toMatchObject({ headerRow: true, headerTextColor: '#FFFFFF', textColor: '#000000', headerFill: '#6957D9', bodyFill: '#FFFFFF' })
  })

  it.each(['pie', 'doughnut'] as const)('retains per-category %s colors through repeated exports', async (chartType) => {
    let model = createBlankPresentationDocument('Category colors')
    model.slides[0]!.elements = [{ id: 'pie', type: 'chart', chartType, x: 100, y: 100, width: 800, height: 400, rotation: 0,
      categories: ['A', 'B', 'C'], series: [{ name: 'Total', values: [50, 0, 20] }], colors: ['#FF0000', '#00AA00', '#0000FF'], showLegend: true }]
    for (let round = 0; round < 2; round++) {
      model = await importPresentationPptx(await createPresentationPptx(model))
      expect(model.slides[0]!.elements[0]).toMatchObject({ chartType, colors: ['#FF0000', '#00AA00', '#0000FF'], categories: ['A', 'B', 'C'] })
      expect(preview(model)).toContain('fill="#FF0000"')
      expect(preview(model)).toContain('fill="#0000FF"')
    }
  })

  it.each(['pie', 'doughnut'] as const)('matches sparse, unordered %s point overrides by index and retains single-series fallback', async (chartType) => {
    const model = createBlankPresentationDocument('Point overrides')
    model.slides[0]!.elements = [{ id: 'pie', type: 'chart', chartType, x: 100, y: 100, width: 800, height: 400, rotation: 0,
      categories: ['A', 'B', 'C'], series: [{ name: 'Total', values: [50, 30, 20] }], colors: ['#FF0000', '#00AA00', '#0000FF'], showLegend: true }]
    const zip = await JSZip.loadAsync(await createPresentationPptx(model))
    const path = Object.keys(zip.files).find(path => /^ppt\/charts\/chart\d+\.xml$/.test(path))!
    let xml = await zip.file(path)!.async('text')
    xml = xml.replace(/<c:dPt>[\s\S]*?<\/c:dPt>/g, '').replace(/<c:varyColors[^>]*\/>/, '<c:varyColors val="0"/>')
      .replace('</c:ser>', '<c:dPt><c:idx val="2"/><c:spPr><a:solidFill><a:srgbClr val="0000FF"/></a:solidFill></c:spPr></c:dPt><c:dPt><c:idx val="0"/><c:spPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></c:spPr></c:dPt></c:ser>')
    xml = xml.replace(/(<c:ser>[\s\S]*?<c:spPr>)[\s\S]*?(<\/c:spPr>)/, '$1<a:solidFill><a:srgbClr val="123456"/></a:solidFill>$2')
    zip.file(path, xml)
    const reopened = await importPresentationPptx(await zip.generateAsync({ type: 'uint8array' }))
    expect(reopened.slides[0]!.elements[0]).toMatchObject({ colors: ['#FF0000', '#123456', '#0000FF'] })
  })

  it.each(['rect', 'ellipse'] as const)('retains %s picture-fill crops, alpha and flips when reopened as ordinary pictures', async (clipShape) => {
    const files = {
      'ppt/media/sample.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="400"><rect width="400" height="400" fill="red"/><rect x="400" width="400" height="400" fill="blue"/></svg>',
      'ppt/slides/_rels/slide1.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/sample.svg"/></Relationships>',
    }
    const tree = `<p:sp><p:nvSpPr><p:cNvPr id="1" name="Cropped fill"/></p:nvSpPr><p:spPr><a:xfrm flipH="1"><a:off x="${emu(100)}" y="${emu(100)}"/><a:ext cx="${emu(800)}" cy="${emu(400)}"/></a:xfrm><a:prstGeom prst="${clipShape}"/><a:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="image1"><a:alphaModFix amt="50000"/></a:blip><a:srcRect l="50000" t="10000" r="5000" b="15000"/><a:stretch><a:fillRect/></a:stretch></a:blipFill></p:spPr></p:sp>`
    let model = await readFixture(tree, undefined, undefined, files)
    for (let round = 0; round < 2; round++) {
      const image = model.slides[0]!.elements[0]!
      expect(image).toMatchObject({ type: 'image', crop: { left: 0.5, top: 0.1, right: 0.05, bottom: 0.15 }, opacity: 0.5, flipHorizontal: true })
      if (clipShape === 'ellipse') expect(image).toMatchObject({ clipShape: 'ellipse' })
      model = await importPresentationPptx(await createPresentationPptx(model))
    }
  })

  it.each([{}, { flipH: '1' }, { flipV: '1' }, { rot: '2700000', flipH: '1' }])('preserves native straight-line endpoints and transform %j', async (transform) => {
    const attrs = Object.entries(transform).map(([key, value]) => `${key}="${value}"`).join(' ')
    let model = await readFixture(`<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="1" name="Line"/></p:nvCxnSpPr><p:spPr><a:xfrm ${attrs}><a:off x="${emu(100)}" y="${emu(100)}"/><a:ext cx="${emu(800)}" cy="${emu(400)}"/></a:xfrm><a:prstGeom prst="line"/><a:ln w="38100"><a:solidFill><a:srgbClr val="111111"/></a:solidFill></a:ln></p:spPr></p:cxnSp>`)
    const original = model.slides[0]!.elements[0]!
    for (let round = 0; round < 2; round++) {
      const line = model.slides[0]!.elements[0]!
      const markup = new DOMParser().parseFromString(preview(model), 'text/html')
      const path = Array.from(markup.getElementsByTagName('path')).find(node => node.getAttribute('stroke') === '#111111')!
      expect(path.getAttribute('d')?.match(/-?\d+(?:\.\d+)?/g)?.map(Number)).toEqual([0, 0, 100, 100])
      expect(line.x).toBeCloseTo(original.x, 2)
      expect(line.y).toBeCloseTo(original.y, 2)
      expect(line.width).toBeCloseTo(800)
      expect(line.height).toBeCloseTo(400)
      expect(line.rotation).toBe(original.rotation)
      expect(Boolean(line.flipHorizontal)).toBe(Boolean(original.flipHorizontal))
      expect(Boolean(line.flipVertical)).toBe(Boolean(original.flipVertical))
      model = await importPresentationPptx(await createPresentationPptx(model))
    }
  })

  it('converts authored stroke points to CSS pixels independently of export', async () => {
    const tree = shape(1, 100).replace('</p:spPr>', '<a:ln w="38100"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr>')
    expect((await readFixture(tree)).slides[0]!.elements[0]).toMatchObject({ type: 'rect', borderWidth: 4 })
  })

  it('exports CSS-pixel stroke widths in DrawingML point units', async () => {
    const model = createBlankPresentationDocument('Stroke units')
    model.slides[0]!.elements = [{ id: 'outline', type: 'rect', x: 100, y: 100, width: 400, height: 300, rotation: 0,
      fill: 'transparent', borderColor: '#000000', borderWidth: 4 }]
    const xml = await (await JSZip.loadAsync(await createPresentationPptx(model))).file('ppt/slides/slide1.xml')!.async('text')
    expect(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('a:ln')[0]!.getAttribute('w')).toBe('38100')
  })

  it.each([0, 45, 90])('pads SVG strokes without moving the authored shape at %s degrees', async (rotation) => {
    const tree = shape(1, 100).replace('<a:xfrm>', `<a:xfrm rot="${rotation * 60000}" flipH="1">`)
      .replace('</p:spPr>', '<a:ln w="304800"><a:solidFill><a:srgbClr val="000000"><a:alpha val="50000"/></a:srgbClr></a:solidFill></a:ln></p:spPr>')
    const image = (await readFixture(tree)).slides[0]!.elements[0]!
    if (image.type !== 'image') throw new Error('Expected an SVG shape')
    const svg = new DOMParser().parseFromString(atob(image.source.dataUrl.split(',')[1]!), 'image/svg+xml').documentElement
    expect(svg.getAttribute('viewBox')).toBe('-64 -64 228 178')
    expect(svg.getElementsByTagName('rect')[0]!.getAttribute('stroke-width')).toBe('32')
    expect(image.flipHorizontal).toBe(true)
    const angle = rotation * Math.PI / 180
    // Rotation is stored about the top-left corner; the padded frame must keep the original center.
    expect(image.x + image.width / 2 * Math.cos(angle) - image.height / 2 * Math.sin(angle)).toBeCloseTo(150)
    expect(image.y + image.width / 2 * Math.sin(angle) + image.height / 2 * Math.cos(angle)).toBeCloseTo(125)
  })

  it('preserves leading, consecutive and trailing blank paragraph formatting through Agent edits and PPTX export', async () => {
    const values = [['', 4800], ['Before', 2400], ['', 9600], ['', 1200], ['After', 2400], ['', 6000]] as const
    const paragraphs = values.map(([text, size]) => `<a:p><a:pPr><a:lnSpc><a:spcPct val="100000"/></a:lnSpc></a:pPr>${text ? `<a:r><a:rPr sz="${size}"/><a:t>${text}</a:t></a:r>` : ''}<a:endParaRPr sz="${size}"><a:latin typeface="Georgia"/></a:endParaRPr></a:p>`).join('')
    let model = await readFixture(shape(1, 100, `<p:txBody><a:bodyPr/>${paragraphs}</p:txBody>`))
    const text = firstText(model)
    expect(text.paragraphs?.map(paragraph => paragraph.endStyle?.fontSize)).toEqual([64, undefined, 128, 16, undefined, 80])
    const slide = compilePresentationSlideMarkdown(decompilePresentationSlideMarkdown(model.slides[0]!), { document: model }).slide
    expect(slide.elements.find(element => element.type === 'text')).toMatchObject({ paragraphs: text.paragraphs })
    model.slides = [slide]
    for (let round = 0; round < 2; round++) {
      const bytes = await createPresentationPptx(model)
      const xml = await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('text')
      const ends = Array.from(new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('a:endParaRPr'))
      expect(ends.map(end => Number(end.getAttribute('sz')))).toEqual(values.map(([, size]) => size))
      expect(ends[2]!.getElementsByTagName('a:latin')[0]!.getAttribute('typeface')).toBe('Georgia')
      model = await importPresentationPptx(bytes)
    }
  })

  it.each(['rect', 'line'] as const)('exports whole-object opacity on %s outlines as well as fills', async (type) => {
    for (const opacity of [0, 0.2, 0.65]) {
      const model = createBlankPresentationDocument('Faded outline')
      model.slides[0]!.elements = [{ id: 'faded', type, x: 100, y: 100, width: 500, height: type === 'line' ? 1 : 300,
        rotation: 0, fill: 'transparent', borderColor: '#000000', borderWidth: 8, opacity }]
      const bytes = await createPresentationPptx(model)
      const xml = await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('text')
      const stroke = new DOMParser().parseFromString(xml, 'text/xml').getElementsByTagName('a:ln')[0]!
      expect(stroke.getElementsByTagName('a:alpha')[0]?.getAttribute('val')).toBe(String(opacity * 100000))
      const reopened = (await importPresentationPptx(bytes)).slides[0]!.elements[0]!
      if (opacity === 0) expect(reopened).toBeUndefined()
      else expect(reopened).toMatchObject({ type, fill: 'transparent', borderColor: '#000000', borderWidth: 8, opacity })
    }
  })

  it('keeps outline interiors transparent and their borders visible through export and reopening', async () => {
    let model = createBlankPresentationDocument('Outline')
    model.slides[0]!.background = '#152945'
    model.slides[0]!.elements = [{ id: 'outline', type: 'rect', x: 80, y: 80, width: 500, height: 300, rotation: 0,
      fill: 'transparent', borderColor: '#FFCC00', borderWidth: 3 }]
    for (let count = 0; count < 2; count++) {
      model = await importPresentationPptx(await createPresentationPptx(model))
      expect(model.slides[0]!.elements[0]).toMatchObject({ fill: 'transparent', borderColor: '#FFCC00', borderWidth: 3 })
      expect(model.slides[0]!.elements[0]!.opacity ?? 1).toBe(1)
    }
  })

  it('keeps matching fill and border opacity editable through repeated exports', async () => {
    let model = createBlankPresentationDocument('Faded filled shape')
    model.slides[0]!.elements = [{ id: 'faded', type: 'rect', x: 100, y: 100, width: 400, height: 200, rotation: 0,
      fill: '#FF0000', borderColor: '#000000', borderWidth: 8, opacity: 0.25 }]
    for (let count = 0; count < 2; count++) {
      model = await importPresentationPptx(await createPresentationPptx(model))
      expect(model.slides[0]!.elements[0]).toMatchObject({ type: 'rect', fill: '#FF0000', borderColor: '#000000', borderWidth: 8, opacity: 0.25 })
    }
  })

  it('preserves independent run alpha, including an invisible first run and a partially visible suffix', async () => {
    const runs = [0, 100000, 25000].map((alpha, index) => `<a:r><a:rPr sz="3000"><a:solidFill><a:srgbClr val="000000"><a:alpha val="${alpha}"/></a:srgbClr></a:solidFill></a:rPr><a:t>${['Hidden ', 'Visible ', 'Faded'][index]}</a:t></a:r>`).join('')
    const model = await readFixture(shape(1, 100, textBody('', runs)))
    for (const document of [model, await importPresentationPptx(await createPresentationPptx(model))]) {
      const text = firstText(document)
      expect(text.opacity ?? 1).toBe(1)
      expect([0, 7, 15].map(offset => presentationTextStyleAt(text, offset).opacity ?? 1)).toEqual([0, 1, 0.25])
      const markup = preview(document)
      expect(markup).toContain('color-mix(in srgb, #000000 0%, transparent)')
      expect(markup).toContain('color-mix(in srgb, #000000 25%, transparent)')
    }
    firstText(model).opacity = 0.5
    const faded = firstText(await importPresentationPptx(await createPresentationPptx(model)))
    expect([0, 7, 15].map(offset => presentationTextStyleAt(faded, offset).opacity ?? 1)).toEqual([0, 0.5, 0.125])
    const single = await readFixture(shape(1, 100, textBody('', runs.slice(0, runs.indexOf('</a:r>') + 6))))
    expect(presentationTextStyleAt(firstText(single), 0).opacity).toBe(0)
  })

  it('retains custom bullet characters, marker fonts, and roman numbering after export and reopening', async () => {
    const body = '<p:txBody><a:bodyPr/><a:p><a:pPr><a:buFont typeface="Arial"/><a:buChar char="◆"/></a:pPr><a:r><a:t>Diamond</a:t></a:r></a:p><a:p><a:pPr><a:buAutoNum type="romanUcPeriod"/></a:pPr><a:r><a:t>First</a:t></a:r></a:p><a:p><a:pPr><a:buAutoNum type="romanUcPeriod"/></a:pPr><a:r><a:t>Second</a:t></a:r></a:p></p:txBody>'
    let model = await readFixture(shape(1, 100, body))
    for (let count = 0; count < 2; count++) {
      const text = firstText(model)
      expect(presentationTextDisplaySegments(text).map(segment => segment.text).join('')).toBe('◆ Diamond\nI. First\nII. Second')
      expect(presentationTextDisplaySegments(text)[0]!.style.fontFamily).toBe('Arial')
      const bytes = await createPresentationPptx(model)
      const xml = await (await JSZip.loadAsync(bytes)).file('ppt/slides/slide1.xml')!.async('text')
      expect(xml).toContain('<a:buFont typeface="Arial"/>')
      expect(xml).toContain('<a:buChar char="◆"/>')
      expect(xml).toContain('<a:buAutoNum type="romanUcPeriod"/>')
      model = await importPresentationPptx(bytes)
    }
  })
  it('preserves authored numbering, continuation, nesting and restarts after non-list paragraphs', async () => {
    const paragraphs = [
      ['Heading', '<a:buNone/>', 0], ['First', '<a:buAutoNum type="arabicPeriod" startAt="5"/>', 0],
      ['Nested', '<a:buAutoNum type="arabicPeriod"/>', 1], ['Nested next', '<a:buAutoNum type="arabicPeriod"/>', 1],
      ['Second', '<a:buAutoNum type="arabicPeriod" startAt="5"/>', 0], ['Break', '<a:buNone/>', 0],
      ['Restart', '<a:buAutoNum type="arabicPeriod" startAt="9"/>', 0], ['Continue', '<a:buAutoNum type="arabicPeriod"/>', 0],
    ] as const
    const body = `<p:txBody><a:bodyPr/>${paragraphs.map(([text, bullet, level]) => `<a:p><a:pPr lvl="${level}">${bullet}</a:pPr><a:r><a:t>${text}</a:t></a:r></a:p>`).join('')}</p:txBody>`
    const model = await readFixture(shape(1, 100, body))
    for (const document of [model, await importPresentationPptx(await createPresentationPptx(model))]) {
      expect(presentationTextDisplaySegments(firstText(document)).map(segment => segment.text).join('')).toBe(
        'Heading\n5. First\n1. Nested\n2. Nested next\n6. Second\nBreak\n9. Restart\n10. Continue',
      )
    }
  })

  it.each([0, 1])('keeps borderless ellipses borderless through repeated export/import with width=%s', async (borderWidth) => {
    let model = createBlankPresentationDocument('Borderless')
    model.slides[0]!.elements = [{ id: 'circle', type: 'ellipse', x: 40, y: 40, width: 200, height: 100, rotation: 0,
      fill: '#745ADD', borderColor: 'transparent', borderWidth }]
    for (let count = 0; count < 2; count++) {
      model = await importPresentationPptx(await createPresentationPptx(model))
      expect(model.slides[0]!.elements[0]).toMatchObject({ type: 'ellipse', fill: '#745ADD', borderColor: 'transparent', borderWidth: 0 })
    }
  })

  it.each([false, true])('honors explicit no-fill strokes over theme line references, including SVG shapes=%s', async (svg) => {
    let tree = shape(1, 100).replace('</p:spPr>', `<a:ln w="12700"><a:noFill/></a:ln></p:spPr><p:style><a:lnRef idx="1"><a:srgbClr val="000000"/></a:lnRef></p:style>`)
    if (svg) tree = tree.replace('<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>', '<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="FF0000"/></a:gs><a:gs pos="100000"><a:srgbClr val="0000FF"/></a:gs></a:gsLst></a:gradFill>')
    const element = (await readFixture(tree)).slides[0]!.elements[0]!
    if (svg) {
      if (element.type !== 'image') throw new Error('Expected SVG image')
      expect(atob(element.source.dataUrl.split(',')[1]!)).toContain('stroke-width="0"')
    } else expect(element).toMatchObject({ borderColor: 'transparent', borderWidth: 0 })
  })

  it('preserves partially transparent strokes without fading the fill', async () => {
    const tree = shape(1, 100).replace('</p:spPr>', '<a:ln w="12700"><a:solidFill><a:srgbClr val="000000"><a:alpha val="25000"/></a:srgbClr></a:solidFill></a:ln></p:spPr>')
    const element = (await readFixture(tree)).slides[0]!.elements[0]!
    if (element.type !== 'image') throw new Error('Expected SVG image')
    const svg = atob(element.source.dataUrl.split(',')[1]!)
    expect(svg).toContain('stroke-opacity="0.25"')
    expect(svg).toContain('fill-opacity="1"')
  })
  it('writes legal rich-text paragraphs, including soft breaks, blank paragraphs, and hyperlink relationships', async () => {
    const model = createBlankPresentationDocument('Rich text')
    model.slides[0]!.elements = [{
      id: 'rich', type: 'text', text: 'First\nSecond\n\nThird', x: 40, y: 40, width: 500, height: 250, rotation: 0,
      fontSize: 32, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left',
      hyperlink: { type: 'url', url: 'https://example.com/?a=1&b=2' },
      textRuns: [{ start: 0, end: 5, style: { fontWeight: 700 } }, { start: 6, end: 12, style: { fontSize: 20 } }],
      paragraphs: [{ start: 0, end: 12, style: { align: 'center', lineSpacing: 40 } },
        { start: 13, end: 13, style: {} }, { start: 14, end: 19, style: { align: 'right', lineSpacing: 64 } }],
    }]
    const bytes = await createPresentationPptx(model)
    const zip = await JSZip.loadAsync(bytes)
    const xml = new DOMParser().parseFromString(await zip.file('ppt/slides/slide1.xml')!.async('text'), 'text/xml')
    const paragraphs = Array.from(xml.getElementsByTagName('a:p'))
    expect(paragraphs).toHaveLength(3)
    for (const paragraph of paragraphs) {
      expect(paragraph.getElementsByTagName('a:pPr')).toHaveLength(1)
      expect(paragraph.firstChild?.nodeName).toBe('a:pPr')
    }
    expect(xml.getElementsByTagName('a:br')).toHaveLength(1)
    for (const text of Array.from(xml.getElementsByTagName('a:t'))) expect(text.textContent).not.toMatch(/[\r\n]/)
    expect(paragraphs[1]!.getElementsByTagName('a:r')).toHaveLength(0)
    const links = Array.from(xml.getElementsByTagName('a:hlinkClick'))
    expect(links.length).toBeGreaterThan(0)
    const rels = new DOMParser().parseFromString(await zip.file('ppt/slides/_rels/slide1.xml.rels')!.async('text'), 'text/xml')
    for (const link of links) expect(Array.from(rels.getElementsByTagName('Relationship')).map(rel => rel.getAttribute('Id'))).toContain(link.getAttribute('r:id'))
    const restored = firstText(await importPresentationPptx(bytes))
    expect(restored.text).toBe('First\nSecond\n\nThird')
    expect(restored.paragraphs?.map(paragraph => [paragraph.start, paragraph.end, paragraph.style.align])).toEqual([[0, 12, 'center'], [13, 13, 'left'], [14, 19, 'right']])
    expect(presentationTextStyleAt(restored, 6).fontSize).toBeCloseTo(20)
  })

  it('preserves different paragraph alignments and spacing in previews and exported files', async () => {
    const body = '<p:txBody><a:bodyPr/><a:p><a:pPr algn="l"><a:lnSpc><a:spcPts val="2400"/></a:lnSpc><a:spcAft><a:spcPts val="600"/></a:spcAft></a:pPr><a:r><a:rPr sz="1800"/><a:t>First</a:t></a:r></a:p><a:p><a:pPr algn="r"><a:lnSpc><a:spcPts val="4800"/></a:lnSpc><a:spcBef><a:spcPts val="300"/></a:spcBef></a:pPr><a:r><a:rPr sz="1800"/><a:t>Second</a:t></a:r><a:br/><a:r><a:rPr sz="1800"/><a:t>Third</a:t></a:r></a:p></p:txBody>'
    const model = await readFixture(shape(1, 100, body))
    for (const document of [model, await importPresentationPptx(await createPresentationPptx(model))]) {
      expect(firstText(document).paragraphs).toEqual([
        { start: 0, end: 5, style: expect.objectContaining({ align: 'left', lineSpacing: 32, spaceAfter: 8 }) },
        { start: 6, end: 18, style: expect.objectContaining({ align: 'right', lineSpacing: 64, spaceBefore: 4 }) },
      ])
      const html = preview(document)
      expect(html).toContain('text-align:right')
      expect(html).toContain('line-height:64px')
      expect(html).toContain('padding-top:4px')
      expect(html).toContain('padding-bottom:8px')
    }
  })

  it.each(['major', 'minor'] as const)('resolves fontRef-only %s fonts and still honors explicit run fonts', async (collection) => {
    const theme = `<a:theme ${ns}><a:themeElements><a:fontScheme name="Brand"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface="Songti SC"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface="PingFang SC"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`
    const body = `<p:style><a:fontRef idx="${collection}"><a:schemeClr val="tx1"/></a:fontRef></p:style>${textBody('', '<a:r><a:t>Heading</a:t></a:r><a:r><a:t>标题</a:t></a:r><a:r><a:rPr><a:latin typeface="Courier New"/></a:rPr><a:t>Explicit</a:t></a:r>')}`
    const text = firstText(await readFixture(shape(1, 100, body), undefined, undefined, { 'ppt/theme/theme1.xml': theme }))
    expect(presentationTextStyleAt(text, 0).fontFamily).toBe(collection === 'major' ? 'Georgia' : 'Arial')
    expect(presentationTextStyleAt(text, 7).fontFamily).toBe(collection === 'major' ? 'Songti SC' : 'PingFang SC')
    expect(presentationTextStyleAt(text, 9).fontFamily).toBe('Courier New')
  })

  it.each(['0', 'false', '1'] as const)('honors showMasterSp="%s" on slides and layouts', async (flag) => {
    const rel = (type: string, target: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="ref" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/></Relationships>`
    const extras = (layoutFlag: string) => ({
      'ppt/slides/_rels/slide1.xml.rels': rel('slideLayout', '../slideLayouts/slideLayout1.xml'),
      'ppt/slideLayouts/slideLayout1.xml': `<p:sldLayout ${ns} showMasterSp="${layoutFlag}"><p:cSld><p:spTree>${shape(2, 200)}</p:spTree></p:cSld></p:sldLayout>`,
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rel('slideMaster', '../slideMasters/slideMaster1.xml'),
      'ppt/slideMasters/slideMaster1.xml': `<p:sldMaster ${ns}><p:cSld><p:spTree>${shape(3, 300)}</p:spTree></p:cSld></p:sldMaster>`,
    })
    const slideHidden = await readFixture(shape(1, 100), undefined, undefined, extras('1'), `showMasterSp="${flag}"`)
    expect(slideHidden.slides[0]!.elements.map(element => element.x)).toEqual(flag === '1' ? [300, 200, 100] : [100])
    const layoutHidden = await readFixture(shape(1, 100), undefined, undefined, extras(flag))
    expect(layoutHidden.slides[0]!.elements.map(element => element.x)).toEqual(flag === '1' ? [300, 200, 100] : [200, 100])
  })

  it('draws ellipse and round-rectangle previews at the same bounds and radii as the canvas', () => {
    const model = createBlankPresentationDocument('Shapes')
    model.slides[0]!.elements = ['ellipse', 'roundRect'].map((type, index) => ({
      id: type, type: type as 'ellipse' | 'roundRect', x: index * 300, y: 0, width: 200, height: 100, rotation: 0,
      fill: '#FF0000', borderColor: 'transparent', borderWidth: 0,
    }))
    const xml = new DOMParser().parseFromString(preview(model), 'text/xml')
    const ellipse = xml.getElementsByTagName('ellipse')[0]!
    expect([ellipse.getAttribute('cx'), ellipse.getAttribute('cy'), ellipse.getAttribute('rx'), ellipse.getAttribute('ry')]).toEqual(['50', '50', '50', '50'])
    const rounded = Array.from(xml.getElementsByTagName('rect')).find(node => node.hasAttribute('rx'))!
    expect(Number(rounded.getAttribute('rx')) / 100 * 200).toBeCloseTo(12)
    expect(Number(rounded.getAttribute('ry')) / 100 * 100).toBeCloseTo(12)
  })

  it('applies auto-fit font scale and subtracts percentage line-spacing reduction', async () => {
    const body = '<p:txBody><a:bodyPr><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr><a:p><a:pPr><a:lnSpc><a:spcPct val="120000"/></a:lnSpc></a:pPr><a:r><a:rPr sz="3000"/><a:t>Heading</a:t></a:r><a:r><a:rPr sz="1500"/><a:t>Body</a:t></a:r></a:p></p:txBody>'
    const model = await readFixture(shape(1, 100, body))
    expect(firstText(model).fontSize).toBeCloseTo(25)
    expect(firstText(model).lineHeight).toBeCloseTo(1)
    expect(presentationTextStyleAt(firstText(model), 7).fontSize).toBeCloseTo(12.5)
    const restored = await importPresentationPptx(await createPresentationPptx(model))
    expect(firstText(restored).fontSize).toBeCloseTo(25, 1)
    expect(presentationTextStyleAt(firstText(restored), 7).fontSize).toBeCloseTo(12.5, 1)
  })

  it('resolves run defaults from each paragraph level while retaining explicit overrides', async () => {
    const body = '<p:txBody><a:bodyPr/><a:lstStyle><a:lvl1pPr><a:defRPr sz="3000" b="1"/></a:lvl1pPr><a:lvl2pPr><a:defRPr sz="1500" b="0"/></a:lvl2pPr></a:lstStyle><a:p><a:pPr lvl="0"/><a:r><a:t>Heading</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Body</a:t></a:r><a:r><a:rPr sz="1200"/><a:t>Note</a:t></a:r></a:p></p:txBody>'
    const text = firstText(await readFixture(shape(1, 100, body)))
    expect(presentationTextStyleAt(text, 0)).toMatchObject({ fontSize: 40, fontWeight: 700 })
    expect(presentationTextStyleAt(text, 8)).toMatchObject({ fontSize: 20, fontWeight: 400 })
    expect(presentationTextStyleAt(text, 12)).toMatchObject({ fontSize: 16, fontWeight: 400 })
  })

  it('resolves theme fonts including supplemental East Asian scripts', async () => {
    const theme = `<a:theme ${ns}><a:themeElements><a:fontScheme name="Branded"><a:majorFont><a:latin typeface="Georgia"/><a:ea typeface="Songti SC"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:font script="Hans" typeface="PingFang SC"/><a:font script="Jpan" typeface="Hiragino Sans"/></a:minorFont></a:fontScheme></a:themeElements></a:theme>`
    const runs = '<a:r><a:rPr><a:ea typeface="+mj-ea"/></a:rPr><a:t>标题</a:t></a:r><a:r><a:rPr><a:latin typeface="+mj-lt"/></a:rPr><a:t>Title</a:t></a:r><a:r><a:rPr lang="zh-CN"><a:ea typeface="+mn-ea"/></a:rPr><a:t>正文</a:t></a:r><a:r><a:rPr lang="ja-JP"><a:ea typeface="+mn-ea"/></a:rPr><a:t>日本語</a:t></a:r>'
    const model = await readFixture(shape(1, 100, textBody('', runs)), undefined, undefined, { 'ppt/theme/theme1.xml': theme })
    const text = firstText(model)
    expect(text.fontFamily).toBe('Songti SC')
    expect(presentationTextStyleAt(text, 2).fontFamily).toBe('Georgia')
    expect(presentationTextStyleAt(text, 7).fontFamily).toBe('PingFang SC')
    expect(presentationTextStyleAt(text, 9).fontFamily).toBe('Hiragino Sans')
  })

  it('keeps fixed line spacing independent of font scale and after export', async () => {
    const body = '<p:txBody><a:bodyPr><a:normAutofit fontScale="62500" lnSpcReduction="20000"/></a:bodyPr><a:p><a:pPr><a:lnSpc><a:spcPts val="4800"/></a:lnSpc></a:pPr><a:r><a:rPr sz="1800"/><a:t>Line one</a:t></a:r><a:br/><a:r><a:rPr sz="2400"/><a:t>Line two</a:t></a:r></a:p></p:txBody>'
    const model = await readFixture(shape(1, 100, body))
    expect(firstText(model).lineSpacing).toBeCloseTo(64)
    expect(preview(model)).toContain('line-height:64px')
    const restored = await importPresentationPptx(await createPresentationPptx(model))
    expect(firstText(restored).lineSpacing).toBeCloseTo(64)
  })

  it('normalizes font size and insets using the physical slide dimensions', async () => {
    const small = await readFixture(shape(1, 100, textBody()), 5143500, 9144000)
    const standard = await readFixture(shape(1, 100, textBody()))
    expect(firstText(small).fontSize).toBeCloseTo(32)
    expect(firstText(standard).fontSize).toBeCloseTo(24)
    expect(firstText(small).textInsets!.left).toBeCloseTo(firstText(standard).textInsets!.left * 4 / 3)
  })

  it('scales text and insets together with nested group geometry', async () => {
    const group = `<p:grpSp><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(200)}" cy="${emu(100)}"/><a:chOff x="0" y="0"/><a:chExt cx="${emu(400)}" cy="${emu(200)}"/></a:xfrm></p:grpSpPr>${shape(1, 100, textBody())}</p:grpSp>`
    const text = firstText(await readFixture(group))
    expect(text.fontSize).toBeCloseTo(12)
    expect(text.width).toBeCloseTo(50)
    expect(text.textInsets!.left).toBeCloseTo(4.8)
  })

  it('rotates positions around the group center and preserves them when exported again', async () => {
    const group = `<p:grpSp><p:grpSpPr><a:xfrm rot="5400000"><a:off x="0" y="0"/><a:ext cx="${emu(400)}" cy="${emu(200)}"/><a:chOff x="0" y="0"/><a:chExt cx="${emu(400)}" cy="${emu(200)}"/></a:xfrm></p:grpSpPr>${shape(1, 100)}${shape(2, 250)}</p:grpSp>`
    const model = await readFixture(group)
    const [a, b] = model.slides[0]!.elements
    expect(b!.x - a!.x).toBeCloseTo(0)
    expect(b!.y - a!.y).toBeCloseTo(150)
    expect(a!.rotation).toBeCloseTo(90)
    const restored = await importPresentationPptx(await createPresentationPptx(model))
    for (const [index, element] of restored.slides[0]!.elements.entries()) {
      expect(element.x).toBeCloseTo(model.slides[0]!.elements[index]!.x, 2)
      expect(element.y).toBeCloseTo(model.slides[0]!.elements[index]!.y, 2)
      expect(element.rotation).toBeCloseTo(90)
    }
  })

  it('composes nested group rotations and group mirroring', async () => {
    const wrap = (children: string, attributes: string) => `<p:grpSp><p:grpSpPr><a:xfrm ${attributes}><a:off x="0" y="0"/><a:ext cx="${emu(400)}" cy="${emu(200)}"/><a:chOff x="0" y="0"/><a:chExt cx="${emu(400)}" cy="${emu(200)}"/></a:xfrm></p:grpSpPr>${children}</p:grpSp>`
    const rotated = await readFixture(wrap(wrap(`${shape(1, 100)}${shape(2, 250)}`, 'rot="5400000"'), 'rot="5400000"'))
    const [a, b] = rotated.slides[0]!.elements
    expect(b!.x - a!.x).toBeCloseTo(-150)
    expect(b!.y - a!.y).toBeCloseTo(0)
    const mirrored = await readFixture(wrap(`${shape(1, 100)}${shape(2, 250)}`, 'flipH="1"'))
    expect(mirrored.slides[0]!.elements[0]!.flipVertical).toBe(true)
    expect(preview(mirrored)).toContain('scale(1, -1)')
  })

  it('uses the same mirror transform for shapes, pictures, cropping and slideshow output', async () => {
    const model = await readFixture(shape(1, 100))
    const base = model.slides[0]!.elements[0]!
    model.slides[0]!.elements = [{ ...base, type: 'image', flipHorizontal: true, flipVertical: true, fit: 'cover',
      altText: 'asymmetric image', source: { dataUrl: 'data:image/png;base64,AA==', fileName: 'image.png', mimeType: 'image/png' },
      crop: { left: 0.1, right: 0.2, top: 0, bottom: 0 },
    }]
    expect(preview(model)).toContain('translate(100px, 50px) scale(-1, -1)')
    const image = model.slides[0]!.elements[0]!
    if (image.type !== 'image') throw new Error('Missing image')
    delete image.crop
    expect(preview(model)).toContain('translate(100px, 50px) scale(-1, -1)')
  })

  it.each([['vert', 90], ['vert270', -90]] as const)('lays out %s text in a rotated inner frame', async (direction, angle) => {
    const model = await readFixture(shape(1, 100, textBody(direction)))
    expect(preview(model)).toContain(`rotate(${angle}deg)`)
    const restored = await importPresentationPptx(await createPresentationPptx(model))
    expect(firstText(restored).textDirection).toBe(direction === 'vert' ? 'vertical' : 'vertical270')
  })

  it('preserves bilingual run styles, explicit breaks and inherited defaults after export', async () => {
    const runs = '<a:pPr><a:defRPr sz="2400" b="1"/></a:pPr><a:r><a:rPr lang="zh-CN"/><a:t>北京大学</a:t></a:r><a:br/><a:r><a:rPr sz="1400" b="0"><a:solidFill><a:srgbClr val="0088CC"/></a:solidFill></a:rPr><a:t>Peking University</a:t></a:r>'
    const model = await readFixture(shape(1, 100, textBody('', runs)))
    for (const document of [model, await importPresentationPptx(await createPresentationPptx(model))]) {
      const text = firstText(document)
      expect(text.text).toBe('北京大学\nPeking University')
      expect(presentationTextStyleAt(text, 0).fontSize).toBeCloseTo(32)
      expect(presentationTextStyleAt(text, 5).fontSize).toBeCloseTo(14 * 4 / 3)
      expect(presentationTextStyleAt(text, 5).fontWeight).toBe(400)
      expect(presentationTextStyleAt(text, 5).color).toBe('#0088CC')
    }
    expect(preview(model)).toContain('color:#0088CC')
  })

  it('shows superscripts and subscripts with the same size and offset as the canvas', async () => {
    const model = await readFixture(shape(1, 100, textBody()))
    const text = firstText(model)
    text.baseline = 'superscript'
    const superscript = preview(model).match(/font-size:([\d.]+)px[^>]*top:([-\d.]+)px/)
    expect(Number(superscript?.[1])).toBeCloseTo(14.4)
    expect(Number(superscript?.[2])).toBeCloseTo(-8.4)
    text.baseline = 'subscript'
    expect(preview(model)).toContain('top:2.64')
  })
})
