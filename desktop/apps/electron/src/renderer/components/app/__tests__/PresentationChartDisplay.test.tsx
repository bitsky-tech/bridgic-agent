import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { DOMParser } from '@xmldom/xmldom'
import JSZip from 'jszip'
import type { PresentationChartElement, PresentationDocument } from '@/atoms/presentation'

GlobalRegistrator.register()
const { renderToStaticMarkup } = await import('react-dom/server')
const fabric = await import('fabric')
const { createBlankPresentationDocument } = await import('@/atoms/presentation')
const { createPresentationChartElement, createPresentationTableElement } = await import('@/lib/presentationInsert')
const { createPresentationPptx } = await import('@/lib/presentationPptx')
const { importPresentationPptx } = await import('@/lib/presentationPptxImport')
const { applyPresentationDesign } = await import('@/lib/presentationDesign')
const { compilePresentationSlideMarkdown, decompilePresentationSlideMarkdown } = await import('@/lib/presentationMarkdown')
const { PresentationSlidePreview } = await import('../PresentationSlidePreview')
const { createPresentationFabricObject } = await import('../PresentationWorkbenchPanel')
const parse = (xml: string) => new DOMParser().parseFromString(xml, 'text/xml')
const chartNs = 'http://schemas.openxmlformats.org/drawingml/2006/chart'

function documentFor(element: PresentationDocument['slides'][number]['elements'][number]) {
  const model = createBlankPresentationDocument('Chart fidelity')
  model.slides[0]!.elements = [element]
  return model
}

function markup(model: PresentationDocument) {
  const host = document.createElement('div')
  host.innerHTML = renderToStaticMarkup(<PresentationSlidePreview slide={model.slides[0]!} selected={false} width={1280} />)
  return host
}

function agentEdit(model: PresentationDocument): PresentationDocument {
  return { ...model, slides: [compilePresentationSlideMarkdown(decompilePresentationSlideMarkdown(model.slides[0]!), { document: model }).slide] }
}

afterAll(() => GlobalRegistrator.unregister())

