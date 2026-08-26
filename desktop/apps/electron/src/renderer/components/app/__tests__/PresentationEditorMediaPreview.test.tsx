import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PresentationMediaElement } from '@/atoms/presentation'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Simulate } = await import('react-dom/test-utils')
const { i18n } = await import('@/lib/i18n')
const { createPresentationMediaElement } = await import('@/lib/presentationInsert')
const { PresentationEditorMediaPreview } = await import('../PresentationEditorMediaPreview')

const mountedRoots = new Set<Root>()
const originalPlay = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'play')
const originalPause = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'pause')
let playCalls = 0
let pauseCalls = 0

beforeEach(async () => {
  await i18n.changeLanguage('en')
  playCalls = 0
  pauseCalls = 0
  Object.defineProperty(HTMLMediaElement.prototype, 'play', {
    configurable: true,
    value() {
      playCalls += 1
      return Promise.resolve()
    },
  })
  Object.defineProperty(HTMLMediaElement.prototype, 'pause', {
    configurable: true,
    value() {
      pauseCalls += 1
    },
  })
})

afterEach(async () => {
  await act(async () => {
    for (const root of mountedRoots) root.unmount()
    mountedRoots.clear()
  })
  document.body.replaceChildren()
})

afterAll(async () => {
  if (originalPlay) Object.defineProperty(HTMLMediaElement.prototype, 'play', originalPlay)
  else Reflect.deleteProperty(HTMLMediaElement.prototype, 'play')
  if (originalPause) Object.defineProperty(HTMLMediaElement.prototype, 'pause', originalPause)
  else Reflect.deleteProperty(HTMLMediaElement.prototype, 'pause')
  await GlobalRegistrator.unregister()
})

function createMedia(type: PresentationMediaElement['type'], overrides: Partial<PresentationMediaElement> = {}): PresentationMediaElement {
  return {
    ...createPresentationMediaElement(type, {
      dataUrl: type === 'audio' ? 'data:audio/mpeg;base64,AAAA' : 'data:video/mp4;base64,AAAA',
      fileName: type === 'audio' ? 'voice-over.mp3' : 'opening.mp4',
      mimeType: type === 'audio' ? 'audio/mpeg' : 'video/mp4',
    }),
    ...overrides,
  } as PresentationMediaElement
}

async function mountPreview(element: PresentationMediaElement): Promise<{ host: HTMLElement; root: Root }> {
  const outer = document.createElement('div')
  const host = document.createElement('div')
  outer.appendChild(host)
  document.body.appendChild(outer)
  const root = createRoot(host)
  mountedRoots.add(root)
  await act(async () => {
    root.render(<PresentationEditorMediaPreview element={element} />)
  })
  return { host, root }
}

function setInputValue(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
}

