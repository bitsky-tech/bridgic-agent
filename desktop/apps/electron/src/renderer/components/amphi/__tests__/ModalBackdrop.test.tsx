/**
 * Five ModalBackdrop invariants whose failures are visually subtle and easy to miss.
 *
 * Background: backdrop logic was duplicated across Modal, SettingsModal, and RunLogDrawer.
 * A Windows caption fix missed SettingsModal because it used `absolute` rather than `fixed`,
 * and users discovered it in practice. After consolidation, these tests lock down behavior.
 *
 * Closing from an empty backdrop click depends on `pointer-events-none` on the visual layer.
 * Without it, the visual layer becomes the target, `e.target === e.currentTarget` fails, and
 * the modal cannot close even though the backdrop looks identical.
 *
 * Likewise, requiring both press and release on the backdrop matters only when dragging from
 * the panel outward, which is the standard gesture for resizing a drawer. Click-only logic hides the bug.
 */
import { afterAll, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { getDefaultStore } = await import('jotai')
const { browserSurfaceBlockedAtom } = await import('@/atoms/browser')
const { ModalBackdrop } = await import('../ModalBackdrop')

/** Mount in an **independent** container to prove the backdrop portals to body. */
async function mount(ui: React.ReactElement): Promise<{ host: HTMLDivElement; cleanup: () => Promise<void> }> {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(ui) })
  return {
    host,
    cleanup: async () => {
      await act(async () => { root.unmount() })
      host.remove()
    },
  }
}

const backdropOf = (): HTMLElement => {
  const el = document.querySelector('[data-testid="bd"]')
  if (!el) throw new Error('backdrop not rendered')
  return el as HTMLElement
}

const cardOf = (): HTMLElement => document.querySelector('[data-testid="card"]') as HTMLElement

/** Perform a real mouse gesture from press to release, optionally across different elements. */
async function press(from: HTMLElement, to: HTMLElement = from, button = 0): Promise<void> {
  await act(async () => {
    from.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button }))
    to.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button }))
  })
}

describe('ModalBackdrop', () => {
  it('portals out of the mount container into body', async () => {
    const { host, cleanup } = await mount(
      <ModalBackdrop data-testid="bd"><span data-testid="card">x</span></ModalBackdrop>,
    )
    // If left in place, opening under a positioned ancestor such as the composer can make the
    // backdrop appear absent, the original SettingsModal failure.
    expect(host.querySelector('[data-testid="bd"]')).toBeNull()
    expect(backdropOf().parentElement).toBe(document.body)
    await cleanup()
  })

  it('closes when the dim area itself is clicked', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    await press(backdropOf())
    expect(closed).toBe(1)
    await cleanup()
  })

  it('does NOT close when the content is clicked', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    await press(cardOf())
    expect(closed).toBe(0)
    await cleanup()
  })

  it('does NOT close when a drag starts inside the content and ends on the dim area', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    // Resizing from a drawer edge or dragging a text selection beyond a modal uses this gesture.
    // Native click targets the nearest common ancestor of press and release, the backdrop container,
    // so click-only logic misclassifies the drag as an empty-backdrop click and closes the drawer.
    await press(cardOf(), backdropOf())
    expect(closed).toBe(0)
    await cleanup()
  })

  it('does NOT close when a drag starts on the dim area and ends inside the content', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    await press(backdropOf(), cardOf())
    expect(closed).toBe(0)
    await cleanup()
  })

  it('does NOT close on a non-primary button press', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    // Click-only logic naturally ignores the context button via auxclick. With mousedown/mouseup,
    // filter it explicitly or a misplaced context click on the backdrop closes the modal.
    await press(backdropOf(), backdropOf(), 2)
    await press(backdropOf(), backdropOf(), 1)
    expect(closed).toBe(0)
    await press(backdropOf())
    expect(closed).toBe(1)
    await cleanup()
  })

  it('does not leak the press origin into the next gesture', async () => {
    let closed = 0
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd" onClose={() => { closed += 1 }}>
        <span data-testid="card">x</span>
      </ModalBackdrop>,
    )
    // If a gesture started on the backdrop without closing, reset the marker so the next release
    // from content onto the backdrop cannot inherit the previous start.
    await press(backdropOf(), cardOf())
    await press(cardOf(), backdropOf())
    expect(closed).toBe(0)
    await cleanup()
  })

  it('keeps the dim layer click-through and below the content', async () => {
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd"><span>x</span></ModalBackdrop>,
    )
    const dim = backdropOf().querySelector('div')
    expect(dim).not.toBeNull()
    const cls = dim!.className
    // pointer-events-none keeps the visual layer from becoming the target and breaking empty-click detection.
    expect(cls).toContain('pointer-events-none')
    // -z-10 places it below content. A negative z avoids adding relative to content, which would
    // change the containing block for absolute descendants.
    expect(cls).toContain('-z-10')
    await cleanup()
  })

  it('starts the whole overlay — container, not just the dim layer — below the Windows caption strip', async () => {
    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd"><span>x</span></ModalBackdrop>,
    )
    // The system composites caption buttons above WebContents, beyond z-index. Reserve space on
    // the **container**, not only the dim layer, or full-height content can still place controls
    // underneath the caption buttons. The variable is always zero outside win32.
    expect(backdropOf().className).toContain('top-[var(--titlebar-win-inset-top)]')
    // Once the container reserves space, the dim layer should fill it without a second top offset.
    expect(backdropOf().querySelector('div')!.className).toContain('inset-0')
    await cleanup()
  })

  // The embedded Browser is an Electron WebContentsView composited ABOVE this
  // page, so no z-index puts a dialog in front of it: the native view has to
  // hide first. Owning that here is what makes every ModalBackdrop consumer
  // immune by construction — the same reasoning as the backdrop itself (a
  // dialog that does not wrap this component has no backdrop at all, so
  // forgetting is impossible).
  it('hides the native Browser surface for as long as it is mounted', async () => {
    const store = getDefaultStore()
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)

    const { cleanup } = await mount(
      <ModalBackdrop data-testid="bd"><span data-testid="card">x</span></ModalBackdrop>,
    )
    expect(store.get(browserSurfaceBlockedAtom)).toBe(true)

    await cleanup()
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)
  })

  it('gives every overlay its own blocker, so closing the top dialog does not uncover the browser under the one below', async () => {
    const store = getDefaultStore()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const Stack = ({ second }: { second: boolean }) => (
      <>
        <ModalBackdrop data-testid="bd"><span>x</span></ModalBackdrop>
        {second ? <ModalBackdrop data-testid="bd2"><span>y</span></ModalBackdrop> : null}
      </>
    )

    await act(async () => { root.render(<Stack second />) })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(true)

    // A shared blocker key would release here and let the native view paint
    // over the dialog that is still open (settings → confirm → dismiss).
    await act(async () => { root.render(<Stack second={false} />) })
    expect(store.get(browserSurfaceBlockedAtom)).toBe(true)

    await act(async () => { root.unmount() })
    host.remove()
    expect(store.get(browserSurfaceBlockedAtom)).toBe(false)
  })
})
