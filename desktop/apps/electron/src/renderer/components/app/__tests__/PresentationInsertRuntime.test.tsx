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
  createPresentationMediaRuntime,
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
