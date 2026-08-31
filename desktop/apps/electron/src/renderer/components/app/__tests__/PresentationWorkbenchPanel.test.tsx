import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { Simulate } = await import('react-dom/test-utils')
const { createStore, Provider } = await import('jotai')
const { currentPresentationDocumentAtom, currentPresentationWorkspaceAtom } = await import('@/atoms/presentation')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { i18n } = await import('@/lib/i18n')
const { createPresentationTestDocument } = await import('@/test-fixtures/presentation')
const { PresentationWorkbenchPanel } = await import('../PresentationWorkbenchPanel')

const originalElementAnimateDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'animate')
let transitionAnimationCalls: Keyframe[][] = []

function installTransitionAnimationMock() {
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value(frames: Keyframe[]) {
      transitionAnimationCalls.push(frames)
      let finish: () => void = () => undefined
      const finished = new Promise<void>((resolve) => {
        finish = resolve
      })
      return {
        finished,
        cancel: finish,
      } as unknown as Animation
    },
  })
}

beforeEach(async () => {
  await i18n.changeLanguage('zh')
  transitionAnimationCalls = []
})

afterEach(() => {
  if (originalElementAnimateDescriptor) Object.defineProperty(Element.prototype, 'animate', originalElementAnimateDescriptor)
  else Reflect.deleteProperty(Element.prototype, 'animate')
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function mountPanel(withTestContent = true, onClose?: () => void) {
  const store = createStore()
  const settings = store.get(settingsAtom)
  store.set(settingsAtom, { ...settings, ui: { ...settings.ui, lastNav: 'home' } })
  store.set(activeSessionIdAtom, 'presentation-session')
  if (withTestContent) store.set(currentPresentationDocumentAtom, createPresentationTestDocument())
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Provider store={store}>
        <PresentationWorkbenchPanel active={false} onClose={onClose} />
      </Provider>,
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
  })
  return { host, root, store }
}

