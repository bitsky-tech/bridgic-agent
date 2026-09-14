import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { PresentationTextElement } from '@/atoms/presentation'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { StrictMode, act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { renderToStaticMarkup } = await import('react-dom/server')
const { Simulate } = await import('react-dom/test-utils')
const fabric = await import('fabric')
const { createBlankPresentationDocument } = await import('@/atoms/presentation')
const {
  createPresentationImageElement,
  createPresentationMediaElement,
  createPresentationTableElement,
  createPresentationChartElement,
} = await import('@/lib/presentationInsert')
const {
  createPresentationHistoryEntry,
  createPresentationImageFabricClipPath,
  createPresentationMediaFabricObject,
  createPresentationMediaRuntime,
  createPresentationVerticalTextFabricObject,
  createPresentationTextFabricObject,
  createPresentationFabricObject,
  getPresentationTextFabricFramePatch,
  estimatePresentationDocumentBytes,
  isPresentationRotationLocked,
  PresentationNumberField,
  resolvePresentationNumberFieldValue,
  resolvePresentationSlideshowKeyAction,
  trimPresentationHistoryEntries,
} = await import('../PresentationWorkbenchPanel')
const {
  getPresentationPieSlices,
  getPresentationChartRange,
  getPresentationChartValueRatio,
  PresentationSlidePreview,
} = await import('../PresentationSlidePreview')

const { importPresentationPptx } = await import('@/lib/presentationPptxImport')
const { createPresentationPptx } = await import('@/lib/presentationPptx')
const { compilePresentationSlideMarkdown, decompilePresentationSlideMarkdown } = await import('@/lib/presentationMarkdown')

const mountedRoots = new Set<Root>()

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots) root.unmount()
    mountedRoots.clear()
  })
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function fileSource(type: string, name: string, payload = 'AA==') {
  return { dataUrl: `data:${type};base64,${payload}`, fileName: name, mimeType: type }
}