describe('chart and table display round trips', () => {
  const context = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
  beforeEach(() => Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true, value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 8 }) }),
  }))
  afterEach(() => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', context)
    fabric.cache.clearFontCache()
  })

  it.each(['column', 'bar', 'line'] as const)('retains readable %s scales in both renderers after export and Agent edits', async chartType => {
    for (const values of [[4, 7, 5, 8], [400, 700, 500, 800], [-3.5, -1.75, 2.25, 7], [-8, -7, -5, -4], [0, 0, 0, 0], [4e8, 7e8, 5e8, 8e8], [4e-8, 7e-8, 5e-8, 8e-8], [-0.00035, 0.000175, 0.000225, 0.0007]]) {
      let model = documentFor({ ...createPresentationChartElement(chartType), showValue: false,
        categories: ['A', 'B', 'C', 'D'], series: [{ name: 'Sales', values }], valueAxisLabelColor: '#156589',
        ...(values[0] === -0.00035 ? { width: 180, height: 140 } : {}) })
      for (let round = 0; round < 2; round++) {
        const host = markup(model)
        const ticks = [...host.querySelectorAll('[data-testid="presentation-chart-value-tick"]')]
        const labels = ticks.map(node => node.textContent!)
        expect(labels.length).toBeGreaterThanOrEqual(2)
        expect(new Set(labels).size).toBe(labels.length)
        expect(labels.every(label => Number.isFinite(Number(label)))).toBe(true)
        expect(Number(labels[0])).toBe(Math.min(0, ...values))
        expect(Number(labels.at(-1))).toBe(Math.max(0, ...values) || (values.every(value => value === 0) ? 1 : 0))
        const group = await createPresentationFabricObject(fabric, model.slides[0]!.elements[0]!, () => undefined)
        if (!(group instanceof fabric.Group)) throw new Error('Missing editable chart')
        try {
          const canvasTicks = group.getObjects().filter(object => object instanceof fabric.FabricText && object.fill === '#156589') as InstanceType<typeof fabric.FabricText>[]
          expect(canvasTicks.map(object => object.text)).toEqual(labels)
          expect(canvasTicks.map(object => object.fontSize)).toEqual(ticks.map(node => Number(node.getAttribute('font-size'))))
          expect(ticks.every(node => node.getAttribute('fill') === '#156589')).toBe(true)
          if (chartType === 'bar') {
            const edges = ticks.map(node => {
              const x = Number(node.getAttribute('x')), width = node.textContent!.length * Number(node.getAttribute('font-size')) * 0.7
              const anchor = node.getAttribute('text-anchor')
              const left = anchor === 'end' ? x - width : x
              return { left: anchor === 'middle' ? x - width / 2 : left, width }
            })
            edges.slice(1).forEach((edge, index) => expect(edge.left - edges[index]!.left - edges[index]!.width).toBeGreaterThanOrEqual(5.9))
          }
          for (const tick of canvasTicks) {
            tick.setCoords()
            const bounds = tick.getBoundingRect()
            expect(bounds.left).toBeGreaterThanOrEqual(group.left - 1)
            expect(bounds.left + bounds.width).toBeLessThanOrEqual(group.left + group.getScaledWidth() + 1)
          }
        } finally { group.dispose() }
        model = await importPresentationPptx(await createPresentationPptx(agentEdit(model)))
      }
    }
  })

  it.each(['column', 'bar', 'line', 'pie', 'doughnut'] as const)('keeps %s blanks distinct from zero in chart caches, workbooks and Agent edits', async chartType => {
    const element = { ...createPresentationChartElement(chartType), categories: ['A', 'B', 'C', 'D', 'E'],
      series: [{ name: 'North', values: [null, 0, 19, null, 37] }, { name: 'South', values: [1, null, 0, 4, null] }] }
    if (chartType === 'pie' || chartType === 'doughnut') element.series = element.series.slice(0, 1)
    for (const displayBlanksAs of ['gap', 'span', 'zero'] as const) {
      let model = documentFor({ ...element, displayBlanksAs })
      for (let round = 0; round < 2; round++) {
        model = agentEdit(model)
        const bytes = await createPresentationPptx(model)
        const zip = await JSZip.loadAsync(bytes)
        const chartPath = Object.keys(zip.files).find(path => /^ppt\/charts\/chart\d+\.xml$/.test(path))!
        const chart = parse(await zip.file(chartPath)!.async('text'))
        const series = Array.from(chart.getElementsByTagNameNS(chartNs, 'ser'))
        series.forEach((node, index) => {
          const data = node.getElementsByTagNameNS(chartNs, 'val')[0]!
          const points = Array.from(data.getElementsByTagNameNS(chartNs, 'pt'))
          expect(points.map(point => Number(point.getAttribute('idx')))).toEqual(element.series[index]!.values.flatMap((value, i) => value === null ? [] : [i]))
          expect(data.getElementsByTagNameNS(chartNs, 'ptCount')[0]!.getAttribute('val')).toBe('5')
        })
        const workbookPath = Object.keys(zip.files).find(path => path.endsWith('.xlsx'))!
        const workbook = await JSZip.loadAsync(await zip.file(workbookPath)!.async('uint8array'))
        const sheet = parse(await workbook.file('xl/worksheets/sheet1.xml')!.async('text'))
        const cells = new Map(Array.from(sheet.getElementsByTagName('c')).map(cell => [cell.getAttribute('r'), cell.textContent]))
        expect(cells.has('B2')).toBe(false)
        expect(cells.get('B3')).toBe('0')
        expect(cells.get('B4')).toBe('19')
        expect(cells.has('B5')).toBe(false)
        if (element.series.length > 1) {
          expect(cells.has('C3')).toBe(false)
          expect(cells.get('C4')).toBe('0')
          expect(cells.has('C6')).toBe(false)
        }
        model = await importPresentationPptx(bytes)
        expect(model.slides[0]!.elements[0]).toMatchObject({ categories: element.categories, series: element.series, displayBlanksAs })
      }
    }
  })

  it('keeps legacy malformed chart records from breaking valid chart exports', async () => {
    const chart = { ...createPresentationChartElement('line'), categories: ['A', 'B'], series: [{ name: 'Sales', values: [null, 0] }] }
    const model = documentFor(chart)
    ;(chart.series as unknown[]).unshift({ name: 'Invalid series' })
    ;(model.slides[0]!.elements as unknown[]).push({ ...chart, id: 'invalid-chart', series: undefined })
    const reopened = await importPresentationPptx(await createPresentationPptx(model))
    expect(reopened.slides[0]!.elements).toHaveLength(1)
    expect(reopened.slides[0]!.elements[0]).toMatchObject({ series: [{ name: 'Sales', values: [null, 0] }] })
  })

  it.each(['gap', 'span', 'zero'] as const)('renders line-chart blanks as %s in both renderers', async displayBlanksAs => {
    const element: PresentationChartElement = { ...createPresentationChartElement('line'), title: undefined, showLegend: false, showValue: true,
      categories: ['A', 'B', 'C'], series: [{ name: 'Sales', values: [19, null, 37] }], displayBlanksAs, dataLabelColor: '#A020F0' }
    const host = markup(documentFor(element))
    const group = await createPresentationFabricObject(fabric, element, () => undefined)
    if (!(group instanceof fabric.Group)) throw new Error('Expected editable chart group')
    try {
      const lines = group.getObjects().filter(object => object instanceof fabric.Polyline)
      const previewLines = [...host.querySelectorAll('polyline')]
      expect(lines.length).toBe(displayBlanksAs === 'gap' ? 0 : 1)
      expect(previewLines.length).toBe(lines.length)
      if (lines[0]) expect(lines[0].points.length).toBe(displayBlanksAs === 'zero' ? 3 : 2)
      expect(host.querySelectorAll('circle').length).toBe(displayBlanksAs === 'zero' ? 3 : 2)
      expect(group.getObjects().filter(object => object instanceof fabric.Circle).length).toBe(displayBlanksAs === 'zero' ? 3 : 2)
      const previewValues = [...host.querySelectorAll('text[fill="#A020F0"]')].map(node => node.textContent)
      const canvasValues = group.getObjects().flatMap(object => 'text' in object && object.fill === '#A020F0' ? [object.text] : [])
      expect(previewValues.includes('0')).toBe(displayBlanksAs === 'zero')
      expect(canvasValues.includes('0')).toBe(displayBlanksAs === 'zero')
      expect(previewValues).toContain('19')
      expect(canvasValues).toContain('37')
    } finally { group.dispose() }
  })

  it.each(['line', 'pie', 'doughnut'] as const)('shows and hides %s value labels consistently through export', async chartType => {
    for (const showValue of [false, true]) {
      let model = documentFor({ ...createPresentationChartElement(chartType), title: undefined, showLegend: false, showValue,
        categories: ['A', 'B', 'C', 'D'], series: [{ name: 'Sales', values: [null, 19, 0, 37] }], dataLabelColor: '#A020F0' })
      for (let round = 0; round < 2; round++) {
        const element = model.slides[0]!.elements[0]!
        const previewValues = [...markup(model).querySelectorAll('text[fill="#A020F0"]')].map(node => node.textContent)
        const group = await createPresentationFabricObject(fabric, element, () => undefined)
        if (!(group instanceof fabric.Group)) throw new Error('Missing editable chart')
        try {
          const canvasValues = group.getObjects().flatMap(object => 'text' in object && object.fill === '#A020F0' ? [object.text] : [])
          expect(previewValues.includes('19')).toBe(showValue)
          expect(previewValues.includes('37')).toBe(showValue)
          expect(canvasValues).toEqual(previewValues)
          expect(previewValues).not.toContain('null')
        } finally { group.dispose() }
        model = await importPresentationPptx(await createPresentationPptx(agentEdit(model)))
        expect(model.slides[0]!.elements[0]).toMatchObject({ showValue })
      }
    }
  })

  it.each([10, 50, 75, 90])('preserves a %s percent doughnut hole across native XML, preview and Fabric', async holeSize => {
    let model = documentFor({ ...createPresentationChartElement('doughnut'), title: undefined, showLegend: false, holeSize,
      categories: ['A'], series: [{ name: 'Sales', values: [37] }], chartAreaFill: 'transparent', plotAreaFill: 'transparent' })
    for (let round = 0; round < 2; round++) {
      const path = markup(model).querySelector('path')!.getAttribute('d')!
      const radii = [...path.matchAll(/A ([\d.]+)/g)].map(match => Number(match[1]))
      expect(radii[2]! / radii[0]!).toBeCloseTo(holeSize / 100)
      const group = await createPresentationFabricObject(fabric, model.slides[0]!.elements[0]!, () => undefined)
      if (!(group instanceof fabric.Group)) throw new Error('Missing ring group')
      const ring = group.getObjects().find(object => object instanceof fabric.Path)!
      expect(ring.path).toEqual(new fabric.Path(path).path)
      expect(ring.fillRule).toBe('evenodd')
      group.dispose()
      const bytes = await createPresentationPptx(agentEdit(model))
      const zip = await JSZip.loadAsync(bytes)
      const chartPath = Object.keys(zip.files).find(path => /^ppt\/charts\/chart\d+\.xml$/.test(path))!
      const chart = parse(await zip.file(chartPath)!.async('text'))
      expect(chart.getElementsByTagNameNS(chartNs, 'holeSize')[0]!.getAttribute('val')).toBe(String(holeSize))
      model = await importPresentationPptx(bytes)
      expect(model.slides[0]!.elements[0]).toMatchObject({ holeSize })
    }
  })

  it.each(['chart', 'table'] as const)('preserves %s flips and geometry across repeated exports', async type => {
    for (const flips of [{}, { flipHorizontal: true }, { flipVertical: true }, { flipHorizontal: true, flipVertical: true }]) {
      const element = { ...(type === 'chart' ? createPresentationChartElement('column') : createPresentationTableElement()), x: 173, y: 129, width: 640, height: 320, ...flips }
      let model = documentFor(element)
      for (let round = 0; round < 2; round++) {
        const bytes = await createPresentationPptx(agentEdit(model))
        const zip = await JSZip.loadAsync(bytes)
        const slide = parse(await zip.file('ppt/slides/slide1.xml')!.async('text'))
        const ids = Array.from(slide.getElementsByTagName('p:cNvPr')).map(node => node.getAttribute('id'))
        expect(new Set(ids).size).toBe(ids.length)
        model = await importPresentationPptx(bytes)
        const reopened = model.slides[0]!.elements[0]!
        expect(reopened).toMatchObject({ type, rotation: 0, x: 173, y: 129, width: 640, height: 320 })
        expect(Boolean(reopened.flipHorizontal)).toBe(Boolean(element.flipHorizontal))
        expect(Boolean(reopened.flipVertical)).toBe(Boolean(element.flipVertical))
        const group = await createPresentationFabricObject(fabric, reopened, () => undefined)
        expect(Boolean(group.flipX)).toBe(Boolean(element.flipHorizontal))
        expect(Boolean(group.flipY)).toBe(Boolean(element.flipVertical))
        group.dispose()
      }
    }
  })

  it.each(['pie', 'doughnut'] as const)('retains %s category colors after theme changes and repeated exports', async chartType => {
    for (const theme of ['light', 'midnight', 'paper', 'lavender'] as const) {
      let model = applyPresentationDesign(documentFor({ ...createPresentationChartElement(chartType),
        categories: ['A', 'B', 'C'], series: [{ name: 'Sales', values: [15, 30, 55] }] }), { theme })
      const palette = model.master.accentColors.slice(0, 3)
      for (let round = 0; round < 2; round++) {
        const fills = [...markup(model).querySelectorAll('path')].map(node => node.getAttribute('fill'))
        expect(fills).toEqual(palette)
        expect(new Set(fills).size).toBe(3)
        model = await importPresentationPptx(await createPresentationPptx(agentEdit(model)))
      }
    }
  })

  it('keeps Cartesian colors keyed by series and preserves colors on font-only edits', () => {
    const element = { ...createPresentationChartElement('line'), categories: ['A', 'B', 'C'],
      series: [{ name: 'North', values: [1, 2, 3] }, { name: 'South', values: [3, 2, 1] }] }
    const model = applyPresentationDesign(documentFor(element), { theme: 'light' })
    expect((model.slides[0]!.elements[0] as PresentationChartElement).colors).toEqual(model.master.accentColors.slice(0, 2))
    expect(applyPresentationDesign(model, { bodyFontFamily: 'Arial' }).slides[0]!.elements[0]).toEqual(model.slides[0]!.elements[0])
    const recolored = applyPresentationDesign(documentFor({ ...element, chartType: 'pie', series: element.series.slice(0, 1) }),
      { accentColors: ['#AA0000', '#00AA00', '#0000AA'] })
    expect((recolored.slides[0]!.elements[0] as PresentationChartElement).colors).toHaveLength(3)
  })

  it.each(['line', 'bar', 'column', 'pie', 'doughnut'] as const)('keeps %s labels readable on the actual chart and plot surfaces through export', async chartType => {
    const luminance = (color: string) => {
      const [r, g, b] = color.slice(1).match(/../g)!.map(hex => {
        const value = Number.parseInt(hex, 16) / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return r! * 0.2126 + g! * 0.7152 + b! * 0.0722
    }
    const contrast = (a: string, b: string) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
    for (const fills of [{}, { chartAreaFill: '#17182B' }, { chartAreaFill: 'transparent', plotAreaFill: 'transparent' },
      { chartAreaFill: '#FFFFFF', plotAreaFill: '#17182B' }, { chartAreaFill: '#17182B', plotAreaFill: '#FFFFFF' }]) {
      for (const theme of ['light', 'midnight'] as const) {
        let model = applyPresentationDesign(documentFor({ ...createPresentationChartElement(chartType), ...fills,
          title: 'Sales', showValue: true, categories: ['A', 'B'], series: [{ name: 'North', values: [19, 37] }] }), { theme })
        for (let round = 0; round < 2; round++) {
          const element = model.slides[0]!.elements[0] as PresentationChartElement
          const background = element.chartAreaFill === 'transparent' ? model.slides[0]!.background : element.chartAreaFill ?? '#FFFFFF'
          const plot = !element.plotAreaFill || element.plotAreaFill === 'transparent' ? background : element.plotAreaFill
          const host = markup(model)
          const label = [...host.querySelectorAll('text')].find(node => node.textContent === '19')!
          if (chartType !== 'pie' && chartType !== 'doughnut') {
            expect(contrast(label.getAttribute('fill')!, plot)).toBeGreaterThanOrEqual(4.5)
          }
          const title = [...host.querySelectorAll('text')].find(node => node.textContent === 'Sales')!
          expect(contrast(title.getAttribute('fill')!, background)).toBeGreaterThanOrEqual(4.5)
          const group = await createPresentationFabricObject(fabric, element, () => undefined)
          if (!(group instanceof fabric.Group)) throw new Error('Missing chart group')
          const canvasTitle = group.getObjects().find(object => 'text' in object && object.text === 'Sales')!
          expect(canvasTitle.fill).toBe(title.getAttribute('fill'))
          group.dispose()
          model = await importPresentationPptx(await createPresentationPptx(agentEdit(model)))
        }
      }
    }
  })

  it('preserves table line breaks and confines long cell text to its own row, including flipped tables', async () => {
    const cells = [['Item', 'Description'], ['Delivery', 'First line\nSecond line\nThird line\nFourth line\nFifth line'], ['Owner', 'Operations']]
    for (const flipHorizontal of [false, true]) for (const flipVertical of [false, true]) {
      let model = documentFor({ ...createPresentationTableElement(cells), x: 180, y: 140, width: 720, height: 240,
        fontSize: 24, flipHorizontal, flipVertical })
      for (let round = 0; round < 2; round++) {
        const element = model.slides[0]!.elements[0]!
        const td = markup(model).querySelectorAll('td')[3]!
        expect(td.textContent).toBe(cells[1]![1]!)
        expect(td.querySelector<HTMLElement>('[style*="white-space"]')!.style.whiteSpace).toBe('pre-wrap')
        const group = await createPresentationFabricObject(fabric, element, () => undefined)
        if (!(group instanceof fabric.Group)) throw new Error('Missing table group')
        expect(group).toMatchObject({ left: 180, top: 140, width: 720, height: 240 })
        const texts = group.getObjects().filter(object => object instanceof fabric.Textbox)
        expect(texts.map(text => text.text)).toEqual(cells.flat())
        texts.forEach((text, index) => {
          expect(text.fontSize).toBeCloseTo(24)
          const clip = text.clipPath!
          expect(clip).toBeDefined()
          const matrix = fabric.util.multiplyTransformMatrices(text.calcTransformMatrix(), clip.calcOwnMatrix())
          const a = fabric.util.transformPoint(new fabric.Point(-clip.width / 2, -clip.height / 2), matrix)
          const b = fabric.util.transformPoint(new fabric.Point(clip.width / 2, clip.height / 2), matrix)
          const column = flipHorizontal ? 1 - index % 2 : index % 2
          const row = flipVertical ? 2 - Math.floor(index / 2) : Math.floor(index / 2)
          expect(Math.min(a.x, b.x)).toBeCloseTo(180 + column * 360 + 10)
          expect(Math.max(a.x, b.x)).toBeCloseTo(180 + (column + 1) * 360 - 10)
          expect(Math.min(a.y, b.y)).toBeCloseTo(140 + row * 80 + 4)
          expect(Math.max(a.y, b.y)).toBeCloseTo(140 + (row + 1) * 80 - 4)
        })
        group.dispose()
        model = await importPresentationPptx(await createPresentationPptx(agentEdit(model)))
      }
    }
  })

  it.each(['pie', 'doughnut'] as const)('separates crowded %s value labels without losing values or changing the frame', async chartType => {
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: () => ({
      font: '', textBaseline: 'alphabetic', measureText(value: string) {
        const size = Number(this.font.match(/([\d.]+)px/)?.[1] ?? 12)
        return { width: value.length * size * 0.65 }
      },
    }) })
    fabric.cache.clearFontCache()
    for (const values of [[950, 10, 10, 10, 10, 10], [10, 10, 10, 10, 10, 950], [250, 250, 250, 250], [null, 0, 1000]]) {
      let model = documentFor({ ...createPresentationChartElement(chartType), showValue: true, dataLabelColor: '#A020F0',
        width: 800, height: 400, categories: values.map((_, i) => String(i)), series: [{ name: 'Sales', values }] })
      for (let round = 0; round < 2; round++) {
        const element = model.slides[0]!.elements[0] as PresentationChartElement
        const group = await createPresentationFabricObject(fabric, element, () => undefined)
        if (!(group instanceof fabric.Group)) throw new Error('Missing pie group')
        const labels = group.getObjects().filter((object): object is InstanceType<typeof fabric.FabricText> => object instanceof fabric.FabricText && object.fill === '#A020F0')
        expect(labels.map(label => label.text)).toEqual(values.filter(value => value !== null && value > 0).map(String))
        expect(group.width).toBe(800)
        expect(group.height).toBe(400)
        const previewLabels = [...markup(model).querySelectorAll('text[fill="#A020F0"]')]
        expect(previewLabels.map(label => label.textContent)).toEqual(labels.map(label => label.text))
        labels.forEach(label => label.setCoords())
        labels.forEach((label, i) => {
          const a = label.getBoundingRect()
          expect(label.getCenterPoint().y).toBeCloseTo(element.y + Number(previewLabels[i]!.getAttribute('y')))
          expect(a.left).toBeGreaterThanOrEqual(element.x)
          expect(a.left + a.width).toBeLessThanOrEqual(element.x + element.width)
          for (const other of labels.slice(i + 1)) {
            const b = other.getBoundingRect()
            expect(a.left < b.left + b.width && a.left + a.width > b.left && a.top < b.top + b.height && a.top + a.height > b.top).toBe(false)
          }
        })
        if (values.length <= 4) expect(previewLabels.every(label => label.getAttribute('text-anchor') === 'middle')).toBe(true)
        group.dispose()
        model = await importPresentationPptx(await createPresentationPptx(agentEdit(model)))
      }
    }
  })
})
