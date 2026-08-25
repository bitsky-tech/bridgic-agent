import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Simulate } = await import('react-dom/test-utils')
const { createStore, Provider } = await import('jotai')
const { currentPresentationDocumentAtom } = await import('@/atoms/presentation')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { toastAtom } = await import('@/atoms/toast')
const { i18n } = await import('@/lib/i18n')
const { PresentationWorkbenchPanel } = await import('../PresentationWorkbenchPanel')

const mountedRoots = new Set<Root>()

beforeEach(async () => {
  await i18n.changeLanguage('zh')
})

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

async function mountPanel() {
  const store = createStore()
  const settings = store.get(settingsAtom)
  store.set(settingsAtom, { ...settings, ui: { ...settings.ui, lastNav: 'home' } })
  store.set(activeSessionIdAtom, `presentation-insert-${Math.random()}`)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  mountedRoots.add(root)
  await act(async () => {
    root.render(
      <Provider store={store}>
        <PresentationWorkbenchPanel active={false} />
      </Provider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  const insertTab = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-insert"]')!
  await act(async () => insertTab.click())
  return { host, root, store }
}

async function setInputValue(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const view = input.ownerDocument.defaultView!
    const prototype = input instanceof view.HTMLTextAreaElement
      ? view.HTMLTextAreaElement.prototype
      : view.HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(input, value)
    Simulate.change(input)
    await Promise.resolve()
  })
}

async function setSelectValue(select: HTMLSelectElement, value: string) {
  await act(async () => {
    const view = select.ownerDocument.defaultView!
    Object.getOwnPropertyDescriptor(view.HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    Simulate.change(select)
  })
}

async function submitOpenDialog() {
  const submit = document.querySelector<HTMLButtonElement>('form button[type="submit"]')!
  expect(submit).not.toBeNull()
  expect(submit.disabled).toBe(false)
  await act(async () => submit.click())
}

describe('presentation Insert tab integration', () => {
  it('inserts editable tables, charts, links, and footers into the document model', async () => {
    const { host, root, store } = await mountPanel()

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-insert-table"]')!.click())
    await submitOpenDialog()

    let presentation = store.get(currentPresentationDocumentAtom)
    let slide = presentation.slides.find((item) => item.id === presentation.selectedSlideId)!
    const table = slide.elements.at(-1)
    expect(table?.type).toBe('table')
    if (table?.type === 'table') expect(table.cells).toHaveLength(2)
    expect(host.querySelector('[data-testid="presentation-table-preview"]')).not.toBeNull()

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-insert-chart"]')!.click())
    await submitOpenDialog()
    presentation = store.get(currentPresentationDocumentAtom)
    slide = presentation.slides.find((item) => item.id === presentation.selectedSlideId)!
    const chart = slide.elements.at(-1)
    expect(chart?.type).toBe('chart')
    if (chart?.type === 'chart') {
      expect(chart.chartType).toBe('column')
      expect(chart.categories).toEqual(['A', 'B', 'C'])
      expect(chart.series[0]?.values).toEqual([10, 20, 30])
    }
    expect(host.querySelector('[data-testid="presentation-chart-preview"]')).not.toBeNull()

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-insert-link"]')!.click())
    await setInputValue(document.querySelector<HTMLInputElement>('[data-testid="presentation-insert-link-url"]')!, 'https://example.com/docs')
    await setInputValue(document.querySelector<HTMLInputElement>('[data-testid="presentation-insert-link-label"]')!, 'Documentation')
    await submitOpenDialog()
    presentation = store.get(currentPresentationDocumentAtom)
    slide = presentation.slides.find((item) => item.id === presentation.selectedSlideId)!
    const link = slide.elements.at(-1)
    expect(link?.type).toBe('text')
    if (link?.type === 'text') {
      expect(link.text).toBe('Documentation')
      expect(link.hyperlink).toEqual({ type: 'url', url: 'https://example.com/docs' })
    }

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-insert-footer"]')!.click())
    await setInputValue(document.querySelector<HTMLInputElement>('[data-testid="presentation-insert-footer-text"]')!, 'Confidential')
    await submitOpenDialog()
    presentation = store.get(currentPresentationDocumentAtom)
    expect(presentation.slides.every((item) => item.footer?.text === 'Confidential')).toBe(true)
    expect(presentation.slides.every((item) => item.footer?.showSlideNumber)).toBe(true)
    expect(host.querySelector('[data-testid="presentation-slide-preview"]')?.textContent).toContain('Confidential')

    await act(async () => {
      root.unmount()
      mountedRoots.delete(root)
    })
  })

  it('reads selected image, audio, and video files into portable media elements', async () => {
    const { host, root, store } = await mountPanel()
    const originalCreateImageBitmap = globalThis.createImageBitmap
    Object.defineProperty(globalThis, 'createImageBitmap', {
      configurable: true,
      value: async () => ({ width: 1, height: 1, close: () => undefined }) as ImageBitmap,
    })
    const transparentPng = Uint8Array.from(
      atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
      (character) => character.charCodeAt(0),
    )
    const cases = [
      { bytes: transparentPng, kind: 'image', name: 'photo.png', type: 'image/png' },
      { bytes: new Uint8Array([1, 2, 3, 4]), kind: 'audio', name: 'sound.mp3', type: '' },
      { bytes: new Uint8Array([1, 2, 3, 4]), kind: 'video', name: 'clip.mp4', type: 'video/mp4' },
    ] as const

    try {
      for (const item of cases) {
        const input = host.querySelector<HTMLInputElement>(`[data-testid="presentation-${item.kind}-input"]`)!
        const file = new File([item.bytes], item.name, { type: item.type })
        Object.defineProperty(input, 'files', { configurable: true, value: [file] })
        await act(async () => {
          input.dispatchEvent(new input.ownerDocument.defaultView!.Event('change', { bubbles: true }))
          await new Promise((resolve) => setTimeout(resolve, 20))
        })
      }
    } finally {
      Object.defineProperty(globalThis, 'createImageBitmap', {
        configurable: true,
        value: originalCreateImageBitmap,
      })
    }

    const presentation = store.get(currentPresentationDocumentAtom)
    const slide = presentation.slides.find((item) => item.id === presentation.selectedSlideId)!
    const inserted = slide.elements.slice(-3)
    expect(inserted.map((element) => element.type)).toEqual(['image', 'audio', 'video'])
    for (const element of inserted) {
      if (element.type === 'image' || element.type === 'audio' || element.type === 'video') {
        expect(element.source.dataUrl).toStartWith(`data:${element.source.mimeType};base64,`)
      }
    }
    expect(host.querySelector('img[src^="data:image/png;base64,"]')).not.toBeNull()
    expect(host.textContent).toContain('sound.mp3')
    expect(host.textContent).toContain('clip.mp4')

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="从当前页放映"]')!.click())
    expect(host.querySelector('[data-testid="presentation-slideshow"] audio[controls]')).not.toBeNull()
    expect(host.querySelector('[data-testid="presentation-slideshow"] video[controls]')).not.toBeNull()

    await act(async () => {
      root.unmount()
      mountedRoots.delete(root)
    })
  })

  it('cancels an asynchronous file insertion when its target slide changes', async () => {
    const { host, root, store } = await mountPanel()
    const initial = store.get(currentPresentationDocumentAtom)
    const targetSlide = initial.slides[0]!
    const otherSlide = initial.slides[1]!
    expect(initial.selectedSlideId).toBe(targetSlide.id)

    const originalReadAsDataUrl = FileReader.prototype.readAsDataURL
    const pendingRead: { current?: { blob: Blob; reader: FileReader } } = {}
    FileReader.prototype.readAsDataURL = function delayedRead(blob: Blob) {
      pendingRead.current = { blob, reader: this }
    }

    try {
      const input = host.querySelector<HTMLInputElement>('[data-testid="presentation-audio-input"]')!
      const file = new File([new Uint8Array([1, 2, 3, 4])], 'delayed.mp3', { type: 'audio/mpeg' })
      Object.defineProperty(input, 'files', { configurable: true, value: [file] })
      await act(async () => {
        input.dispatchEvent(new input.ownerDocument.defaultView!.Event('change', { bubbles: true }))
        await Promise.resolve()
      })
      expect(pendingRead.current).not.toBeUndefined()

      await act(async () => {
        store.set(currentPresentationDocumentAtom, { ...initial, selectedSlideId: otherSlide.id })
        await Promise.resolve()
      })
      const read = pendingRead.current
      if (!read) throw new Error('Expected a pending FileReader operation')
      originalReadAsDataUrl.call(read.reader, read.blob)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
      })

      const current = store.get(currentPresentationDocumentAtom)
      expect(current.selectedSlideId).toBe(otherSlide.id)
      expect(current.slides.every((slide) => slide.elements.every((element) => element.type !== 'audio'))).toBe(true)
      expect(store.get(toastAtom)?.message).toBe('已取消')
    } finally {
      FileReader.prototype.readAsDataURL = originalReadAsDataUrl
      await act(async () => {
        root.unmount()
        mountedRoots.delete(root)
      })
    }
  })

  it('follows an internal slide link during slide show playback', async () => {
    const { host, root, store } = await mountPanel()
    const presentation = store.get(currentPresentationDocumentAtom)
    const targetSlide = presentation.slides[1]!

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-insert-link"]')!.click())
    await setSelectValue(document.querySelector<HTMLSelectElement>('[data-testid="presentation-insert-link-type"]')!, 'slide')
    await setSelectValue(document.querySelector<HTMLSelectElement>('[data-testid="presentation-insert-link-slide"]')!, targetSlide.id)
    await setInputValue(document.querySelector<HTMLInputElement>('[data-testid="presentation-insert-link-label"]')!, 'Next slide')
    await submitOpenDialog()

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="从当前页放映"]')!.click())
    const link = host.querySelector<HTMLButtonElement>('[data-testid="presentation-slideshow"] button[aria-label="Go to slide"]')!
    expect(link).not.toBeNull()
    await act(async () => link.click())
    expect(host.querySelector('[data-testid="presentation-slideshow"]')?.textContent).toContain('2 / 2')

    await act(async () => {
      root.unmount()
      mountedRoots.delete(root)
    })
  })
})