describe('presentation Insert runtime safeguards', () => {
  it.each([[0.2, 0.3], [2e-300, 3e-300], [2e300, 3e300]].map(values => [values] as const))('normalizes fractional pie data consistently in preview and Fabric: %j', async (values) => {
    const element = { ...createPresentationChartElement('pie'), width: 800, height: 400, title: undefined, showLegend: false,
      categories: ['A', 'B'], series: [{ name: 'Total', values }], colors: ['#FF6600', '#00AA88'] }
    const model = createBlankPresentationDocument('Proportions')
    model.slides[0]!.elements = [element]
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<PresentationSlidePreview slide={model.slides[0]!} selected={false} width={1280} />)
    const numbers = host.querySelector('path[fill="#FF6600"]')!.getAttribute('d')!.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)!.map(Number)
    const angle = (Math.atan2(numbers[2]! - numbers[0]!, -(numbers[3]! - numbers[1]!)) * 180 / Math.PI + 360) % 360
    expect(angle).toBeCloseTo(144)
    const group = await createPresentationFabricObject(fabric, element, () => undefined)
    if (!(group instanceof fabric.Group)) throw new Error('Missing pie group')
    const path = group.getObjects().find(object => object instanceof fabric.Path && object.fill === '#FF6600')!
    if (!(path instanceof fabric.Path)) throw new Error('Missing first pie sector')
    const start = path.path[0] as ['M', number, number]
    const end = path.path[1] as ['L', number, number]
    const fabricAngle = (Math.atan2(end[1] - start[1], -(end[2] - start[2])) * 180 / Math.PI + 360) % 360
    expect(fabricAngle).toBeCloseTo(144)
    group.dispose()
  })

  it.each(['transparent', '#FFFFFF', '#152945'])('leaves a real hole in single-value doughnuts over %s', async (fill) => {
    const element = { ...createPresentationChartElement('doughnut'), width: 800, height: 400, title: undefined, showLegend: false,
      categories: ['A', 'B', 'C'], series: [{ name: 'Total', values: [0, 50, 0] }], colors: ['#FF6600', '#00AA88', '#2266EE'], chartAreaFill: fill, plotAreaFill: fill }
    const model = createBlankPresentationDocument('Open ring')
    model.slides[0]!.elements = [element]
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<PresentationSlidePreview slide={model.slides[0]!} selected={false} width={1280} />)
    const path = host.querySelector('path[fill="#00AA88"]')!
    expect(path.getAttribute('fill-rule')).toBe('evenodd')
    expect(path.getAttribute('d')!.match(/M /g)).toHaveLength(2)
    expect(path.getAttribute('d')!.match(/ A /g)).toHaveLength(4)
    expect(host.querySelectorAll('circle')).toHaveLength(0)
    const group = await createPresentationFabricObject(fabric, element, () => undefined)
    if (!(group instanceof fabric.Group)) throw new Error('Missing doughnut group')
    const ring = group.getObjects().find(object => object instanceof fabric.Path)!
    expect(ring.fill).toBe('#00AA88')
    expect(ring.fillRule).toBe('evenodd')
    expect(ring.path.filter(command => command[0] === 'M')).toHaveLength(2)
    expect(group.getObjects().some(object => object instanceof fabric.Circle)).toBe(false)
    group.dispose()
  })

  it('draws no sectors for all-zero or nonpositive data and retains the positive category index', () => {
    expect(getPresentationPieSlices([0, -1, NaN, Infinity])).toEqual([])
    expect(getPresentationPieSlices([0, 0.001, 0])).toEqual([{ index: 1, start: 0, end: 360 }])
    expect(getPresentationPieSlices([0, 2, 0, 3]).map(slice => slice.index)).toEqual([1, 3])
  })

  it.each(['line', 'lineArrow', 'lineDoubleArrow', 'elbowConnector', 'elbowArrow', 'curvedConnector', 'curvedArrow'] as const)('preserves the existing %s path, transform and editability across repeated exports', async (type) => {
    for (const transform of [{ rotation: 0 }, { rotation: 37, flipHorizontal: true }, { rotation: 90, flipVertical: true }]) {
      let model = createBlankPresentationDocument('Connector fidelity')
      const element = { id: 'connector', type, x: 100, y: 150, width: 700, height: 300, fill: 'transparent', borderColor: '#111111', borderWidth: 6, ...transform }
      model.slides[0]!.elements = [element]
      const original = await createPresentationFabricObject(fabric, element, () => undefined)
      if (!(original instanceof fabric.Group)) throw new Error('Missing connector group')
      const originalPath = original.getObjects().find(object => object instanceof fabric.Path)!
      for (let round = 0; round < 2; round++) {
        model = await importPresentationPptx(await createPresentationPptx(model))
        model.slides = [compilePresentationSlideMarkdown(decompilePresentationSlideMarkdown(model.slides[0]!), { document: model }).slide]
        const reopened = model.slides[0]!.elements[0]!
        expect(reopened.type).toBe(type)
        const current = await createPresentationFabricObject(fabric, reopened, () => undefined)
        if (!(current instanceof fabric.Group)) throw new Error('Connector lost editability')
        const currentPath = current.getObjects().find(object => object instanceof fabric.Path)!
        expect(currentPath.path).toEqual(originalPath.path)
        currentPath.calcTransformMatrix().forEach((value, index) => expect(value).toBeCloseTo(originalPath.calcTransformMatrix()[index]!, 2))
        current.dispose()
      }
      original.dispose()
    }
  })

  it('keeps table cells on the authored grid and text centered without rescaling for long labels', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 12 }) }),
    })
    try {
      for (const headerRow of [false, true]) {
        const table = { ...createPresentationTableElement([['Revenue', '100'], ['A long label that wraps into multiple lines', '60']]),
          x: 100, y: 100, width: 800, height: 400, headerRow, headerTextColor: '#111111', textColor: '#222222' }
        const group = await createPresentationFabricObject(fabric, table, () => undefined)
        if (!(group instanceof fabric.Group)) throw new Error('Missing table group')
        expect(group).toMatchObject({ left: 100, top: 100, width: 800, height: 400, scaleX: 1, scaleY: 1 })
        const cells = group.getObjects().filter(object => object instanceof fabric.Rect && object.strokeWidth === 1)
        const texts = group.getObjects().filter(object => object instanceof fabric.Textbox)
        expect(cells).toHaveLength(4)
        expect(texts).toHaveLength(4)
        cells.forEach((cell, index) => {
          const center = cell.getCenterPoint()
          expect(center.x).toBeCloseTo(300 + index % 2 * 400)
          expect(center.y).toBeCloseTo(200 + Math.floor(index / 2) * 200)
          expect(texts[index]!.getCenterPoint().y).toBeCloseTo(center.y)
          expect(texts[index]!.fill).toBe(headerRow && index < 2 ? '#111111' : '#222222')
        })
        group.dispose()
      }
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it.each(['column', 'bar', 'line', 'pie', 'doughnut'] as const)('keeps %s plot coordinates and background fixed in full-size and small chart frames', async (chartType) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 12 }) }),
    })
    try {
      for (const [width, height] of [[800, 400], [8, 8]] as const) {
        const chart = { ...createPresentationChartElement(chartType), x: 100, y: 100, width, height,
          title: 'Long title whose wrapping must not shrink the plot', showLegend: true,
          categories: ['A', 'B', 'C'], series: [{ name: 'Very long series name', values: [50, -30, 20] }], colors: ['#FF0000', '#00AA00', '#0000FF'] }
        const group = await createPresentationFabricObject(fabric, chart, () => undefined)
        if (!(group instanceof fabric.Group)) throw new Error('Missing chart group')
        const sx = width / Math.max(180, width)
        const sy = height / Math.max(120, height)
        expect(group.getScaledWidth()).toBeCloseTo(width)
        expect(group.getScaledHeight()).toBeCloseTo(height)
        const background = group.getObjects().find(object => object.stroke === '#E3E4EA')!
        const center = background.getCenterPoint()
        expect(center.x).toBeCloseTo(100 + width / 2)
        expect(center.y).toBeCloseTo(100 + height / 2)
        const plot = group.getObjects().find(object => object instanceof fabric.Rect && object.fill === 'transparent' && object.stroke === 'transparent')!
        expect(plot.getCenterPoint().x).toBeCloseTo(100 + (chartType === 'bar' ? 100 : 54) * sx + plot.width * sx / 2)
        expect(plot.getCenterPoint().y).toBeCloseTo(100 + 38 * sy + plot.height * sy / 2)
        if (chartType === 'pie' || chartType === 'doughnut') {
          const slices = group.getObjects().filter(object => object instanceof fabric.Path)
          expect(slices).toHaveLength(2)
          for (const slice of slices) {
            const start = slice.path[0] as ['M', number, number]
            const world = fabric.util.transformPoint(new fabric.Point(start[1] - slice.pathOffset.x, start[2] - slice.pathOffset.y), slice.calcTransformMatrix())
            // The authored path coordinate must keep its location inside the plot after grouping.
            expect(world.x).toBeCloseTo(100 + start[1] * sx)
            expect(world.y).toBeCloseTo(100 + start[2] * sy)
          }
        }
        group.dispose()
      }
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it.each([0, 45, 90])('draws straight-line endpoints on the full authored diagonal at %s degrees', async (rotation) => {
    const element = { id: 'native-line', type: 'line' as const, x: 100, y: 100, width: 800, height: 400, rotation,
      fill: 'transparent', borderColor: '#111111', borderWidth: 4 }
    const group = await createPresentationFabricObject(fabric, element, () => undefined)
    if (!(group instanceof fabric.Group)) throw new Error('Missing line group')
    const path = group.getObjects().find(object => object instanceof fabric.Path)!
    const angle = rotation * Math.PI / 180
    const endpoints = [path.path[0], path.path[1]] as ['M' | 'L', number, number][]
    endpoints.forEach(([, x, y], index) => {
      const point = fabric.util.transformPoint(new fabric.Point(x - path.pathOffset.x, y - path.pathOffset.y), path.calcTransformMatrix())
      expect(point.x).toBeCloseTo(100 + index * (800 * Math.cos(angle) - 400 * Math.sin(angle)))
      expect(point.y).toBeCloseTo(100 + index * (800 * Math.sin(angle) + 400 * Math.cos(angle)))
    })
    group.dispose()
  })

  it.each([true, false])('uses authored empty-paragraph font metrics in preview and editable text with wrapping=%s', async (wordWrap) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 12 }) }),
    })
    try {
      const model = createBlankPresentationDocument('Blank paragraphs')
      const element: PresentationTextElement = { id: 'blank', type: 'text', text: '\nBefore\n\n\nAfter\n', x: 0, y: 0, width: 600, height: 600,
        rotation: 0, fontSize: 32, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', wordWrap, lineHeight: 1,
        paragraphs: [{ start: 0, end: 0, style: {}, endStyle: { fontSize: 64 } }, { start: 1, end: 7, style: {} },
          { start: 8, end: 8, style: {}, endStyle: { fontSize: 128 } }, { start: 9, end: 9, style: {}, endStyle: { fontSize: 16 } },
          { start: 10, end: 15, style: {} }, { start: 16, end: 16, style: {}, endStyle: { fontSize: 80 } }],
      }
      model.slides[0]!.elements = [element]
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      mountedRoots.add(root)
      await act(async () => { root.render(<PresentationSlidePreview slide={model.slides[0]!} width={1280} selected={false} />) })
      const emptySpans = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="presentation-text-paragraph"] > span > span')).filter(span => span.textContent === '\u200b')
      expect(emptySpans.map(span => span.style.fontSize)).toEqual(['64px', '128px', '16px', '80px'])
      const object = createPresentationTextFabricObject(fabric, element)
      for (const [line, size] of [[0, 64], [2, 128], [3, 16], [5, 80]] as const) expect(object.getHeightOfLine(line)).toBeCloseTo(size * 1.13)
      expect(object.height).toBeCloseTo((64 + 32 + 128 + 16 + 32 + 80) * 1.13)
      object.dispose()
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it.each(['rect', 'roundRect', 'ellipse'] as const)('centers %s strokes on the authored frame without shifting editor geometry', async (type) => {
    const element = { id: 'stroke', type, x: 100, y: 100, width: 500, height: 400, rotation: 0,
      fill: '#FFE0B0', borderColor: '#000000', borderWidth: 32 }
    const group = await createPresentationFabricObject(fabric, element, () => undefined)
    if (!(group instanceof fabric.Group)) throw new Error('Expected a shape frame')
    expect(group).toMatchObject({ left: 100, top: 100, width: 500, height: 400 })
    expect(group.getObjects()[1]!.getBoundingRect()).toMatchObject({ left: 84, top: 84, width: 532, height: 432 })
    group.dispose()
  })

  it('keeps short fixed baseline advances when a following paragraph needs a negative layout height', async () => {
    const top = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')!
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    const large = (content: HTMLElement | null) => Array.from(content?.children ?? []).some(child => (child as HTMLElement).style.fontSize === '120px')
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() {
      if (!this.querySelector('[data-line-probe]')) return 0
      return large(this) ? 58 : 32
    } })
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() {
      const probe = this.getAttribute('data-line-probe')
      const natural = this.parentElement?.style.getPropertyValue('--ppt-run-line-height') === '1.13'
      if (probe === 'bottom' && natural) return large(this.parentElement) ? 136 : 27
      if (probe === 'bottom') return large(this.parentElement) ? 58 : 32
      if (probe === 'baseline') return large(this.parentElement) ? 58 : 24
      return 0
    } })
    try {
      const model = createBlankPresentationDocument('Short fixed spacing')
      const element: PresentationTextElement = { id: 'fixed', type: 'text', text: 'Small\nLARGE\nSmall', x: 0, y: 0, width: 600, height: 620,
        rotation: 0, fontSize: 24, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', lineSpacing: 32,
        textRuns: [{ start: 6, end: 11, style: { fontSize: 120 } }] }
      model.slides[0]!.elements = [element]
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      mountedRoots.add(root)
      await act(async () => { root.render(<PresentationSlidePreview slide={model.slides[0]!} width={1280} selected={false} />) })
      expect(host.querySelector<HTMLElement>('[data-testid="presentation-text-content"]')!.style.overflow).toBe('visible')
      let cursor = 0
      const baselines = Array.from(host.querySelectorAll<HTMLElement>('[data-testid="presentation-text-paragraph"]')).map(paragraph => {
        const content = paragraph.firstElementChild as HTMLElement
        const before = Number.parseFloat(content.style.marginTop)
        const after = Number.parseFloat(content.style.marginBottom)
        const baseline = cursor + before + (large(content) ? 58 : 24)
        cursor += Math.max(0, content.offsetHeight + before + after) + (Number.parseFloat(paragraph.style.marginBottom) || 0)
        return baseline
      })
      expect(baselines[1]! - baselines[0]!).toBeCloseTo(32)
      expect(baselines[2]! - baselines[1]!).toBeCloseTo(32)
      const normal = { ...model.slides[0]!, elements: [{ ...element, textRuns: undefined }] }
      await act(async () => { root.render(<PresentationSlidePreview slide={normal} width={1280} selected={false} />) })
      for (const paragraph of host.querySelectorAll<HTMLElement>('[data-testid="presentation-text-paragraph"]')) expect(paragraph.style.marginBottom).toBe('0px')
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetTop', top)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
    }
  })

  it.each(['eastAsianVertical', 'stacked'] as const)('renders %s markers and spaces with the same run styles in previews and Fabric', async (textDirection) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 24 }) }),
    })
    try {
      const model = createBlankPresentationDocument('Vertical list')
      const element: PresentationTextElement = { id: 'vertical', type: 'text', text: '背　景\n甲乙', x: 40, y: 40, width: 600, height: 600,
        rotation: 0, fontSize: 40, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', textDirection,
        paragraphs: [{ start: 0, end: 3, style: { listStyle: 'bullet', listBulletChar: '◆', listMarkerFontFamily: 'Georgia' } },
          { start: 4, end: 6, style: { listStyle: 'number', listNumberFormat: 'romanUcPeriod' } }],
        textRuns: [{ start: 2, end: 3, style: { color: '#FF0000', opacity: 0.5 } }] }
      model.slides[0]!.elements = [element]
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      mountedRoots.add(root)
      await act(async () => { root.render(<PresentationSlidePreview slide={model.slides[0]!} width={1280} selected={false} />) })
      const content = host.querySelector('[data-testid="presentation-text-content"]')!
      const spans = Array.from(content.children) as HTMLElement[]
      const group = createPresentationVerticalTextFabricObject(fabric, element)
      const glyphs = group.getObjects().filter((object): object is InstanceType<typeof fabric.Text> => object instanceof fabric.Text)
      expect(content.textContent).toBe('◆ 背　景I. 甲乙')
      expect(glyphs.map(glyph => glyph.text).join('')).toBe(content.textContent)
      expect(spans[0]!.style.fontFamily).toContain('Georgia')
      expect(glyphs[0]!.fontFamily).toContain('Georgia')
      expect(spans[4]!.style.top).toBe('160px')
      expect(glyphs[4]!.top - glyphs[2]!.top).toBe(80)
      expect(renderToStaticMarkup(<PresentationSlidePreview slide={model.slides[0]!} width={1280} selected={false} />)).toContain('color-mix(in srgb, #FF0000 50%, transparent)')
      expect(glyphs[4]!.fill).toBe('rgba(255,0,0,0.5)')
      group.dispose()
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it('uses measured line bounds for fixed spacing even when the first run is much smaller', async () => {
    const top = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop')!
    const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get() {
      return this.querySelector('[data-line-probe]') ? 48 : 0
    } })
    Object.defineProperty(HTMLElement.prototype, 'offsetTop', { configurable: true, get() {
      const probe = this.getAttribute('data-line-probe')
      const natural = this.parentElement?.style.getPropertyValue('--ppt-run-line-height') === '1.13'
      if (probe === 'top') return 0
      if (probe === 'bottom') return natural ? 90.4 : 48
      if (probe === 'baseline') return natural ? 70.33 : 42
      return 0
    } })
    try {
      const model = createBlankPresentationDocument('Fixed spacing')
      model.slides[0]!.elements = [{ id: 'fixed', type: 'text', text: 'Small LARGE', x: 0, y: 0, width: 600, height: 96,
        rotation: 0, fontSize: 24, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', lineSpacing: 48,
        textRuns: [{ start: 6, end: 11, style: { fontSize: 80 } }] }]
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      mountedRoots.add(root)
      await act(async () => { root.render(<PresentationSlidePreview slide={model.slides[0]!} width={1280} selected={false} />) })
      const content = host.querySelector('[data-testid="presentation-text-paragraph"]')!.firstElementChild as HTMLElement
      const baseline = 42 + Number.parseFloat(content.style.marginTop)
      const contentHeight = 48 + Number.parseFloat(content.style.marginTop) + Number.parseFloat(content.style.marginBottom)
      expect(baseline).toBeCloseTo(80 * 1.13 * 0.778)
      expect(contentHeight).toBeCloseTo(80 * 1.13)
      expect(contentHeight).toBeLessThan(96)
      expect(content.style.getPropertyValue('--ppt-run-line-height')).toBe('0')
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetTop', top)
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', height)
    }
  })

  it('paints run alpha separately from the canvas object opacity', () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 12 }) }),
    })
    try {
      const object = createPresentationTextFabricObject(fabric, {
        id: 'alpha', type: 'text', text: 'Hidden Visible', x: 0, y: 0, width: 600, height: 100, rotation: 0,
        fontSize: 40, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', opacity: 0.5,
        textRuns: [{ start: 0, end: 7, style: { opacity: 0 } }],
      })
      expect(object.opacity).toBe(0.5)
      expect(new fabric.Color(object.styles[0]![0]!.fill as string).getAlpha()).toBe(0)
      expect(new fabric.Color(object.styles[0]![7]!.fill as string).getAlpha()).toBe(1)
      object.dispose()
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it.each([1.08, 2.5, 4])('keeps single-line preview and canvas content inside a short frame at %s line height', async (lineHeight) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 12 }) }),
    })
    try {
      const model = createBlankPresentationDocument('Line height')
      const element = { id: 'line-height', type: 'text' as const, text: 'Heading', x: 40, y: 40, width: 600, height: 64,
        rotation: 0, fontSize: 40, fontFamily: 'Arial', fontWeight: 400 as const, color: '#111111', align: 'left' as const,
        lineHeight, wordWrap: true }
      model.slides[0]!.elements = [element]
      const host = document.createElement('div')
      document.body.append(host)
      const root = createRoot(host)
      mountedRoots.add(root)
      await act(async () => { root.render(<PresentationSlidePreview slide={model.slides[0]!} width={1280} selected={false} />) })
      const paragraph = host.querySelector<HTMLElement>('[data-testid="presentation-text-paragraph"]')!
      const content = paragraph.firstElementChild as HTMLElement
      const text = Array.from(content.children).find(node => node.textContent === 'Heading') as HTMLElement
      const previewHeight = Number(content.style.getPropertyValue('--ppt-run-line-height')) * Number.parseFloat(text.style.fontSize)
        + Number.parseFloat(content.style.marginTop) + Number.parseFloat(content.style.marginBottom)
      const object = createPresentationTextFabricObject(fabric, element)
      expect(previewHeight).toBeCloseTo(object.height)
      expect(previewHeight).toBeLessThan(element.height)
      const baseline: number[] = []
      object._renderChar = (...args) => { baseline.push(args[6] + object.height / 2) }
      object._renderTextCommon({ save() {}, restore() {}, direction: 'ltr' } as CanvasRenderingContext2D, 'fillText')
      expect(baseline[0]).toBeGreaterThan(element.fontSize / 2)
      expect(baseline[0]).toBeLessThan(element.height)
      object.dispose()
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it('shares proportional leading across differently sized wrapped lines while retaining the natural first line', () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 12 }) }),
    })
    try {
      const object = createPresentationTextFabricObject(fabric, {
        id: 'mixed', type: 'text', text: 'Large\nSmall', x: 0, y: 0, width: 600, height: 300, rotation: 0,
        fontSize: 60, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', lineHeight: 2.5,
        textRuns: [{ start: 6, end: 11, style: { fontSize: 40 } }], paragraphs: [{ start: 0, end: 11, style: {} }],
      })
      const baseline = new Map<number, number>()
      object._renderChar = (...args) => { baseline.set(args[2], args[6] + object.height / 2) }
      object._renderTextCommon({ save() {}, restore() {}, direction: 'ltr' } as CanvasRenderingContext2D, 'fillText')
      expect(baseline.get(0)).toBeCloseTo(60 * 1.13 * 0.778)
      const sharedLeading = (60 + 40) * 1.13 * (2.5 - 1) / 2
      expect(baseline.get(1)! - baseline.get(0)!).toBeCloseTo(60 * 1.13 * 0.222 + sharedLeading + 40 * 1.13 * 0.778)
      object.dispose()
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it.each([true, false])('lays out paragraph-specific alignment and baseline spacing with wrapping=%s', (wordWrap) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 12 }) }),
    })
    try {
      const object = createPresentationTextFabricObject(fabric, {
        id: 'paragraphs', type: 'text', text: 'First\nSecond\nThird', x: 40, y: 40, width: 600, height: 400,
        rotation: 0, fontSize: 24, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', wordWrap,
        paragraphs: [{ start: 0, end: 5, style: { align: 'left', lineSpacing: 32, spaceAfter: 8 } },
          { start: 6, end: 18, style: { align: 'right', lineSpacing: 64, spaceBefore: 4 } }],
      })
      const locations = new Map<number, { x: number; y: number }>()
      object._renderChar = (...args) => { locations.set(args[2], { x: args[5], y: args[6] }) }
      object._renderTextCommon({ save() {}, restore() {}, direction: 'ltr' } as CanvasRenderingContext2D, 'fillText')
      expect(locations.size).toBe(3)
      expect(locations.get(1)!.y - locations.get(0)!.y).toBeCloseTo(44)
      expect(locations.get(2)!.y - locations.get(1)!.y).toBeCloseTo(64)
      expect(object.width).toBe(600)
      expect(object._getLineLeftOffset(0)).toBe(0)
      expect(object._getLineLeftOffset(1)).toBeCloseTo(600 - object.getLineWidth(1))
      expect(object._getLineLeftOffset(2)).toBeCloseTo(600 - object.getLineWidth(2))
      object.dispose()
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it('renders fixed baseline spacing across lines with different font sizes', () => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 12 }) }),
    })
    try {
      const object = createPresentationTextFabricObject(fabric, {
        id: 'fixed-spacing', type: 'text', text: 'Large\nSmall\nLarger', x: 40, y: 40, width: 600, height: 400,
        rotation: 0, fontSize: 40, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', lineSpacing: 100,
        textRuns: [{ start: 6, end: 11, style: { fontSize: 20 } }, { start: 12, end: 18, style: { fontSize: 60 } }],
      })
      const baselines = new Map<number, number>()
      object._renderChar = (...args) => { baselines.set(args[2], args[6]) }
      object._renderTextCommon({ save() {}, restore() {}, direction: 'ltr' } as CanvasRenderingContext2D, 'fillText')
      expect(baselines.size).toBe(3)
      expect(baselines.get(1)! - baselines.get(0)!).toBeCloseTo(100)
      expect(baselines.get(2)! - baselines.get(1)!).toBeCloseTo(100)
      object.dispose()
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it.each(['horizontal', 'vertical', 'vertical270'] as const)('persists side-handle resizing for %s text without scaling its font', (textDirection) => {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, 'getContext')!
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 12 }) }),
    })
    try {
      const element = { id: 'resized', type: 'text' as const, text: 'Resize this text', x: 80, y: 60, width: 200, height: 240,
        rotation: 30, textDirection, flipHorizontal: true, fontSize: 24, fontFamily: 'Arial', fontWeight: 400 as const,
        color: '#111111', align: 'left' as const, verticalAlign: 'middle' as const, wordWrap: true,
        textInsets: { left: 8, right: 12, top: 10, bottom: 14 }, lineSpacing: 48,
      }
      const object = createPresentationTextFabricObject(fabric, element)
      object.set('width', object.width + 100)
      expect(object.scaleX).toBe(1)
      const patch = getPresentationTextFabricFramePatch(object, element)!
      expect(patch.width).toBe(textDirection === 'horizontal' ? 300 : 200)
      expect(patch.height).toBe(textDirection === 'horizontal' ? 240 : 340)
      expect(patch.fontSize).toBeUndefined()
      const rebuilt = createPresentationTextFabricObject(fabric, { ...element, ...patch })
      expect(rebuilt.width).toBeCloseTo(object.width)
      expect(rebuilt.left).toBeCloseTo(object.left)
      expect(rebuilt.top).toBeCloseTo(object.top)
      expect(rebuilt.getHeightOfLine(0)).toBe(48)
      object.dispose(); rebuilt.dispose()
    } finally { Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', descriptor) }
  })

  it('keeps inline styles on grapheme boundaries and applies rotated text frames in Fabric', () => {
    const getContext = HTMLCanvasElement.prototype.getContext
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({ font: '', textBaseline: 'alphabetic', measureText: (value: string) => ({ width: value.length * 24 }) }),
    })
    try {
      const element = {
        id: 'styled-text', type: 'text' as const, x: 80, y: 100, width: 200, height: 400, rotation: 30,
        fontSize: 24, fontFamily: 'Aptos', fontWeight: 400 as const, color: '#111111', align: 'center' as const,
        verticalAlign: 'middle' as const, textDirection: 'vertical270' as const, wordWrap: true,
        flipHorizontal: true, text: 'A😀B\n2中文', textInsets: { left: 8, right: 12, top: 10, bottom: 14 },
        textRuns: [
          { start: 1, end: 3, style: { fontSize: 40, fontWeight: 700 as const, color: '#0088CC' } },
          { start: 5, end: 6, style: { fontSize: 20, baseline: 'superscript' as const } },
        ],
      }
      const object = createPresentationTextFabricObject(fabric, element)
      expect(object.angle).toBe(120)
      expect(object.flipX).toBe(true)
      expect(object.width).toBe(376)
      expect(object.styles[0]![1]).toMatchObject({ fontSize: 40, fontWeight: 700, fill: '#0088CC' })
      expect(object.styles[0]![2]).toMatchObject({ fontSize: 24, fontWeight: 400 })
      expect(object.styles[1]![0]).toMatchObject({ fontSize: 12, deltaY: -7 })
      expect(Number.isFinite(object.left)).toBe(true)
      expect(Number.isFinite(object.top)).toBe(true)
      const originalFrame = getPresentationTextFabricFramePatch(object, element)!
      expect(originalFrame.x).toBeCloseTo(element.x)
      expect(originalFrame.y).toBeCloseTo(element.y)
      expect(originalFrame.rotation).toBe(30)
      object.set({ left: object.left + 15, top: object.top - 9 })
      expect(getPresentationTextFabricFramePatch(object, element)!.x).toBeCloseTo(95)
      expect(getPresentationTextFabricFramePatch(object, element)!.y).toBeCloseTo(91)
      object.set({ scaleX: 2, scaleY: 3 })
      expect(getPresentationTextFabricFramePatch(object, element)).toMatchObject({
        width: 600, height: 800, fontSize: 72,
        textInsets: { left: 24, right: 36, top: 20, bottom: 28 },
      })
      object.dispose()
      const tracked = createPresentationTextFabricObject(fabric, {
        ...element, text: 'AB', wordWrap: false, characterSpacing: 200,
        textRuns: [{ start: 1, end: 2, style: { fontSize: 12, characterSpacing: -100 } }],
      })
      const untracked = createPresentationTextFabricObject(fabric, {
        ...element, text: 'AB', wordWrap: false, characterSpacing: 0,
        textRuns: [{ start: 1, end: 2, style: { fontSize: 12, characterSpacing: 0 } }],
      })
      expect(tracked.getLineWidth(0) - untracked.getLineWidth(0)).toBeCloseTo(3.6)
      tracked.dispose()
      untracked.dispose()
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', { configurable: true, value: getContext })
    }
  })

  it('keeps a thin preset path centered in its authored frame after rotation', async () => {
    const object = await createPresentationFabricObject(fabric, {
      id: 'thin-line', type: 'line', x: 120, y: 70, width: 300, height: 1, rotation: 90,
      fill: 'transparent', borderColor: '#000000', borderWidth: 1,
    }, () => undefined)
    expect(object).toBeInstanceOf(fabric.Group)
    const group = object as InstanceType<typeof fabric.Group>
    const path = group.getObjects()[1]!
    expect(group).toMatchObject({ width: 300, height: 1, angle: 90, left: 120, top: 70 })
    expect(path.getCenterPoint().x).toBeCloseTo(119.5)
    expect(path.getCenterPoint().y).toBeCloseTo(220)
    group.dispose()
  })

  it('keeps media Fabric groups and their background children aligned to model geometry', () => {
    const getContext = HTMLCanvasElement.prototype.getContext
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({
        font: '',
        textBaseline: 'alphabetic',
        measureText: (value: string) => ({ width: value.length * 9 }),
      }),
    })
    const audio = {
      ...createPresentationMediaElement('audio', fileSource('audio/mpeg', 'a-very-long-unbroken-audio-file-name-that-used-to-expand-the-selection-frame.mp3')),
      x: 35,
      y: 48,
    }
    const video = {
      ...createPresentationMediaElement('video', fileSource('video/mp4', 'a-very-long-unbroken-video-file-name-that-used-to-expand-the-selection-frame.mp4')),
      x: 80,
      y: 96,
    }
    const tinyAudio = { ...audio, id: 'tiny-audio', x: 11, y: 13, width: 8, height: 8 }
    const tinyVideo = { ...video, id: 'tiny-video', x: 17, y: 19, width: 8, height: 8 }
    try {
      for (const element of [audio, video, tinyAudio, tinyVideo]) {
        const object = createPresentationMediaFabricObject(fabric, element)
        const background = (object as InstanceType<typeof fabric.Group>).getObjects()[0]!
        expect(object.left).toBe(element.x)
        expect(object.top).toBe(element.y)
        expect(object.width).toBe(element.width)
        expect(object.height).toBe(element.height)
        expect(object.scaleX).toBe(1)
        expect(object.scaleY).toBe(1)
        expect(object.lockSkewingX).toBe(true)
        expect(object.lockSkewingY).toBe(true)
        expect(object.getBoundingRect()).toMatchObject({
          left: element.x,
          top: element.y,
          width: element.width,
          height: element.height,
        })
        expect(background.getBoundingRect()).toMatchObject({
          left: element.x,
          top: element.y,
          width: element.width,
          height: element.height,
        })
        if (element.type === 'audio') {
          expect((object as InstanceType<typeof fabric.Group>).getObjects().some((child) => (
            child instanceof fabric.Text
          ))).toBe(false)
        }
      }
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: getContext,
      })
    }
  })

  it('keeps a live Fabric video frame inside the media element bounds', () => {
    const element = {
      ...createPresentationMediaElement('video', fileSource('video/mp4', 'frame.mp4')),
      x: 80,
      y: 96,
    }
    const object = createPresentationMediaFabricObject(fabric, element)
    const canvas = {
      renderAll: () => undefined,
      requestRenderAll: () => undefined,
    } as unknown as InstanceType<typeof fabric.Canvas>
    const runtime = createPresentationMediaRuntime(fabric, canvas)
    const originalCreateElement = document.createElement
    const videos: HTMLVideoElement[] = []
    Object.defineProperty(document, 'createElement', {
      configurable: true,
      value(tagName: string) {
        const created = Reflect.apply(originalCreateElement, document, [tagName]) as HTMLElement
        if (tagName.toLowerCase() === 'video') videos.push(created as HTMLVideoElement)
        return created
      },
    })

    try {
      runtime.register(element, object)
      expect(videos).toHaveLength(0)
      runtime.prepare(element.id)
      const video = videos[0]
      if (!video) throw new Error('Expected the runtime to create a video element')
      Object.defineProperties(video, {
        videoHeight: { configurable: true, value: 720 },
        videoWidth: { configurable: true, value: 1280 },
      })
      video.dispatchEvent(new Event('loadeddata'))
      const group = object as InstanceType<typeof fabric.Group>
      const frame = group.getObjects().find((child) => child instanceof fabric.FabricImage)

      expect(frame).toBeInstanceOf(fabric.FabricImage)
      expect(frame?.getElement()).toBe(video)
      expect(video.width).toBe(1280)
      expect(video.height).toBe(720)
      expect(frame?.getBoundingRect()).toMatchObject({
        left: element.x,
        top: element.y,
        width: element.width,
        height: element.height,
      })
      runtime.pauseAll()
      expect(group.getObjects().some((child) => child instanceof fabric.FabricImage)).toBe(true)
      expect(video.getAttribute('src')).toBe(element.source.dataUrl)

      runtime.releaseAll()
      expect(group.getObjects().some((child) => child instanceof fabric.FabricImage)).toBe(false)
      expect(video.getAttribute('src')).toBeNull()
    } finally {
      runtime.dispose()
      Object.defineProperty(document, 'createElement', {
        configurable: true,
        value: originalCreateElement,
      })
    }
  })

  it('does not restart audio when a pending play resolves after the runtime pauses it', async () => {
    const element = createPresentationMediaElement('audio', fileSource('audio/mpeg', 'pending.mp3'))
    const object = createPresentationMediaFabricObject(fabric, element)
    const canvas = {
      renderAll: () => undefined,
      requestRenderAll: () => undefined,
    } as unknown as InstanceType<typeof fabric.Canvas>
    const runtime = createPresentationMediaRuntime(fabric, canvas)
    const originalCreateElement = document.createElement
    const audios: HTMLAudioElement[] = []
    let paused = true
    let pauseCalls = 0
    let resolvePlay: () => void = () => undefined
    const playResult = new Promise<void>((resolve) => {
      resolvePlay = resolve
    })
    Object.defineProperty(document, 'createElement', {
      configurable: true,
      value(tagName: string) {
        const created = Reflect.apply(originalCreateElement, document, [tagName]) as HTMLElement
        if (tagName.toLowerCase() === 'audio') {
          const audio = created as HTMLAudioElement
          audios.push(audio)
          Object.defineProperties(audio, {
            pause: {
              configurable: true,
              value: () => {
                paused = true
                pauseCalls += 1
              },
            },
            paused: { configurable: true, get: () => paused },
            play: {
              configurable: true,
              value: () => {
                paused = false
                return playResult
              },
            },
          })
        }
        return created
      },
    })

    try {
      runtime.register(element, object)
      const pending = runtime.toggle(element.id)
      const audio = audios[0]
      if (!audio) throw new Error('Expected the runtime to create an audio element')
      expect((object as InstanceType<typeof fabric.Group>).getObjects().find((child) => child instanceof fabric.Triangle)?.visible).toBe(false)

      runtime.pauseAll()
      expect(pauseCalls).toBe(1)
      expect((object as InstanceType<typeof fabric.Group>).getObjects().find((child) => child instanceof fabric.Triangle)?.visible).toBe(true)
      resolvePlay()
      await pending

      expect(paused).toBe(true)
      expect((object as InstanceType<typeof fabric.Group>).getObjects().find((child) => child instanceof fabric.Triangle)?.visible).toBe(true)
    } finally {
      runtime.dispose()
      Object.defineProperty(document, 'createElement', {
        configurable: true,
        value: originalCreateElement,
      })
    }
  })

  it('ignores an obsolete play result after playback is restarted', async () => {
    const element = createPresentationMediaElement('audio', fileSource('audio/mpeg', 'restart.mp3'))
    const object = createPresentationMediaFabricObject(fabric, element)
    const canvas = {
      renderAll: () => undefined,
      requestRenderAll: () => undefined,
    } as unknown as InstanceType<typeof fabric.Canvas>
    const runtime = createPresentationMediaRuntime(fabric, canvas)
    const createElement = document.createElement.bind(document)
    const resolvePlay: Array<() => void> = []
    let paused = true
    Object.defineProperty(document, 'createElement', {
      configurable: true,
      value(tagName: string) {
        const created = createElement(tagName)
        if (tagName.toLowerCase() === 'audio') {
          Object.defineProperties(created, {
            load: { configurable: true, value: () => undefined },
            pause: { configurable: true, value: () => { paused = true } },
            paused: { configurable: true, get: () => paused },
            play: {
              configurable: true,
              value: () => {
                paused = false
                return new Promise<void>((resolve) => resolvePlay.push(resolve))
              },
            },
          })
        }
        return created
      },
    })
    const playGlyph = () => (
      object as InstanceType<typeof fabric.Group>
    ).getObjects().find((child) => child instanceof fabric.Triangle)

    try {
      runtime.register(element, object)
      const obsolete = runtime.toggle(element.id)
      await runtime.toggle(element.id)
      const current = runtime.toggle(element.id)
      expect(resolvePlay).toHaveLength(2)
      expect(playGlyph()?.visible).toBe(false)

      resolvePlay[0]!()
      await obsolete
      expect(playGlyph()?.visible).toBe(false)

      resolvePlay[1]!()
      await current
      expect(paused).toBe(false)
      expect(playGlyph()?.visible).toBe(false)
    } finally {
      runtime.dispose()
      Object.defineProperty(document, 'createElement', {
        configurable: true,
        value: createElement,
      })
    }
  })

  it('toggles media only from its canvas play target and pauses the previous session', async () => {
    const first = createPresentationMediaElement('audio', fileSource('audio/mpeg', 'first.mp3'))
    const second = {
      ...createPresentationMediaElement('audio', fileSource('audio/mpeg', 'second.mp3')),
      x: first.x + 40,
      y: first.y + 100,
    }
    const firstObject = createPresentationMediaFabricObject(fabric, first)
    const secondObject = createPresentationMediaFabricObject(fabric, second)
    const canvas = {
      renderAll: () => undefined,
      requestRenderAll: () => undefined,
    } as unknown as InstanceType<typeof fabric.Canvas>
    const runtime = createPresentationMediaRuntime(fabric, canvas)
    const createElement = document.createElement.bind(document)
    const mediaStates: Array<{ pauseCalls: number; paused: boolean; playCalls: number }> = []
    Object.defineProperty(document, 'createElement', {
      configurable: true,
      value(tagName: string) {
        const created = createElement(tagName)
        if (tagName.toLowerCase() === 'audio') {
          const state = { pauseCalls: 0, paused: true, playCalls: 0 }
          mediaStates.push(state)
          Object.defineProperties(created, {
            load: { configurable: true, value: () => undefined },
            pause: {
              configurable: true,
              value: () => {
                state.pauseCalls += 1
                state.paused = true
              },
            },
            paused: { configurable: true, get: () => state.paused },
            play: {
              configurable: true,
              value: () => {
                state.playCalls += 1
                state.paused = false
                return Promise.resolve()
              },
            },
          })
        }
        return created
      },
    })
    const playPoint = (element: typeof first) => new fabric.Point(
      element.x + (element.width / 2),
      element.y + (element.height / 2),
    )

    try {
      runtime.register(first, firstObject)
      runtime.register(second, secondObject)
      expect(runtime.cursorFromCanvas(
        firstObject,
        new fabric.Point(first.x + 4, first.y + 4),
      )).toBeNull()
      expect(runtime.cursorFromCanvas(firstObject, playPoint(first))).toBe('pointer')
      expect(runtime.cursorFromCanvas(
        new fabric.Rect({ width: 20, height: 20 }),
        new fabric.Point(10, 10),
      )).toBeNull()
      expect(runtime.toggleFromCanvas(
        firstObject,
        new fabric.Point(first.x + 4, first.y + 4),
      )).toBe(false)
      expect(mediaStates).toHaveLength(0)

      expect(runtime.toggleFromCanvas(firstObject, playPoint(first))).toBe(true)
      await Promise.resolve()
      expect(mediaStates[0]).toMatchObject({ pauseCalls: 0, paused: false, playCalls: 1 })

      expect(runtime.toggleFromCanvas(secondObject, playPoint(second))).toBe(true)
      await Promise.resolve()
      expect(mediaStates[0]).toMatchObject({ pauseCalls: 1, paused: true, playCalls: 1 })
      expect(mediaStates[1]).toMatchObject({ pauseCalls: 0, paused: false, playCalls: 1 })

      expect(runtime.toggleFromCanvas(secondObject, playPoint(second))).toBe(true)
      await Promise.resolve()
      expect(mediaStates[1]).toMatchObject({ pauseCalls: 1, paused: true, playCalls: 1 })
    } finally {
      runtime.dispose()
      Object.defineProperty(document, 'createElement', {
        configurable: true,
        value: createElement,
      })
    }
  })

  it('keeps ordinary history at 50 entries and trims embedded payloads by byte budget', () => {
    const documentModel = createBlankPresentationDocument('History')
    const plainBytes = estimatePresentationDocumentBytes(documentModel)
    documentModel.slides[0]!.elements.push(createPresentationMediaElement('video', fileSource('video/mp4', 'large.mp4', 'A'.repeat(2_000))))
    const mediaBytes = estimatePresentationDocumentBytes(documentModel)
    expect(mediaBytes).toBeGreaterThan(plainBytes + 3_900)

    const entry = createPresentationHistoryEntry(documentModel, mediaBytes)
    expect(entry).not.toBeNull()
    expect(entry!.document).not.toBe(documentModel)
    const clonedMedia = entry!.document.slides[0]!.elements[0]
    const originalMedia = documentModel.slides[0]!.elements[0]
    expect(clonedMedia?.type).toBe('video')
    if (clonedMedia?.type === 'video' && originalMedia?.type === 'video') {
      expect(clonedMedia.source.dataUrl).toBe(originalMedia.source.dataUrl)
    }
    expect(createPresentationHistoryEntry(documentModel, mediaBytes - 1)).toBeNull()

    const ordinaryEntries = Array.from({ length: 60 }, (_, index) => ({
      document: { ...documentModel, id: `document-${index}` },
      estimatedBytes: 1,
    }))
    const entryLimited = trimPresentationHistoryEntries(ordinaryEntries, 50, 1_000)
    expect(entryLimited).toHaveLength(50)
    expect(entryLimited[0]?.document.id).toBe('document-10')
    expect(entryLimited.at(-1)?.document.id).toBe('document-59')

    const byteLimited = trimPresentationHistoryEntries(
      ordinaryEntries.slice(0, 4).map((item) => ({ ...item, estimatedBytes: 40 })),
      50,
      100,
    )
    expect(byteLimited.map((item) => item.document.id)).toEqual(['document-2', 'document-3'])
  })

  it('preserves shared media sources across history clones', () => {
    const document = createBlankPresentationDocument('Shared media')
    const source = fileSource('video/mp4', 'large.mp4', 'A'.repeat(10_000))
    const media = createPresentationMediaElement('video', source)
    document.slides[0]!.elements = [media, { ...media, id: 'duplicated-media' }]
    const estimatedBefore = estimatePresentationDocumentBytes(document)
    const entry = createPresentationHistoryEntry(document)
    expect(entry).not.toBeNull()
    const [first, second] = entry!.document.slides[0]!.elements
    expect(first?.type).toBe('video')
    expect(second?.type).toBe('video')
    if (first?.type === 'video' && second?.type === 'video') expect(first.source).toBe(second.source)
    expect(estimatePresentationDocumentBytes(entry!.document)).toBe(estimatedBefore)
  })

  it('leaves media navigation keys to native controls while preserving slideshow shortcuts', () => {
    const audio = document.createElement('audio')
    const video = document.createElement('video')
    const button = document.createElement('button')
    const canvas = document.createElement('div')

    for (const media of [audio, video]) {
      expect(resolvePresentationSlideshowKeyAction(media, ' ')).toBeNull()
      expect(resolvePresentationSlideshowKeyAction(media, 'ArrowLeft')).toBeNull()
      expect(resolvePresentationSlideshowKeyAction(media, 'ArrowRight')).toBeNull()
      expect(resolvePresentationSlideshowKeyAction(media, 'Escape')).toBe('close')
    }
    expect(resolvePresentationSlideshowKeyAction(button, ' ')).toBeNull()
    expect(resolvePresentationSlideshowKeyAction(canvas, ' ')).toBe('next')
    expect(resolvePresentationSlideshowKeyAction(canvas, 'ArrowRight')).toBe('next')
    expect(resolvePresentationSlideshowKeyAction(canvas, 'ArrowLeft')).toBe('previous')
  })

  it('uses inert media cards during transitions, then restores stable playback controls', async () => {
    const audio = { ...createPresentationMediaElement('audio', fileSource('audio/mpeg', 'sound.mp3')), autoplay: true, muted: false }
    const video = { ...createPresentationMediaElement('video', fileSource('video/mp4', 'clip.mp4')), autoplay: true, muted: false }
    const slide = { ...createBlankPresentationDocument('Media').slides[0]!, elements: [audio, video] }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    const pauseDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause')
    let pauseCalls = 0
    Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
      configurable: true,
      value: () => {
        pauseCalls += 1
      },
    })

    const render = async (suppressMediaPlayback: boolean) => {
      await act(async () => {
        root.render(
          <PresentationSlidePreview
            slide={slide}
            width={960}
            selected={false}
            presentation
            suppressMediaPlayback={suppressMediaPlayback}
            onActivateHyperlink={() => undefined}
          />,
        )
      })
    }

    try {
      await render(false)
      for (const media of host.querySelectorAll<HTMLMediaElement>('audio, video')) {
        expect(media.autoplay).toBe(true)
        expect(media.muted).toBe(false)
      }

      await render(true)
      expect(host.querySelectorAll('audio, video')).toHaveLength(0)
      expect(host.querySelector('[data-testid="presentation-audio-placeholder"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="presentation-video-placeholder"]')).not.toBeNull()
      expect(pauseCalls).toBe(2)

      await render(false)
      await act(async () => root.unmount())
      mountedRoots.delete(root)
      expect(pauseCalls).toBe(4)
    } finally {
      if (pauseDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'pause', pauseDescriptor)
      else Reflect.deleteProperty(HTMLMediaElement.prototype, 'pause')
    }
  })

  it('ignores an obsolete slide-show audio play failure after playback restarts', async () => {
    const audio = createPresentationMediaElement('audio', fileSource('audio/mpeg', 'restart-slideshow.mp3'))
    const slide = { ...createBlankPresentationDocument('Audio controls').slides[0]!, elements: [audio] }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    await act(async () => {
      root.render(
        <PresentationSlidePreview
          slide={slide}
          width={960}
          selected={false}
          presentation
          onActivateHyperlink={() => undefined}
        />,
      )
    })
    const media = host.querySelector<HTMLAudioElement>('audio')!
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="restart-slideshow.mp3"]')!
    const playResults: Array<{ reject: () => void; resolve: () => void }> = []
    let paused = true
    Object.defineProperties(media, {
      pause: {
        configurable: true,
        value: () => {
          paused = true
          media.dispatchEvent(new Event('pause'))
        },
      },
      paused: { configurable: true, get: () => paused },
      play: {
        configurable: true,
        value: () => {
          paused = false
          return new Promise<void>((resolve, reject) => {
            playResults.push({ reject: () => reject(new Error('obsolete')), resolve })
          })
        },
      },
    })

    await act(async () => button.click())
    await act(async () => button.click())
    await act(async () => button.click())
    expect(playResults).toHaveLength(2)
    expect(button.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      playResults[0]!.reject()
      await Promise.resolve()
    })
    expect(button.getAttribute('aria-pressed')).toBe('true')

    await act(async () => {
      playResults[1]!.resolve()
      await Promise.resolve()
    })
    expect(button.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps stable slideshow media sources during StrictMode effect replay', async () => {
    const audio = { ...createPresentationMediaElement('audio', fileSource('audio/mpeg', 'strict.mp3', 'AAAA')), autoplay: true }
    const video = { ...createPresentationMediaElement('video', fileSource('video/mp4', 'strict.mp4', 'BBBB')), autoplay: true }
    const slide = { ...createBlankPresentationDocument('Strict media').slides[0]!, elements: [audio, video] }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    const playDescriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play')
    let playCalls = 0
    Object.defineProperty(HTMLMediaElement.prototype, 'play', {
      configurable: true,
      value: () => {
        playCalls += 1
        return Promise.resolve()
      },
    })

    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <PresentationSlidePreview
              slide={slide}
              width={960}
              selected={false}
              presentation
              onActivateHyperlink={() => undefined}
            />
          </StrictMode>,
        )
      })

      expect(host.querySelector('audio')?.getAttribute('src')).toBe(audio.source.dataUrl)
      expect(host.querySelector('video')?.getAttribute('src')).toBe(video.source.dataUrl)
      expect(playCalls).toBe(4)
    } finally {
      if (playDescriptor) Object.defineProperty(HTMLMediaElement.prototype, 'play', playDescriptor)
      else Reflect.deleteProperty(HTMLMediaElement.prototype, 'play')
    }
  })

  it('keeps replacement audio and video sources when stable playback nodes update in place', async () => {
    const initialAudio = createPresentationMediaElement('audio', fileSource('audio/mpeg', 'first.mp3', 'AAAA'))
    const initialVideo = createPresentationMediaElement('video', fileSource('video/mp4', 'first.mp4', 'BBBB'))
    const baseSlide = createBlankPresentationDocument('Media source replacement').slides[0]!
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)

    const render = async (audioSource: typeof initialAudio.source, videoSource: typeof initialVideo.source) => {
      await act(async () => {
        root.render(
          <PresentationSlidePreview
            slide={{
              ...baseSlide,
              elements: [
                { ...initialAudio, source: audioSource },
                { ...initialVideo, source: videoSource },
              ],
            }}
            width={960}
            selected={false}
            presentation
            onActivateHyperlink={() => undefined}
          />,
        )
      })
    }

    await render(initialAudio.source, initialVideo.source)
    const originalAudioNode = host.querySelector('audio')!
    const originalVideoNode = host.querySelector('video')!
    const replacementAudio = fileSource('audio/mpeg', 'second.mp3', 'CCCC')
    const replacementVideo = fileSource('video/mp4', 'second.mp4', 'DDDD')

    await render(replacementAudio, replacementVideo)

    expect(host.querySelector('audio')).toBe(originalAudioNode)
    expect(host.querySelector('video')).toBe(originalVideoNode)
    expect(originalAudioNode.getAttribute('src')).toBe(replacementAudio.dataUrl)
    expect(originalVideoNode.getAttribute('src')).toBe(replacementVideo.dataUrl)
  })

  it('keeps a linked background overlay below later media controls', async () => {
    const linkedImage = {
      ...createPresentationImageElement(fileSource('image/png', 'background.png')),
      hyperlink: { type: 'url' as const, url: 'https://example.com' },
    }
    const audio = {
      ...createPresentationMediaElement('audio', fileSource('audio/mpeg', 'sound.mp3')),
      hyperlink: { type: 'url' as const, url: 'https://example.com/unsupported-media-link' },
    }
    const slide = { ...createBlankPresentationDocument('Links').slides[0]!, elements: [linkedImage, audio] }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    await act(async () => {
      root.render(
        <PresentationSlidePreview
          slide={slide}
          width={960}
          selected={false}
          presentation
          onActivateHyperlink={() => undefined}
        />,
      )
    })

    const content = host.querySelector<HTMLElement>('[data-testid="presentation-slide-preview"] > span')!
    const image = content.querySelector('img')!
    const overlay = content.querySelector<HTMLButtonElement>('button[aria-label="https://example.com"]')!
    const media = content.querySelector('audio')!
    const mediaContainer = media.parentElement!
    const children = [...content.children]
    expect(content.querySelectorAll('button')).toHaveLength(2)
    expect(children.indexOf(image)).toBeLessThan(children.indexOf(overlay))
    expect(children.indexOf(overlay)).toBeLessThan(children.indexOf(mediaContainer))
  })

  it('keeps an empty number-field draft while focused and clamps only when committed', () => {
    expect(resolvePresentationNumberFieldValue('', 8, 320)).toBe(320)
    expect(resolvePresentationNumberFieldValue('0', 8, 320)).toBe(8)
    expect(resolvePresentationNumberFieldValue('-20', 8, 320)).toBe(8)
    expect(resolvePresentationNumberFieldValue('42.6', 8, 320)).toBe(43)
    expect(resolvePresentationNumberFieldValue('not-a-number', undefined, 15)).toBe(15)
  })

  it('does not replace an empty focused number field until blur', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    const changes: number[] = []
    await act(async () => {
      root.render(<PresentationNumberField label="Width" min={8} value={320} onChange={(value) => changes.push(value)} />)
    })
    const input = host.querySelector<HTMLInputElement>('input')!
    const setNativeValue = (value: string) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    }

    await act(async () => {
      Simulate.focus(input)
      setNativeValue('')
      Simulate.change(input)
    })
    expect(input.value).toBe('')
    expect(changes).toEqual([])

    await act(async () => Simulate.blur(input))
    expect(input.value).toBe('320')
    expect(changes).toEqual([])

    await act(async () => {
      Simulate.focus(input)
      setNativeValue('0')
      Simulate.change(input)
    })
    expect(input.value).toBe('0')
    expect(changes).toEqual([])

    await act(async () => Simulate.blur(input))
    expect(input.value).toBe('8')
    expect(changes).toEqual([8])
  })

  it('locks unsupported element rotation in both runtime policy and static previews', async () => {
    const media = { ...createPresentationMediaElement('audio', fileSource('audio/mpeg', 'sound.mp3')), rotation: 45 }
    const table = { ...createPresentationTableElement([['A']]), rotation: 45 }
    const chart = { ...createPresentationChartElement('column'), rotation: 45 }
    const image = { ...createPresentationImageElement(fileSource('image/png', 'image.png')), rotation: 45 }
    expect(isPresentationRotationLocked(media)).toBe(true)
    expect(isPresentationRotationLocked(table)).toBe(true)
    expect(isPresentationRotationLocked(chart)).toBe(true)
    expect(isPresentationRotationLocked(image)).toBe(false)

    const slide = { ...createBlankPresentationDocument('Rotation').slides[0]!, elements: [media, table, chart, image] }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    await act(async () => {
      root.render(<PresentationSlidePreview slide={slide} width={960} selected={false} />)
    })

    expect(host.querySelector<HTMLTableElement>('[data-testid="presentation-table-preview"]')?.style.transform).toBe('rotate(0deg)')
    expect(host.querySelector<SVGElement>('[data-testid="presentation-chart-preview"]')?.style.transform).toBe('rotate(0deg)')
    expect(host.querySelector<HTMLImageElement>('img')?.style.transform).toBe('rotate(45deg)')
  })

  it('renders centered PowerPoint text at point-correct CSS size inside the full text box width', async () => {
    const documentModel = createBlankPresentationDocument('Centered text')
    const slide = documentModel.slides[0]!
    slide.elements = [{
      id: 'centered-title',
      type: 'text',
      x: 520,
      y: 220,
      width: 240,
      height: 101,
      rotation: 0,
      text: '诸行无常',
      fontSize: 60,
      fontFamily: '思源宋体',
      fontWeight: 700,
      characterSpacing: 100,
      lineHeight: 1.4,
      color: '#1A1A1A',
      align: 'center',
      verticalAlign: 'top',
      wordWrap: false,
    }]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    await act(async () => {
      root.render(<PresentationSlidePreview slide={slide} width={1280} selected={false} />)
    })

    const textBox = host.querySelector<HTMLElement>('[data-testid="presentation-text-preview"]')!
    const content = textBox.querySelector('[data-testid="presentation-text-content"]')!.firstElementChild as HTMLElement
    expect(textBox.style.left).toBe('520px')
    expect(textBox.style.width).toBe('240px')
    expect(textBox.style.fontSize).toBe('60px')
    expect(textBox.style.textAlign).toBe('center')
    expect(textBox.style.letterSpacing).toBe('0.1em')
    expect(content.className).toContain('w-full')
  })

  it('renders East Asian vertical text in height-bound right-to-left columns', async () => {
    const documentModel = createBlankPresentationDocument('Vertical poem')
    const slide = documentModel.slides[0]!
    slide.elements = [{
      id: 'vertical-poem',
      type: 'text',
      x: 827,
      y: 133,
      width: 311,
      height: 173,
      rotation: 0,
      text: '万木冻欲折孤根暖独回 前村深雪里昨夜一枝开 \n风递幽香出禽窥素艳来 明年如应律先发映春台',
      fontSize: 30.1067,
      fontFamily: '叶根友毛笔行书2.0版',
      fontWeight: 400,
      color: '#000000',
      align: 'left',
      verticalAlign: 'top',
      textDirection: 'eastAsianVertical',
      textInsets: { left: 9.6, top: 4.8, right: 9.6, bottom: 4.8 },
    }]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    await act(async () => {
      root.render(<PresentationSlidePreview slide={slide} width={1280} selected={false} />)
    })

    const textBox = host.querySelector<HTMLElement>('[data-testid="presentation-text-preview"]')!
    const glyphs = Array.from(textBox.querySelector('[data-testid="presentation-text-content"]')!.children) as HTMLElement[]
    expect(glyphs).toHaveLength(40)
    expect(glyphs[0]!.textContent).toBe('万')
    expect(glyphs[5]!.textContent).toBe('孤')
    expect(glyphs[39]!.textContent).toBe('台')
    expect(Number.parseFloat(glyphs[0]!.style.left)).toBeGreaterThan(Number.parseFloat(glyphs[35]!.style.left))
    expect(Number.parseFloat(glyphs[4]!.style.top)).toBeGreaterThan(Number.parseFloat(glyphs[0]!.style.top))
  })

  it('keeps Fabric vertical text in the slide coordinate plane at its authored size', () => {
    const getContext = HTMLCanvasElement.prototype.getContext
    Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({
        font: '',
        textBaseline: 'alphabetic',
        measureText: (value: string) => ({ width: value.length * 24 }),
      }),
    })
    const element = {
      id: 'vertical-poem',
      type: 'text' as const,
      x: 827,
      y: 133,
      width: 311,
      height: 173,
      rotation: 0,
      text: '万木冻欲折孤根暖独回 前村深雪里昨夜一枝开 \n风递幽香出禽窥素艳来 明年如应律先发映春台',
      fontSize: 30.1067,
      fontFamily: '叶根友毛笔行书2.0版',
      fontWeight: 400 as const,
      color: '#000000',
      align: 'left' as const,
      verticalAlign: 'top' as const,
      textDirection: 'eastAsianVertical' as const,
      textInsets: { left: 9.6, top: 4.8, right: 9.6, bottom: 4.8 },
    }
    try {
      const group = createPresentationVerticalTextFabricObject(fabric, element)
      const glyphs = group.getObjects().filter((object): object is InstanceType<typeof fabric.Text> => (
        object instanceof fabric.Text
      ))

      expect(group).toMatchObject({
        left: element.x,
        top: element.y,
        width: element.width,
        height: element.height,
        scaleX: 1,
        scaleY: 1,
      })
      expect(group.getBoundingRect()).toMatchObject({
        left: element.x,
        top: element.y,
        width: element.width,
        height: element.height,
      })
      expect(glyphs).toHaveLength(40)
      expect(glyphs[0]).toMatchObject({
        text: '万',
        fontFamily: expect.stringContaining('"叶根友毛笔行书2.0版"'),
        fontSize: element.fontSize,
        scaleX: 1,
        scaleY: 1,
      })
      expect(glyphs[5]).toMatchObject({ text: '孤', fontSize: element.fontSize, scaleX: 1, scaleY: 1 })
      expect(glyphs[39]).toMatchObject({ text: '台', fontSize: element.fontSize, scaleX: 1, scaleY: 1 })
      for (const glyph of glyphs) {
        const bounds = glyph.getBoundingRect()
        expect(bounds.left).toBeGreaterThanOrEqual(element.x)
        expect(bounds.top).toBeGreaterThanOrEqual(element.y)
        expect(bounds.left + bounds.width).toBeLessThanOrEqual(element.x + element.width + 1)
        expect(bounds.top + bounds.height).toBeLessThanOrEqual(element.y + element.height + 1)
      }
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: getContext,
      })
    }
  })

  it('uses the same ellipse crop for picture-filled shapes in previews and Fabric', async () => {
    const element = {
      ...createPresentationImageElement(fileSource('image/png', 'landscape.png')),
      x: 141,
      y: 261,
      width: 221,
      height: 221,
      clipShape: 'ellipse' as const,
    }
    const clipPath = createPresentationImageFabricClipPath(fabric, element)
    expect(clipPath).toBeInstanceOf(fabric.Ellipse)
    expect(clipPath).toMatchObject({ rx: element.width / 2, ry: element.height / 2 })

    const documentModel = createBlankPresentationDocument('Picture-filled ellipse')
    documentModel.slides[0]!.elements = [element]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    await act(async () => {
      root.render(<PresentationSlidePreview slide={documentModel.slides[0]!} width={1280} selected={false} />)
    })

    expect(host.querySelector<HTMLImageElement>('img')?.style.borderRadius).toBe('50%')
  })

  it('draws negative Cartesian chart values on the opposite side of a shared zero axis', async () => {
    const range = getPresentationChartRange([{ name: 'Mixed', values: [10, -5] }])
    expect(range).toEqual({ min: -5, max: 10, span: 15 })
    expect(getPresentationChartValueRatio(-5, range)).toBe(0)
    expect(getPresentationChartValueRatio(0, range)).toBeCloseTo(1 / 3)
    expect(getPresentationChartValueRatio(10, range)).toBe(1)
    expect(getPresentationChartRange([{ name: 'Negative', values: [-8, -2] }])).toEqual({ min: -8, max: 0, span: 8 })
    expect(getPresentationChartRange([{ name: 'Zero', values: [0, 0] }])).toEqual({ min: 0, max: 1, span: 1 })

    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    const renderChart = async (chartType: 'column' | 'bar' | 'line') => {
      const chart = {
        ...createPresentationChartElement(chartType),
        categories: ['Positive', 'Negative'],
        series: [{ name: 'Mixed', values: [10, -5] }],
        showLegend: false,
        title: undefined,
      }
      const slide = { ...createBlankPresentationDocument('Negative chart').slides[0]!, elements: [chart] }
      await act(async () => {
        root.render(<PresentationSlidePreview slide={slide} width={960} selected={false} />)
      })
    }

    await renderChart('column')
    let axis = host.querySelector<SVGLineElement>('[data-testid="presentation-chart-zero-axis"]')!
    const zeroY = Number(axis.getAttribute('y1'))
    const columns = [...host.querySelectorAll<SVGRectElement>('[data-testid="presentation-chart-column"]')]
    const positiveColumn = columns[0]!
    const negativeColumn = columns[1]!
    expect(Number(positiveColumn.getAttribute('y')) + Number(positiveColumn.getAttribute('height'))).toBeCloseTo(zeroY)
    expect(Number(negativeColumn.getAttribute('y'))).toBeCloseTo(zeroY)
    expect(Number(negativeColumn.getAttribute('height'))).toBeGreaterThan(0)

    await renderChart('bar')
    axis = host.querySelector<SVGLineElement>('[data-testid="presentation-chart-zero-axis"]')!
    const zeroX = Number(axis.getAttribute('x1'))
    const bars = [...host.querySelectorAll<SVGRectElement>('[data-testid="presentation-chart-bar"]')]
    const positiveBar = bars[0]!
    const negativeBar = bars[1]!
    expect(Number(positiveBar.getAttribute('x'))).toBeCloseTo(zeroX)
    expect(Number(negativeBar.getAttribute('x')) + Number(negativeBar.getAttribute('width'))).toBeCloseTo(zeroX)
    expect(Number(negativeBar.getAttribute('width'))).toBeGreaterThan(0)

    await renderChart('line')
    axis = host.querySelector<SVGLineElement>('[data-testid="presentation-chart-zero-axis"]')!
    const lineZeroY = Number(axis.getAttribute('y1'))
    const points = [...host.querySelectorAll<SVGCircleElement>('circle')]
    expect(Number(points[0]?.getAttribute('cy'))).toBeLessThan(lineZeroY)
    expect(Number(points[1]?.getAttribute('cy'))).toBeGreaterThan(lineZeroY)
  })

  it('uses a minimum logical chart viewport while retaining a legacy small frame', async () => {
    const chart = { ...createPresentationChartElement('column'), width: 8, height: 8 }
    const slide = { ...createBlankPresentationDocument('Small chart').slides[0]!, elements: [chart] }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)
    await act(async () => {
      root.render(<PresentationSlidePreview slide={slide} width={960} selected={false} />)
    })

    const preview = host.querySelector<SVGElement>('[data-testid="presentation-chart-preview"]')!
    expect(preview.getAttribute('viewBox')).toBe('0 0 180 120')
    expect(preview.getAttribute('preserveAspectRatio')).toBe('none')
    expect(preview.style.width).toBe('8px')
    expect(preview.style.height).toBe('8px')
    const zeroAxis = host.querySelector<SVGLineElement>('[data-testid="presentation-chart-zero-axis"]')!
    const zeroY = Number(zeroAxis.getAttribute('y1'))
    expect(Number.isFinite(zeroY)).toBe(true)
    expect(zeroY).toBeGreaterThanOrEqual(0)
    expect(zeroY).toBeLessThanOrEqual(120)
  })
})