describe('PresentationEditorMediaPreview', () => {
  it('renders the audio transport without autoplay and pauses on unmount', async () => {
    const { host, root } = await mountPreview(createMedia('audio', {
      x: 120,
      y: 80,
      width: 520,
      height: 72,
      autoplay: true,
      loop: true,
      muted: true,
    }))
    const preview = host.querySelector<HTMLElement>('[data-testid="presentation-editor-media-preview"]')!
    const media = host.querySelector<HTMLAudioElement>('[data-testid="presentation-editor-media-preview-media"]')!
    const interactive = host.querySelectorAll('.pointer-events-auto')

    expect(preview.dataset.mediaType).toBe('audio')
    expect(preview.classList.contains('pointer-events-none')).toBe(true)
    expect(preview.classList.contains('relative')).toBe(true)
    expect(preview.classList.contains('absolute')).toBe(false)
    expect(preview.style.left).toBe('')
    expect(preview.style.top).toBe('')
    expect(media.tagName).toBe('AUDIO')
    expect(media.autoplay).toBe(false)
    expect(media.controls).toBe(false)
    expect(media.loop).toBe(true)
    expect(media.muted).toBe(true)
    expect(playCalls).toBe(0)
    expect(pauseCalls).toBe(1)
    expect(host.querySelector('[data-testid="presentation-editor-media-preview-waveform"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="presentation-editor-media-preview-filename"]')?.textContent).toBe('voice-over.mp3')
    expect(interactive).toHaveLength(2)

    await act(async () => {
      root.unmount()
    })
    mountedRoots.delete(root)
    expect(pauseCalls).toBe(2)
  })

  it('plays, pauses, seeks, and keeps editor gestures from escaping without preventing defaults', async () => {
    const { host } = await mountPreview(createMedia('audio'))
    const button = host.querySelector<HTMLButtonElement>('[data-testid="presentation-editor-media-preview-toggle"]')!
    const range = host.querySelector<HTMLInputElement>('[data-testid="presentation-editor-media-preview-seek"]')!
    const media = host.querySelector<HTMLAudioElement>('[data-testid="presentation-editor-media-preview-media"]')!
    const outer = host.parentElement!
    const bubbled = { click: 0, pointerdown: 0, pointerup: 0, mousedown: 0, mouseup: 0, keydown: 0, keyup: 0, change: 0 }
    for (const type of Object.keys(bubbled) as Array<keyof typeof bubbled>) {
      outer.addEventListener(type, () => {
        bubbled[type] += 1
      })
    }

    const playClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => button.dispatchEvent(playClick))
    expect(playClick.defaultPrevented).toBe(false)
    expect(bubbled.click).toBe(0)
    expect(playCalls).toBe(1)
    expect(button.getAttribute('aria-label')).toBe('Pause media')

    const pauseClick = new MouseEvent('click', { bubbles: true, cancelable: true })
    await act(async () => button.dispatchEvent(pauseClick))
    expect(pauseClick.defaultPrevented).toBe(false)
    expect(bubbled.click).toBe(0)
    expect(pauseCalls).toBe(2)
    expect(button.getAttribute('aria-label')).toBe('Play media')

    Object.defineProperty(media, 'duration', { configurable: true, value: 120 })
    media.currentTime = 30
    await act(async () => {
      media.dispatchEvent(new Event('loadedmetadata', { bubbles: false }))
      media.dispatchEvent(new Event('timeupdate', { bubbles: false }))
    })
    expect(range.max).toBe('120')
    expect(range.value).toBe('30')

    setInputValue(range, '75')
    await act(async () => Simulate.change(range))
    expect(media.currentTime).toBe(75)
    expect(range.value).toBe('75')
    expect(bubbled.change).toBe(0)

    const pointerDown = new PointerEvent('pointerdown', { bubbles: true, cancelable: true })
    button.dispatchEvent(pointerDown)
    const pointerUp = new PointerEvent('pointerup', { bubbles: true, cancelable: true })
    button.dispatchEvent(pointerUp)
    const mouseDown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    range.dispatchEvent(mouseDown)
    const mouseUp = new MouseEvent('mouseup', { bubbles: true, cancelable: true })
    range.dispatchEvent(mouseUp)
    const keyDown = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    range.dispatchEvent(keyDown)
    const keyUp = new KeyboardEvent('keyup', { key: ' ', bubbles: true, cancelable: true })
    range.dispatchEvent(keyUp)
    expect(pointerDown.defaultPrevented).toBe(false)
    expect(pointerUp.defaultPrevented).toBe(false)
    expect(mouseDown.defaultPrevented).toBe(false)
    expect(mouseUp.defaultPrevented).toBe(false)
    expect(keyDown.defaultPrevented).toBe(false)
    expect(keyUp.defaultPrevented).toBe(false)
    expect(bubbled.pointerdown).toBe(0)
    expect(bubbled.pointerup).toBe(0)
    expect(bubbled.mousedown).toBe(0)
    expect(bubbled.mouseup).toBe(0)
    expect(bubbled.keydown).toBe(0)
    expect(bubbled.keyup).toBe(0)
  })

  it('renders a real video frame with custom controls and never native or automatic playback', async () => {
    const { host } = await mountPreview(createMedia('video', {
      x: 50,
      y: 40,
      width: 640,
      height: 360,
      autoplay: true,
    }))
    const preview = host.querySelector<HTMLElement>('[data-testid="presentation-editor-media-preview"]')!
    const media = host.querySelector<HTMLVideoElement>('[data-testid="presentation-editor-media-preview-media"]')!
    const button = host.querySelector<HTMLButtonElement>('[data-testid="presentation-editor-media-preview-toggle"]')!

    expect(preview.dataset.mediaType).toBe('video')
    expect(media.tagName).toBe('VIDEO')
    expect(media.autoplay).toBe(false)
    expect(media.controls).toBe(false)
    expect(media.hasAttribute('playsinline')).toBe(true)
    expect(media.classList.contains('object-contain')).toBe(true)
    expect(host.querySelector('[data-testid="presentation-editor-media-preview-waveform"]')).toBeNull()
    expect(host.querySelector('[data-testid="presentation-editor-media-preview-filename"]')?.textContent).toBe('opening.mp4')
    expect(button.classList.contains('pointer-events-auto')).toBe(true)
    expect(playCalls).toBe(0)
  })
})
