import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Root } from 'react-dom/client'
import type { PresentationDocument, PresentationElement, PresentationTextElement } from '@/atoms/presentation'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { createBlankPresentationDocument, createBlankPresentationSlide, currentPresentationDocumentAtom, powerPointSessionIdOverrideAtom } = await import('@/atoms/presentation')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { installApiStub } = await import('@/lib/apiStub')
const { i18n } = await import('@/lib/i18n')
const { createPresentationMediaElement } = await import('@/lib/presentationInsert')
const { PresentationWorkbenchPanel } = await import('../PresentationWorkbenchPanel')
const { PresentationAnimationPlayer } = await import('../PresentationAnimationPlayer')

const descriptors = ['play', 'pause', 'paused'].map(key => [key, Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, key)] as const)
const originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
let plays: HTMLMediaElement[]
let pauses: HTMLMediaElement[]
let animations: Array<{ node: Element; options?: KeyframeAnimationOptions; frames: Keyframe[]; finish: () => void }>
let roots: Root[]

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  installApiStub()
  plays = []; pauses = []; animations = []; roots = []
  const playing = new WeakSet<HTMLMediaElement>()
  Object.defineProperties(HTMLMediaElement.prototype, {
    paused: { configurable: true, get() { return !playing.has(this) } },
    play: { configurable: true, value() { plays.push(this); playing.add(this); this.dispatchEvent(new Event('play')); return Promise.resolve() } },
    pause: { configurable: true, value() { pauses.push(this); playing.delete(this); this.dispatchEvent(new Event('pause')) } },
  })
  Object.defineProperty(Element.prototype, 'animate', { configurable: true, value(_frames: Keyframe[], options?: KeyframeAnimationOptions) {
    let finish = () => {}
    const finished = new Promise<void>(resolve => { finish = resolve })
    animations.push({ node: this, options, frames: _frames, finish })
    return { finished, cancel: finish }
  } })
})

afterEach(async () => {
  await act(async () => roots.forEach(root => root.unmount()))
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(HTMLMediaElement.prototype, key, descriptor)
    else Reflect.deleteProperty(HTMLMediaElement.prototype, key)
  }
  if (originalAnimate) Object.defineProperty(Element.prototype, 'animate', originalAnimate)
  else Reflect.deleteProperty(Element.prototype, 'animate')
  document.body.replaceChildren()
})
afterAll(() => GlobalRegistrator.unregister())

function bullet(id: string, overrides: Partial<PresentationTextElement> = {}): PresentationTextElement {
  return { id, type: 'text', text: id, x: 180, y: 180, width: 600, height: 80, rotation: 0,
    fontSize: 32, fontFamily: 'Arial', fontWeight: 400, color: '#111111', align: 'left', animation: 'appear', ...overrides }
}

async function mount(model: PresentationDocument) {
  const store = createStore()
  const settings = store.get(settingsAtom)
  store.set(settingsAtom, { ...settings, ui: { ...settings.ui, lastNav: 'home' } })
  store.set(activeSessionIdAtom, 'slideshow-playback')
  store.set(powerPointSessionIdOverrideAtom, 'slideshow-playback')
  store.set(currentPresentationDocumentAtom, model)
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  roots.push(root)
  await act(async () => root.render(<Provider store={store}><PresentationWorkbenchPanel active={false} /></Provider>))
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
  await click(host, 'session.presentation.playFromCurrent')
  expect(host.textContent).toContain(model.title)
  return host
}

async function click(host: HTMLElement, key: string) {
  const button = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t(key)}"]`)!
  expect(button).not.toBeNull()
  await act(async () => button.click())
}

async function finishStep() {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 370)) })
}

