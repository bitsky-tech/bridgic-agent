import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createBlankPresentationDocument } = await import('@/atoms/presentation')
const {
  createPresentationImageElement,
  createPresentationMediaElement,
  createPresentationTableElement,
  createPresentationChartElement,
} = await import('@/lib/presentationInsert')
const {
  createPresentationHistoryEntry,
  estimatePresentationDocumentBytes,
  isPresentationRotationLocked,
  resolvePresentationSlideshowKeyAction,
  trimPresentationHistoryEntries,
} = await import('../PresentationWorkbenchPanel')
const {
  getPresentationChartRange,
  getPresentationChartValueRatio,
  PresentationSlidePreview,
} = await import('../PresentationSlidePreview')

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

  it('suppresses and mutes transition media, then restores stable playback settings', async () => {
    const audio = { ...createPresentationMediaElement('audio', fileSource('audio/mpeg', 'sound.mp3')), autoplay: true, muted: false }
    const video = { ...createPresentationMediaElement('video', fileSource('video/mp4', 'clip.mp4')), autoplay: true, muted: false }
    const slide = { ...createBlankPresentationDocument('Media').slides[0]!, elements: [audio, video] }
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    mountedRoots.add(root)

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

    await render(true)
    for (const media of host.querySelectorAll<HTMLMediaElement>('audio, video')) {
      expect(media.autoplay).toBe(false)
      expect(media.muted).toBe(true)
    }

    await render(false)
    for (const media of host.querySelectorAll<HTMLMediaElement>('audio, video')) {
      expect(media.autoplay).toBe(true)
      expect(media.muted).toBe(false)
    }
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
})
