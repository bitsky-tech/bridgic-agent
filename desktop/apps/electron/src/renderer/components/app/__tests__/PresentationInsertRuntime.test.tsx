import { afterAll, afterEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { StrictMode, act } = await import('react')
const { createRoot } = await import('react-dom/client')
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
  createPresentationMediaFabricObject,
  estimatePresentationDocumentBytes,
  isPresentationRotationLocked,
  PresentationNumberField,
  resolvePresentationNumberFieldValue,
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
      }
    } finally {
      Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
        configurable: true,
        value: getContext,
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
    const overlay = content.querySelector('button')!
    const media = content.querySelector('audio')!
    const children = [...content.children]
    expect(content.querySelectorAll('button')).toHaveLength(1)
    expect(children.indexOf(image)).toBeLessThan(children.indexOf(overlay))
    expect(children.indexOf(overlay)).toBeLessThan(children.indexOf(media))
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