describe('slideshow playback interactions', () => {
  it.each(['fillColor', 'textColor', 'zoom'] as const)('holds %s through later steps and the outgoing transition, then resets on revisit', async effect => {
    const model = createBlankPresentationDocument('Emphasis lifecycle')
    const originalShape = { id: 'emphasis', type: 'rect' as const, x: 320, y: 200, width: 320, height: 160, rotation: 0, fill: '#CC2222', borderColor: '#CC2222', borderWidth: 0 }
    const element: PresentationElement = {
      ...(effect === 'textColor' ? bullet('Emphasis', { color: '#CC2222', textRuns: [{ start: 0, end: 8, style: { color: '#FF8800', fontSize: 21 } }] }) : originalShape),
      animation: effect, animationDuration: 180, animationColor: '#2266CC',
    }
    model.slides[0]!.elements = [element, bullet('Later')]
    const next = createBlankPresentationSlide('Next')
    next.transition = { effect: 'fade', durationMs: 800 }
    model.slides.push(next)
    const original = JSON.stringify(model)
    const host = await mount(model)
    const assertAppearance = (container: Element, emphasized: boolean) => {
      const preview = container.querySelector('[data-testid="presentation-slide-preview"]')!
      if (effect === 'textColor') {
        const text = preview.querySelector<HTMLElement>('[data-testid="presentation-text-preview"]')!
        expect(text.style.color.toUpperCase()).toBe(emphasized ? '#2266CC' : '#CC2222')
        expect(text.querySelector<HTMLElement>('[data-testid="presentation-text-paragraph"] span[style*="color"]')!.style.color.toUpperCase()).toBe(emphasized ? '#2266CC' : '#FF8800')
      } else {
        const shape = preview.querySelector<SVGSVGElement>('svg')!
        expect(shape.querySelector('rect')!.getAttribute('fill')).toBe(effect === 'fillColor' && emphasized ? '#2266CC' : '#CC2222')
        expect(shape.style.transform.includes('scale(1.5)')).toBe(effect === 'zoom' && emphasized)
        expect(shape.style.width).toBe('320px')
      }
    }
    const slideshow = () => host.querySelector<HTMLElement>('[data-testid="presentation-slideshow"]')!
    assertAppearance(slideshow(), false)
    await click(host, 'session.presentation.nextSlide')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
    assertAppearance(slideshow(), true)
    await click(host, 'session.presentation.nextSlide')
    assertAppearance(slideshow(), true)
    await finishStep()
    assertAppearance(slideshow(), true)
    await click(host, 'session.presentation.nextSlide')
    assertAppearance(host.querySelector('[data-testid="presentation-transition-previous"]')!, true)
    await act(async () => animations.at(-1)!.finish())
    await click(host, 'session.presentation.previousSlide')
    assertAppearance(slideshow(), false)
    await click(host, 'session.presentation.closeSlideshow')
    expect(host.querySelector('[data-testid="presentation-slideshow"]')).toBeNull()
    expect(JSON.stringify(model)).toBe(original)
  })

  it.each(['zoom', 'textColor'] as const)('keeps %s hyperlinks usable and carries the held state into a linked transition', async effect => {
    const model = createBlankPresentationDocument('Emphasis link')
    const target = createBlankPresentationSlide('Linked')
    target.transition = { effect: 'fade', durationMs: 800 }
    model.slides.push(target)
    model.slides[0]!.elements = [bullet('Continue', { animation: effect, animationDuration: 180, animationColor: '#2266CC',
      hyperlink: { type: 'slide', slideId: target.id, tooltip: 'Continue link' },
    })]
    const host = await mount(model)
    await click(host, 'session.presentation.nextSlide')
    if (effect === 'textColor') {
      const targetRun = host.querySelector<HTMLElement>('[data-testid="presentation-slideshow"] [data-presentation-text-color]')!
      const colorAnimation = animations.find(animation => animation.node === targetRun)!
      expect(colorAnimation.frames.at(-1)).toEqual({ color: '#2266CC' })
    }
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 500)) })
    const slideshow = host.querySelector<HTMLElement>('[data-testid="presentation-slideshow"]')!
    const link = slideshow.querySelector<HTMLButtonElement>('button[aria-label="Continue link"]')!
    const text = slideshow.querySelector<HTMLElement>('[data-testid="presentation-text-preview"]')!
    expect(link.style.transform).toBe(text.style.transform)
    if (effect === 'textColor') expect(text.querySelector<HTMLElement>('[data-testid="presentation-text-paragraph"] span[style*="color"]')!.style.color.toUpperCase()).toBe('#2266CC')
    await act(async () => link.click())
    const outgoing = host.querySelector<HTMLElement>('[data-testid="presentation-transition-previous"] [data-testid="presentation-text-preview"]')!
    expect(outgoing.style.transform).toBe(text.style.transform)
    expect(outgoing.style.color).toBe(text.style.color)
    await act(async () => animations.at(-1)!.finish())
    expect(host.querySelector('[data-testid="presentation-slideshow"]')!.textContent).toContain('2 / 2')
  })

  for (const type of ['audio', 'video'] as const) it.each([false, true])(`preserves ${type} with autoplay=%s through two unrelated animations and stops it on exit`, async autoplay => {
    const media = { ...createPresentationMediaElement(type, { dataUrl: type === 'audio' ? 'data:audio/wav;base64,UklGRg==' : 'data:video/mp4;base64,AAAAHGZ0eXBpc29t', fileName: 'Narration', mimeType: type === 'audio' ? 'audio/wav' : 'video/mp4' }), autoplay }
    const model = createBlankPresentationDocument('Media lifecycle')
    model.slides[0]!.elements = [bullet('First'), media, bullet('Second')]
    model.slides.push(createBlankPresentationSlide('Next'))
    const host = await mount(model)
    const slideshow = host.querySelector<HTMLElement>('[data-testid="presentation-slideshow"]')!
    const node = slideshow.querySelector<HTMLMediaElement>(type)!
    expect(plays.length).toBe(autoplay ? 1 : 0)
    if (!autoplay) await act(async () => { await node.play() })
    node.currentTime = 7
    for (let step = 0; step < 2; step++) {
      await click(slideshow, 'session.presentation.nextSlide')
      expect(slideshow.querySelector(type) === node).toBe(true)
      expect(node.paused).toBe(false)
      const part = slideshow.querySelector('[data-animation-part]')!
      expect(Boolean(part.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(step === 0)
      await finishStep()
      expect(slideshow.querySelector(type) === node).toBe(true)
      expect(node.currentTime).toBe(7)
      expect(plays).toHaveLength(1)
      expect(pauses).toHaveLength(0)
    }
    await click(slideshow, 'session.presentation.nextSlide')
    expect(node.isConnected).toBe(false)
    expect(pauses).toContain(node)
  })

  it('plays and pauses from SVG and path hit targets without advancing the slide', async () => {
    const media = { ...createPresentationMediaElement('audio', { dataUrl: 'data:audio/wav;base64,UklGRg==', fileName: 'Narration', mimeType: 'audio/wav' }), autoplay: false }
    const model = createBlankPresentationDocument('Audio controls')
    model.slides[0]!.elements = [media, bullet('Pending')]
    const host = await mount(model)
    const slideshow = host.querySelector<HTMLElement>('[data-testid="presentation-slideshow"]')!
    const node = slideshow.querySelector('audio')!
    for (const target of ['path', 'svg', 'svg']) {
      const control = slideshow.querySelector('button[aria-label="Narration"]')!
      const icon = control.querySelector(target)!
      expect(icon).not.toBeNull()
      await act(async () => { icon.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
      expect(slideshow.querySelector('[data-testid="presentation-animation-player"]')).toBeNull()
      expect(slideshow.querySelector('audio') === node).toBe(true)
    }
    expect(plays).toHaveLength(2)
    expect(pauses).toHaveLength(1)
    await click(slideshow, 'session.presentation.nextSlide')
    expect(slideshow.querySelector('[data-testid="presentation-animation-player"]')).not.toBeNull()
  })

  it.each(['withPrevious', 'afterPrevious'] as const)('starts an initial %s animation once while retaining click steps', async animationStart => {
    const model = createBlankPresentationDocument('Automatic intro')
    model.slides[0]!.elements = [bullet('Automatic', { animationStart, animationDelay: 80 }), bullet('Manual')]
    const host = await mount(model)
    const slideshow = host.querySelector<HTMLElement>('[data-testid="presentation-slideshow"]')!
    expect(slideshow.querySelector('[data-testid="presentation-animation-player"]')).not.toBeNull()
    expect(animations).toHaveLength(1)
    expect(animations[0]!.options?.delay).toBe(80)
    await finishStep()
    expect(slideshow.querySelector('[data-testid="presentation-animation-player"]')).toBeNull()
    const preview = slideshow.querySelector('[data-testid="presentation-slide-preview"]')!
    expect(preview.textContent).toContain('Automatic')
    expect(preview.textContent).not.toContain('Manual')
    await click(slideshow, 'session.presentation.nextSlide')
    await finishStep()
    expect(animations).toHaveLength(2)
    expect(preview.textContent).toContain('Manual')
  })

  it('waits for the incoming transition and replays automatic content on revisiting the slide', async () => {
    const model = createBlankPresentationDocument('Transition and auto intro')
    const incoming = createBlankPresentationSlide('Incoming')
    incoming.transition = { effect: 'fade', durationMs: 800 }
    incoming.elements = [bullet('Automatic', { animationStart: 'afterPrevious' })]
    model.slides.push(incoming)
    const host = await mount(model)
    for (let visit = 0; visit < 2; visit++) {
      await click(host, 'session.presentation.nextSlide')
      expect(host.querySelector('[data-testid="presentation-transition-player"]')).not.toBeNull()
      expect(host.querySelector('[data-testid="presentation-animation-player"]')).toBeNull()
      const transition = animations.at(-1)!
      expect(transition.node.getAttribute('data-testid')).toBe('presentation-transition-current')
      await act(async () => transition.finish())
      expect(host.querySelector('[data-testid="presentation-transition-player"]')).toBeNull()
      expect(host.querySelector('[data-testid="presentation-animation-player"]')).not.toBeNull()
      await finishStep()
      await click(host, 'session.presentation.previousSlide')
    }
  })

  it('keeps explicit element-click triggers manual even with an automatic start setting', async () => {
    const model = createBlankPresentationDocument('Element trigger')
    model.slides[0]!.elements = [bullet('Triggered', { animationStart: 'withPrevious', animationTrigger: 'elementClick' })]
    const host = await mount(model)
    expect(animations).toHaveLength(0)
    await click(host, 'session.presentation.triggerElementClick')
    expect(animations).toHaveLength(1)
  })

  it('keeps ribbon animation previews silent', async () => {
    const model = createBlankPresentationDocument('Silent preview')
    model.slides[0]!.elements = [
      { ...createPresentationMediaElement('audio', { dataUrl: 'data:audio/wav;base64,UklGRg==', fileName: 'Narration', mimeType: 'audio/wav' }), autoplay: true }, bullet('Animated'),
    ]
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    roots.push(root)
    await act(async () => root.render(<PresentationAnimationPlayer runKey={1} slide={model.slides[0]!} width={1280} />))
    expect(host.querySelector('audio')).toBeNull()
    expect(plays).toHaveLength(0)
  })
})
