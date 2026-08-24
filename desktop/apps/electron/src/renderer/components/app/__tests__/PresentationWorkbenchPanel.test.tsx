import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { currentPresentationDocumentAtom, currentPresentationWorkspaceAtom } = await import('@/atoms/presentation')
const { activeSessionIdAtom } = await import('@/atoms/sessions')
const { settingsAtom } = await import('@/atoms/settings')
const { i18n } = await import('@/lib/i18n')
const { PresentationWorkbenchPanel } = await import('../PresentationWorkbenchPanel')

beforeEach(async () => {
  await i18n.changeLanguage('zh')
})

afterEach(() => {
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function mountPanel() {
  const store = createStore()
  const settings = store.get(settingsAtom)
  store.set(settingsAtom, { ...settings, ui: { ...settings.ui, lastNav: 'home' } })
  store.set(activeSessionIdAtom, 'presentation-session')
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => {
    root.render(
      <Provider store={store}>
        <PresentationWorkbenchPanel active={false} />
      </Provider>,
    )
    await Promise.resolve()
  })
  return { host, root, store }
}

describe('PresentationWorkbenchPanel', () => {
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
    const addText = host.querySelector<HTMLButtonElement>('[data-testid="presentation-add-text"]')!
    await act(async () => addText.click())

    const bold = host.querySelector<HTMLButtonElement>('[data-testid="presentation-bold"]')!
    const italic = host.querySelector<HTMLButtonElement>('[data-testid="presentation-italic"]')!
    const underline = host.querySelector<HTMLButtonElement>('[data-testid="presentation-underline"]')!
    const alignCenter = host.querySelector<HTMLButtonElement>('[data-testid="presentation-align-center"]')!
    expect(bold).not.toBeNull()
    expect(host.querySelector('[data-testid="presentation-font-family"]')).not.toBeNull()
    expect(host.querySelector('[data-testid="presentation-font-size"]')).not.toBeNull()

    await act(async () => {
      bold.click()
      italic.click()
      underline.click()
      alignCenter.click()
    })

    const document = store.get(currentPresentationDocumentAtom)
    const slide = document.slides.find((item) => item.id === document.selectedSlideId)!
    const element = slide.elements.at(-1)
    expect(element?.type).toBe('text')
    if (element?.type === 'text') {
      expect(element.fontWeight).toBe(700)
      expect(element.italic).toBe(true)
      expect(element.underline).toBe(true)
      expect(element.align).toBe('center')
    }

    await act(async () => root.unmount())
  })

  it('offers a complete ribbon and stores notes, transitions, and animation choices', async () => {
    const { host, root, store } = await mountPanel()

    expect(host.querySelectorAll('[data-testid^="presentation-tab-"]')).toHaveLength(8)
    expect(host.querySelector('[data-testid="presentation-tab-home"]')?.getAttribute('aria-selected')).toBe('true')

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
    const fadeTransition = host.querySelector<HTMLButtonElement>('[data-testid="presentation-transition-fade"]')!
    await act(async () => fadeTransition.click())
    expect(store.get(currentPresentationDocumentAtom).slides[0]?.transition).toBe('fade')

    const home = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-home"]')!
    await act(async () => home.click())
    const addText = host.querySelector<HTMLButtonElement>('[data-testid="presentation-add-text"]')!
    await act(async () => addText.click())
    const animations = host.querySelector<HTMLButtonElement>('[data-testid="presentation-tab-animations"]')!
    await act(async () => animations.click())
    const fadeAnimation = host.querySelector<HTMLButtonElement>('[data-testid="presentation-animation-fade"]')!
    await act(async () => fadeAnimation.click())

    const document = store.get(currentPresentationDocumentAtom)
    const selectedSlide = document.slides.find((slide) => slide.id === document.selectedSlideId)!
    expect(selectedSlide.elements.at(-1)?.animation).toBe('fade')

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
})