describe('PresentationWorkbenchPanel', () => {
  it('selects a slide without advancing the document revision', async () => {
    const { host, root, store } = await mountPanel()
    const initial = store.get(currentPresentationDocumentAtom)
    const target = initial.slides[1]!
    const preview = host.querySelectorAll<HTMLElement>('[data-testid="presentation-slide-preview"]')[1]!
    const button = preview.closest<HTMLButtonElement>('button')!

    await act(async () => button.click())

    const selected = store.get(currentPresentationDocumentAtom)
    expect(selected.selectedSlideId).toBe(target.id)
    expect(selected.version).toBe(initial.version)

    await act(async () => root.unmount())
  })

  it('opens directly into one presentation with three ordinary text boxes', async () => {
    const { host, root, store } = await mountPanel(false)
    const presentation = store.get(currentPresentationDocumentAtom)

    expect(presentation.title).toBe('')
    expect(presentation.slides).toHaveLength(1)
    expect(presentation.slides[0]?.layout).toBe('title')
    expect(presentation.slides[0]?.elements).toHaveLength(3)
    expect(presentation.slides[0]?.elements.every((element) => element.type === 'text')).toBe(true)
    expect(presentation.slides[0]?.elements.every((element) => !('placeholder' in element))).toBe(true)
    expect(host.querySelector('[data-testid="presentation-document-tab"]')?.textContent).toBe('未命名演示文稿.pptx')
    expect(host.querySelectorAll('[data-testid="presentation-slide-preview"]')).toHaveLength(1)
    expect(host.textContent).not.toContain('Ideas that move forward')

    await act(async () => root.unmount())
  })

  it('closes the entire PPT surface when the only document tab is closed', async () => {
    let closeCalls = 0
    const { host, root, store } = await mountPanel(false, () => { closeCalls += 1 })
    const close = host.querySelector<HTMLButtonElement>(
      '[data-testid="presentation-close-document"]',
    )!

    expect(close.disabled).toBe(false)
    await act(async () => close.click())

    expect(closeCalls).toBe(1)
    expect(store.get(currentPresentationWorkspaceAtom).documents).toHaveLength(1)

    await act(async () => root.unmount())
  })

  it('collapses the filmstrip and exposes Office-style text formatting controls', async () => {
    const { host, root, store } = await mountPanel()
    const filmstrip = host.querySelector<HTMLElement>('aside')!

    expect(filmstrip.getAttribute('aria-hidden')).toBe('false')
    expect(host.querySelector('[data-testid="presentation-toggle-filmstrip"]')).toBeNull()
    const view = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-view"]')!
    await act(async () => view.click())
    const collapse = host.querySelector<HTMLButtonElement>('[data-testid="presentation-toggle-filmstrip"]')!
    await act(async () => collapse.click())
    expect(filmstrip.getAttribute('aria-hidden')).toBe('true')
    expect(filmstrip.className).toContain('w-0')
    expect(collapse.getAttribute('aria-pressed')).toBe('false')

    const home = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-home"]')!
    await act(async () => home.click())
    const insertMenu = host.querySelector<HTMLButtonElement>('[data-testid="presentation-compact-insert"]')!
    await act(async () => insertMenu.click())
    const addText = document.querySelector<HTMLButtonElement>('[data-testid="presentation-add-text"]')!
    await act(async () => addText.click())

    const fontMenu = host.querySelector<HTMLButtonElement>('[data-testid="presentation-compact-font"]')!
    await act(async () => fontMenu.click())
    const bold = document.querySelector<HTMLButtonElement>('[data-testid="presentation-bold"]')!
    const italic = document.querySelector<HTMLButtonElement>('[data-testid="presentation-italic"]')!
    const underline = document.querySelector<HTMLButtonElement>('[data-testid="presentation-underline"]')!
    const strikethrough = document.querySelector<HTMLButtonElement>('[data-testid="presentation-strikethrough"]')!
    expect(bold).not.toBeNull()
    expect(document.querySelector('[data-testid="presentation-font-family"]')).not.toBeNull()
    expect(document.querySelector('[data-testid="presentation-font-size"]')).not.toBeNull()

    await act(async () => {
      bold.click()
      italic.click()
      underline.click()
      strikethrough.click()
    })

    const paragraphMenu = host.querySelector<HTMLButtonElement>('[data-testid="presentation-compact-paragraph"]')!
    await act(async () => paragraphMenu.click())
    const alignCenter = document.querySelector<HTMLButtonElement>('[data-testid="presentation-align-center"]')!
    const bullets = document.querySelector<HTMLButtonElement>('[data-testid="presentation-bullets"]')!
    const verticalAlign = document.querySelector<HTMLButtonElement>('[data-testid="presentation-vertical-align"]')!
    await act(async () => {
      alignCenter.click()
      bullets.click()
      verticalAlign.click()
    })

    const presentation = store.get(currentPresentationDocumentAtom)
    const slide = presentation.slides.find((item) => item.id === presentation.selectedSlideId)!
    const element = slide.elements.at(-1)
    expect(element?.type).toBe('text')
    if (element?.type === 'text') {
      expect(element.fontWeight).toBe(700)
      expect(element.italic).toBe(true)
      expect(element.underline).toBe(true)
      expect(element.strikethrough).toBe(true)
      expect(element.align).toBe('center')
      expect(element.listStyle).toBe('bullet')
      expect(element.verticalAlign).toBe('middle')
    }

    await act(async () => root.unmount())
  })

  it('adds, resolves, and deletes review comments', async () => {
    const { host, root, store } = await mountPanel()
    const review = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-review"]')!
    await act(async () => review.click())
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-toggle-comments"]')!.click())

    const textarea = host.querySelector<HTMLTextAreaElement>('[data-testid="presentation-comment-input"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(textarea, 'Tighten this claim')
      Simulate.change(textarea)
    })
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-add-comment"]')!.click())

    let slide = store.get(currentPresentationDocumentAtom).slides[0]!
    expect(slide.comments?.[0]?.text).toBe('Tighten this claim')
    const comment = host.querySelector<HTMLElement>('[data-presentation-comment-id]')!
    const actions = comment.querySelectorAll<HTMLButtonElement>('button')
    await act(async () => actions[0]!.click())
    slide = store.get(currentPresentationDocumentAtom).slides[0]!
    expect(slide.comments?.[0]?.resolved).toBe(true)
    await act(async () => actions[1]!.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.comments).toEqual([])

    await act(async () => root.unmount())
  })

  it('offers a complete ribbon and stores notes, transitions, and animation choices', async () => {
    const { host, root, store } = await mountPanel()
    installTransitionAnimationMock()

    expect(host.querySelectorAll('[data-testid^="presentation-tab-"]')).toHaveLength(9)
    expect(host.querySelector('[data-testid="presentation-tab-home"]')?.getAttribute('aria-selected')).toBe('true')
    expect(host.querySelector('[data-testid="presentation-tab-shape"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="presentation-tab-review"]')).not.toBeNull()
    expect(host.querySelector('input[aria-label="文稿标题"]')).toBeNull()
    const toolbarActions = host.querySelector<HTMLElement>('[data-testid="presentation-toolbar-actions"]')!
    expect(toolbarActions.querySelector('button[aria-label="保存"]')).toBeNull()
    expect(toolbarActions.querySelector('button[aria-label="上传"]')).toBeNull()
    expect(toolbarActions.querySelector('button[aria-label="分享"]')).toBeNull()
    expect(toolbarActions.querySelector('button[aria-label="在文件管理器打开"]')).not.toBeNull()
    expect(toolbarActions.querySelector('[data-testid="presentation-toggle-expanded"]')).toBeNull()

    const insert = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-insert"]')!
    await act(async () => insert.click())
    const insertActions = ['空白页面', '文本框', '形状', '图片', '音频', '视频', '表格', '链接', '图表', '页脚']
    const actionLabels = Array.from(host.querySelectorAll<HTMLButtonElement>('button')).map((button) => button.getAttribute('aria-label'))
    expect(insertActions.filter((label) => !actionLabels.includes(label))).toEqual([])

    const notes = host.querySelector<HTMLTextAreaElement>('[data-testid="presentation-notes"]')!
    await act(async () => {
      const view = notes.ownerDocument.defaultView!
      Object.getOwnPropertyDescriptor(view.HTMLTextAreaElement.prototype, 'value')?.set
        ?.call(notes, 'Remember the customer story.')
      notes.dispatchEvent(new view.Event('input', { bubbles: true }))
    })
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.notes).toBe('Remember the customer story.')

    const transitions = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-transitions"]')!
    await act(async () => transitions.click())
    for (const effect of ['none', 'fade', 'push', 'wipe']) {
      expect(host.querySelector(`[data-testid="presentation-transition-${effect}"]`)).not.toBeNull()
    }
    for (const effect of ['reveal', 'cover', 'zoom', 'flip', 'cube']) {
      expect(host.querySelector(`[data-testid="presentation-transition-${effect}"]`)).toBeNull()
    }
    expect(host.querySelector('[data-testid="presentation-transition-cut"]')).toBeNull()

    const noTransition = host.querySelector<HTMLButtonElement>('[data-testid="presentation-transition-none"]')!
    await act(async () => noTransition.click())
    expect(host.querySelector('[data-testid="presentation-transition-player"]')).toBeNull()

    const fadeTransition = host.querySelector<HTMLButtonElement>('[data-testid="presentation-transition-fade"]')!
    const animationCountBeforeSelection = transitionAnimationCalls.length
    await act(async () => fadeTransition.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition).toEqual({
      effect: 'fade',
      durationMs: 1_000,
    })
    expect(transitionAnimationCalls.length).toBeGreaterThan(animationCountBeforeSelection)
    expect(host.querySelector('[data-testid="presentation-transition-player"]')).not.toBeNull()

    const duration = host.querySelector<HTMLInputElement>('input[aria-label="持续时间"]')!
    expect(duration.value).toBe('1')
    await act(async () => {
      duration.focus()
      const view = duration.ownerDocument.defaultView!
      Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set?.call(duration, '')
      Simulate.change(duration)
    })
    expect(duration.value).toBe('')
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition?.durationMs).toBe(1_000)
    await act(async () => {
      Simulate.blur(duration)
      duration.blur()
    })
    expect(duration.value).toBe('1')

    await act(async () => {
      duration.focus()
      const view = duration.ownerDocument.defaultView!
      Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set?.call(duration, '')
      Simulate.change(duration)
      store.set(currentPresentationDocumentAtom, (current) => ({
        ...current,
        slides: current.slides.map((slide) => slide.id === current.selectedSlideId
          ? { ...slide, transition: { ...slide.transition, durationMs: 1_800 } }
          : slide),
      }))
    })
    expect(duration.value).toBe('')
    await act(async () => {
      Simulate.keyDown(duration, { key: 'Enter' })
      Simulate.blur(duration)
    })
    expect(duration.ownerDocument.activeElement).not.toBe(duration)
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition?.durationMs).toBe(1_800)
    expect(duration.value).toBe('1.8')

    await act(async () => {
      duration.focus()
      const view = duration.ownerDocument.defaultView!
      Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set?.call(duration, '0.01')
      Simulate.change(duration)
    })
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition?.durationMs).toBe(100)
    await act(async () => {
      Simulate.blur(duration)
      duration.blur()
    })
    expect(duration.value).toBe('0.1')

    await act(async () => {
      duration.focus()
      const view = duration.ownerDocument.defaultView!
      Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set?.call(duration, '30')
      Simulate.change(duration)
    })
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition?.durationMs).toBe(20_000)
    await act(async () => {
      Simulate.blur(duration)
      duration.blur()
    })
    expect(duration.value).toBe('20')

    await act(async () => {
      duration.focus()
      const view = duration.ownerDocument.defaultView!
      Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set?.call(duration, '1.2')
      Simulate.change(duration)
    })
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition?.durationMs).toBe(1_200)
    await act(async () => {
      Simulate.blur(duration)
      duration.blur()
    })
    expect(duration.value).toBe('1.2')

    const options = host.querySelector<HTMLButtonElement>('[data-testid="presentation-transition-options"]')!
    await act(async () => options.click())
    const throughBlack = document.querySelector<HTMLButtonElement>('[data-testid="presentation-transition-through-black"]')!
    await act(async () => throughBlack.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition?.throughBlack).toBe(true)

    const applyToAll = host.querySelector<HTMLButtonElement>('[data-testid="presentation-transition-apply-all"]')!
    await act(async () => applyToAll.click())
    expect(store.get(currentPresentationDocumentAtom).slides.every((slide) => (
      slide.transition?.effect === 'fade'
      && slide.transition.durationMs === 1_200
      && slide.transition.throughBlack === true
    ))).toBe(true)

    const gallery = host.querySelector<HTMLButtonElement>('[data-testid="presentation-transition-gallery"]')!
    await act(async () => gallery.click())
    expect(document.querySelector('[data-testid="presentation-transition-gallery-fade"]')).toBeNull()
    expect(document.querySelector('[data-testid="presentation-transition-gallery-reveal"]')).not.toBeNull()
    const cube = document.querySelector<HTMLButtonElement>('[data-testid="presentation-transition-gallery-cube"]')!
    await act(async () => cube.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition).toEqual({
      effect: 'cube',
      durationMs: 1_200,
      direction: 'left',
    })
    expect(gallery.getAttribute('aria-pressed')).toBe('true')

    const preview = host.querySelector<HTMLButtonElement>('[data-testid="presentation-preview-transition"]')!
    const animationCountBeforePreview = transitionAnimationCalls.length
    await act(async () => preview.click())
    expect(transitionAnimationCalls.length).toBeGreaterThan(animationCountBeforePreview)

    await act(async () => options.click())
    const fromTop = document.querySelector<HTMLButtonElement>('[data-testid="presentation-transition-direction-up"]')!
    await act(async () => fromTop.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition?.direction).toBe('up')

    const home = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-home"]')!
    await act(async () => home.click())
    const insertMenu = host.querySelector<HTMLButtonElement>('[data-testid="presentation-compact-insert"]')!
    await act(async () => insertMenu.click())
    const addText = document.querySelector<HTMLButtonElement>('[data-testid="presentation-add-text"]')!
    await act(async () => addText.click())
    const animations = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-animations"]')!
    await act(async () => animations.click())
    const fadeAnimation = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-fade"]')!
    await act(async () => fadeAnimation.click())

    const presentation = store.get(currentPresentationDocumentAtom)
    const selectedSlide = presentation.slides.find((slide) => slide.id === presentation.selectedSlideId)!
    expect(selectedSlide.elements.at(-1)?.animation).toBe('fade')
    expect(host.querySelector('[data-testid="presentation-animation-player"]')).not.toBeNull()
    expect(host.querySelector('[data-animation-part$="-fade"]')).not.toBeNull()

    const checkerboard = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-checkerboard"]')!
    const dissolve = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-dissolve"]')!
    expect(checkerboard.disabled).toBe(false)
    expect(dissolve.disabled).toBe(false)
    await act(async () => checkerboard.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.elements.at(-1)?.animation).toBe('checkerboard')
    expect(host.querySelectorAll('[data-animation-part*="-checker-"]')).toHaveLength(48)

    const textColor = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-textColor"]')!
    await act(async () => textColor.click())
    const purpleTextAnimation = document.querySelector<HTMLButtonElement>('button[aria-label="文字颜色 #8B7CFF"]')!
    await act(async () => purpleTextAnimation.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.elements.at(-1)).toMatchObject({
      animation: 'textColor',
      animationColor: '#8B7CFF',
    })

    const start = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-start"]')!
    await act(async () => start.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-option-withPrevious"]')!.click())
    const delay = host.querySelector<HTMLInputElement>('input[aria-label="延迟"]')!
    await act(async () => {
      const view = delay.ownerDocument.defaultView!
      Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set?.call(delay, '1.3')
      Simulate.change(delay)
    })
    const trigger = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-trigger"]')!
    await act(async () => trigger.click())
    await act(async () => document.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-option-elementClick"]')!.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.elements.at(-1)).toMatchObject({
      animationDelay: 1_300,
      animationStart: 'withPrevious',
      animationTrigger: 'elementClick',
    })

    const applyAnimationToAll = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-apply-all"]')!
    await act(async () => applyAnimationToAll.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.elements.every((element) => (
      element.animation === 'textColor'
      && element.animationDelay === 1_300
      && element.animationStart === 'withPrevious'
      && element.animationTrigger === 'elementClick'
    ))).toBe(true)

    const animationPane = host.querySelector<HTMLButtonElement>('button[aria-label="动画窗格"]')!
    await act(async () => animationPane.click())
    expect(host.querySelector('[data-testid="presentation-animation-pane-list"]')).not.toBeNull()
    const animationPainter = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-painter"]')!
    await act(async () => animationPainter.click())
    expect(animationPainter.getAttribute('aria-pressed')).toBe('true')
    const firstAnimationTarget = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-pane-list"] button')!
    await act(async () => {
      firstAnimationTarget.click()
      await Promise.resolve()
    })
    expect(animationPainter.getAttribute('aria-pressed')).toBe('false')
    const hideMarkers = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-hide-markers"]')!
    expect(host.querySelector('[data-testid="presentation-animation-markers"]')).not.toBeNull()
    await act(async () => hideMarkers.click())
    expect(hideMarkers.getAttribute('aria-pressed')).toBe('true')
    expect(host.querySelector('[data-testid="presentation-animation-markers"]')).toBeNull()

    await act(async () => root.unmount())
  })

  it('applies and previews one animation for an entire grouped card', async () => {
    const { host, root, store } = await mountPanel()
    const initial = store.get(currentPresentationDocumentAtom)
    const overview = initial.slides[1]!
    const cardGroupId = overview.elements.find((element) => element.groupId)?.groupId
    if (!cardGroupId) throw new Error('Expected a grouped test card')
    const cardElements = overview.elements.filter((element) => element.groupId === cardGroupId)

    await act(async () => {
      store.set(currentPresentationDocumentAtom, {
        ...initial,
        selectedSlideId: overview.id,
        slides: initial.slides.map((slide) => slide.id === overview.id
          ? { ...slide, elements: cardElements }
          : slide),
      })
      await Promise.resolve()
    })

    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-animations"]')!.click())
    expect(host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-fillColor"]')?.disabled).toBe(false)
    expect(host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-textColor"]')?.disabled).toBe(false)
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-fade"]')!.click())

    const current = store.get(currentPresentationDocumentAtom)
    const currentSlide = current.slides.find((slide) => slide.id === overview.id)!
    expect(currentSlide.elements[0]?.animation).toBe('fade')
    expect(currentSlide.elements.slice(1).every((element) => element.animation === undefined)).toBe(true)
    expect(host.querySelectorAll('[data-animation-part]')).toHaveLength(1)
    expect(host.querySelectorAll('[data-animation-element-id]')).toHaveLength(4)
    expect(host.querySelector('[data-testid="presentation-animation-markers"]')?.childElementCount).toBe(1)

    await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="动画窗格"]')!.click())
    expect(host.querySelectorAll('[data-testid="presentation-animation-pane-list"] button')).toHaveLength(1)

    await act(async () => root.unmount())
  })

  it('advances slide-click animations before moving to the next slide in slideshow mode', async () => {
    const { host, root, store } = await mountPanel()
    const current = store.get(currentPresentationDocumentAtom)
    const firstSlide = current.slides[0]!
    const animatedElement = firstSlide.elements.find((element) => element.type === 'text')!
    await act(async () => {
      store.set(currentPresentationDocumentAtom, {
        ...current,
        slides: current.slides.map((slide) => slide.id === firstSlide.id
          ? {
              ...slide,
              elements: slide.elements.map((element) => element.id === animatedElement.id
                ? { ...element, animation: 'fade' as const }
                : element),
            }
          : slide),
      })
      await Promise.resolve()
    })

    const start = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('session.presentation.playFromCurrent')}"]`)!
    await act(async () => start.click())
    const slideshow = host.querySelector<HTMLElement>('[data-testid="presentation-slideshow"]')!
    const next = slideshow.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('session.presentation.nextSlide')}"]`)!
    expect(slideshow.textContent).toContain('1 / 2')

    await act(async () => next.click())
    expect(slideshow.querySelector('[data-testid="presentation-animation-player"]')).not.toBeNull()
    expect(slideshow.textContent).toContain('1 / 2')

    await act(async () => root.unmount())
  })

  it('uses an immersive responsive slideshow stage with one accessible control dock', async () => {
    const { host, root } = await mountPanel()
    await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-slideshow"]')!.click())
    const start = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('session.presentation.playFromCurrent')}"]`)!
    await act(async () => {
      start.click()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    const slideshow = host.querySelector<HTMLElement>('[data-testid="presentation-slideshow"]')!
    const frame = slideshow.querySelector<HTMLElement>('[data-testid="presentation-slideshow-frame"]')!
    const progress = slideshow.querySelector<HTMLElement>('[data-testid="presentation-slideshow-progress"]')!

    expect(slideshow.className).toContain('fixed')
    expect(slideshow.className).toContain('app-no-drag')
    expect(slideshow.getAttribute('role')).toBe('dialog')
    expect(Number.parseFloat(frame.style.width)).toBeGreaterThan(300)
    expect(slideshow.querySelectorAll('[data-testid="presentation-slideshow-controls"]')).toHaveLength(1)
    expect(progress.getAttribute('aria-valuenow')).toBe('1')
    expect(progress.getAttribute('aria-valuemax')).toBe('2')
    expect(slideshow.textContent?.match(/1 \/ 2/g)).toHaveLength(1)
    const close = slideshow.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('session.presentation.closeSlideshow')}"]`)!
    expect(close.textContent).toContain('Esc')

    await act(async () => close.click())
    expect(host.querySelector('[data-testid="presentation-slideshow"]')).toBeNull()

    await act(async () => root.unmount())
  })

  it('runs an element-click animation from its target area in slideshow mode', async () => {
    const { host, root, store } = await mountPanel()
    const current = store.get(currentPresentationDocumentAtom)
    const firstSlide = current.slides[0]!
    const animatedElement = firstSlide.elements.find((element) => element.type === 'text')!
    await act(async () => {
      store.set(currentPresentationDocumentAtom, {
        ...current,
        slides: current.slides.map((slide) => slide.id === firstSlide.id
          ? {
              ...slide,
              elements: slide.elements.map((element) => element.id === animatedElement.id
                ? { ...element, animation: 'fade' as const, animationTrigger: 'elementClick' as const }
                : element),
            }
          : slide),
      })
      await Promise.resolve()
    })

    const start = host.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('session.presentation.playFromCurrent')}"]`)!
    await act(async () => start.click())
    const slideshow = host.querySelector<HTMLElement>('[data-testid="presentation-slideshow"]')!
    const trigger = slideshow.querySelector<HTMLButtonElement>(`button[aria-label="${i18n.t('session.presentation.triggerElementClick')}"]`)!

    await act(async () => trigger.click())
    expect(slideshow.querySelector('[data-testid="presentation-animation-player"]')).not.toBeNull()

    await act(async () => root.unmount())
  })

  it('copies and clears formatting through the compact History group', async () => {
    const { host, root, store } = await mountPanel()
    const insertMenu = host.querySelector<HTMLButtonElement>('[data-testid="presentation-compact-insert"]')!
    const addTextThroughMenu = async () => {
      let action = document.querySelector<HTMLButtonElement>('[data-testid="presentation-add-text"]')
      if (!action) {
        await act(async () => host.querySelector<HTMLButtonElement>('[data-testid="presentation-compact-insert"]')!.click())
        action = document.querySelector<HTMLButtonElement>('[data-testid="presentation-add-text"]')
      }
      if (!action) throw new Error('Expected the compact Insert menu to expose Add text')
      await act(async () => action.click())
    }
    await act(async () => insertMenu.click())
    await addTextThroughMenu()

    const fontMenu = host.querySelector<HTMLButtonElement>('[data-testid="presentation-compact-font"]')!
    await act(async () => fontMenu.click())
    const bold = document.querySelector<HTMLButtonElement>('[data-testid="presentation-bold"]')!
    await act(async () => bold.click())

    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (!host.querySelector<HTMLButtonElement>('[data-testid="presentation-format-painter"]')?.disabled) break
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    }
    if (host.querySelector<HTMLButtonElement>('[data-testid="presentation-format-painter"]')?.disabled) {
      await addTextThroughMenu()
    }
    const formatPainter = host.querySelector<HTMLButtonElement>('[data-testid="presentation-format-painter"]')!
    expect(formatPainter.disabled).toBe(false)
    await act(async () => formatPainter.click())
    expect(host.querySelector<HTMLButtonElement>('[data-testid="presentation-format-painter"]')?.getAttribute('aria-pressed')).toBe('true')
    await addTextThroughMenu()

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = store.get(currentPresentationDocumentAtom)
      const selectedSlide = current.slides.find((item) => item.id === current.selectedSlideId)!
      const target = selectedSlide.elements.at(-1)
      if (target?.type === 'text' && target.fontWeight === 700) break
      await act(async () => new Promise((resolve) => setTimeout(resolve, 10)))
    }

    let presentation = store.get(currentPresentationDocumentAtom)
    let slide = presentation.slides.find((item) => item.id === presentation.selectedSlideId)!
    const painted = slide.elements.at(-1)
    expect(painted?.type).toBe('text')
    if (painted?.type === 'text') expect(painted.fontWeight).toBe(700)

    const clearFormat = host.querySelector<HTMLButtonElement>('[data-testid="presentation-clear-format"]')!
    await act(async () => clearFormat.click())
    presentation = store.get(currentPresentationDocumentAtom)
    slide = presentation.slides.find((item) => item.id === presentation.selectedSlideId)!
    const cleared = slide.elements.at(-1)
    expect(cleared?.type).toBe('text')
    if (cleared?.type === 'text') {
      expect(cleared.fontWeight).toBe(400)
      expect(cleared.fontFamily).toBe('Aptos')
      expect(cleared.listStyle).toBe('none')
    }

    await act(async () => root.unmount())
  })

  it('opens multiple presentation tabs and keeps the filmstrip controls at the bottom', async () => {
    const { host, root, store } = await mountPanel()

    expect(host.querySelectorAll('[data-testid="presentation-document-tab"]')).toHaveLength(1)
    const aside = host.querySelector<HTMLElement>('aside')!
    const filmstripFooter = host.querySelector<HTMLElement>('[data-testid="presentation-filmstrip-footer"]')!
    expect(aside.className).toContain('h-full')
    expect(filmstripFooter.className).toContain('mt-auto')

    const addDocument = host.querySelector<HTMLButtonElement>('[data-testid="presentation-add-document"]')!
    const documentTabs = host.querySelector<HTMLElement>('[data-testid="presentation-document-tabs"]')!
    const expandPanel = host.querySelector<HTMLButtonElement>('[data-testid="presentation-toggle-expanded"]')!
    const closePanel = host.querySelector<HTMLButtonElement>('[data-testid="presentation-close-panel"]')!
    const documentHeader = documentTabs.parentElement!
    expect(documentHeader.contains(addDocument)).toBe(true)
    expect(documentHeader.contains(expandPanel)).toBe(true)
    expect(documentHeader.contains(closePanel)).toBe(true)
    await act(async () => addDocument.click())

    expect(host.querySelectorAll('[data-testid="presentation-document-tab"]')).toHaveLength(2)
    const workspace = store.get(currentPresentationWorkspaceAtom)
    expect(workspace.documents).toHaveLength(2)
    expect(store.get(currentPresentationDocumentAtom).id).toBe(workspace.activeDocumentId)

    const tabs = host.querySelectorAll<HTMLButtonElement>('[data-testid="presentation-document-tab"]')
    await act(async () => tabs[0]?.click())
    expect(store.get(currentPresentationWorkspaceAtom).activeDocumentId).toBe(workspace.documents[0]!.id)

    const closeButtons = host.querySelectorAll<HTMLButtonElement>('[data-testid="presentation-close-document"]')
    await act(async () => closeButtons[1]?.click())
    expect(store.get(currentPresentationWorkspaceAtom).documents).toHaveLength(1)

    await act(async () => root.unmount())
  })

  it('inserts a real shape from the categorized shape gallery', async () => {
    const { host, root, store } = await mountPanel()
    const insert = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-insert"]')!
    await act(async () => insert.click())
    const picker = host.querySelector<HTMLButtonElement>('[data-testid="presentation-shape-picker"]')!
    await act(async () => picker.click())

    const gallery = document.querySelector<HTMLElement>('[data-testid="presentation-shape-gallery"]')!
    expect(gallery).not.toBeNull()
    expect(gallery.querySelectorAll<HTMLButtonElement>('[data-testid^="presentation-shape-"]').length).toBeGreaterThan(75)
    expect(gallery.querySelector('section[aria-label="基本形状"]')).not.toBeNull()
    expect(gallery.querySelector('section[aria-label="箭头总汇"]')).not.toBeNull()
    expect(gallery.querySelector('section[aria-label="流程图"]')).not.toBeNull()

    const heart = gallery.querySelector<HTMLButtonElement>('[data-testid="presentation-shape-heart"]')!
    expect(heart.hasAttribute('title')).toBe(false)
    await act(async () => {
      heart.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      await new Promise((resolve) => setTimeout(resolve, 10))
    })
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe('心形')
    await act(async () => heart.click())
    const presentation = store.get(currentPresentationDocumentAtom)
    const slide = presentation.slides.find((item) => item.id === presentation.selectedSlideId)!
    const inserted = slide.elements.at(-1)
    expect(inserted?.type).toBe('heart')
    if (inserted?.type === 'heart') {
      expect(inserted.width).toBeGreaterThan(0)
      expect(inserted.height).toBeGreaterThan(0)
      expect(inserted.fill).toBe('#8B7CFF')
    }

    await act(async () => root.unmount())
  })
})
