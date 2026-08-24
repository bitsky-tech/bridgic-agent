/**
 * ImageLightbox — the one overlay that cannot inherit the native-surface
 * blocker from `ModalBackdrop`.
 *
 * Every other dialog in the app goes through `ModalBackdrop`, which registers
 * the blocker for it. This one is a third-party viewer (YARL) that portals
 * itself, so the blocker is wired by hand — and hand-wiring is exactly what a
 * later refactor deletes without noticing. Until recently the protection came
 * from an atom whitelist inside `useEmbeddedBrowserSurfaceEligible`; that
 * whitelist is gone, so this test is the only thing standing between a viewed
 * image and the browser's WebContentsView painting straight over it.
 */
import { afterAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

// YARL owns a portal, a stylesheet and three plugin entry points — none of
// which this test is about. Stub the whole package down to "did it open?".
mock.module('yet-another-react-lightbox', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid="yarl" /> : null),
}))
mock.module('yet-another-react-lightbox/plugins/zoom', () => ({ default: {} }))
mock.module('yet-another-react-lightbox/plugins/download', () => ({ default: {} }))
mock.module('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: {} }))
mock.module('yet-another-react-lightbox/styles.css', () => ({}))

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { createStore, Provider } = await import('jotai')
const { browserSurfaceBlockedAtom } = await import('@/atoms/browser')
const { openImageAtom, closeImageAtom } = await import('@/atoms/lightbox')
const { ImageLightbox } = await import('../ImageLightbox')

beforeEach(() => {
  ;(globalThis as unknown as { window: Record<string, unknown> }).window.api = {
    window: { setTrafficLightsVisible: async () => {} },
  }
})

describe('ImageLightbox', () => {
  it('hides the native Browser surface while an image is open', async () => {
    const store = createStore()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(<Provider store={store}><ImageLightbox /></Provider>)
    })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)

    await act(async () => {
      store.set(openImageAtom, { src: 'file:///tmp/a.png' })
    })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(true)

    await act(async () => { store.set(closeImageAtom) })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)

    await act(async () => root.unmount())
    host.remove()
  })
})
