import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PresentationTransition } from '@/atoms/presentation'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const {
  PresentationTransitionPlayer,
  createPresentationTransitionKeyframes,
} = await import('../PresentationTransitionPlayer')

interface MockAnimationCall {
  element: Element
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
  animation: Animation
  finish: () => void
  cancelCount: number
}

let animationCalls: MockAnimationCall[] = []

function transition(overrides: Partial<PresentationTransition> = {}): PresentationTransition {
  return { effect: 'fade', durationMs: 500, ...overrides }
}

beforeEach(() => {
  animationCalls = []
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value(this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
      let resolveFinished: () => void = () => {}
      let rejectFinished: (reason?: unknown) => void = () => {}
      const finished = new Promise<void>((resolve, reject) => {
        resolveFinished = () => resolve()
        rejectFinished = (reason) => reject(reason)
      })
      const call = {} as MockAnimationCall
      const animation = {
        finished,
        cancel() {
          call.cancelCount += 1
          rejectFinished(new Error('cancelled'))
        },
      } as unknown as Animation
      Object.assign(call, {
        element: this,
        keyframes: frames,
        options,
        animation,
        finish: resolveFinished,
        cancelCount: 0,
      })
      animationCalls.push(call)
      return animation
    },
  })
})

afterEach(() => {
  document.body.replaceChildren()
})

afterAll(async () => {
  Reflect.deleteProperty(Element.prototype, 'animate')
  await GlobalRegistrator.unregister()
})

function mountPlayer(props: { transition?: PresentationTransition; runKey?: string | number; onComplete?: () => void } = {}): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  host.style.width = '1280px'
  host.style.height = '720px'
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(
      <PresentationTransitionPlayer
        previous={<div>Previous slide</div>}
        current={<div>Current slide</div>}
        transition={props.transition ?? transition()}
        runKey={props.runKey ?? 1}
        onComplete={props.onComplete}
      />,
    )
  })
  return { host, root }
}

describe('createPresentationTransitionKeyframes', () => {
  it('creates complementary push frames and reverses them for backward navigation', () => {
    const forward = createPresentationTransitionKeyframes(transition({ effect: 'push', direction: 'left', durationMs: 840 }))
    const backward = createPresentationTransitionKeyframes(
      transition({ effect: 'push', direction: 'left', durationMs: 840 }),
      'backward',
    )

    expect(forward.options.duration).toBe(840)
    expect(forward.previous[1]?.transform).toBe('translate3d(100%, 0%, 0)')
    expect(forward.current[0]?.transform).toBe('translate3d(-100%, 0%, 0)')
    expect(backward.previous[1]?.transform).toBe('translate3d(-100%, 0%, 0)')
    expect(backward.current[0]?.transform).toBe('translate3d(100%, 0%, 0)')
  })

  it('builds distinct wipe, reveal, cover, zoom, flip, and cube motion', () => {
    const wipe = createPresentationTransitionKeyframes(transition({ effect: 'wipe', direction: 'up' }))
    const reveal = createPresentationTransitionKeyframes(transition({ effect: 'reveal', direction: 'right' }))
    const cover = createPresentationTransitionKeyframes(transition({ effect: 'cover', direction: 'down' }))
    const zoom = createPresentationTransitionKeyframes(transition({ effect: 'zoom', direction: 'out' }), 'backward')
    const flip = createPresentationTransitionKeyframes(transition({ effect: 'flip', direction: 'left' }))
    const cube = createPresentationTransitionKeyframes(transition({ effect: 'cube', direction: 'up' }))

    expect(wipe.current[0]?.clipPath).toBe('inset(0 0 100% 0)')
    expect(reveal.previousZIndex).toBe(3)
    expect(reveal.current).toHaveLength(0)
    expect(cover.previous).toHaveLength(0)
    expect(cover.current[0]?.transform).toBe('translate3d(0%, 100%, 0)')
    expect(zoom.current[0]?.transform).toBe('scale(0.72)')
    expect(flip.previous[1]?.transform).toContain('rotateY(90deg)')
    expect(cube.previous[1]?.transform).toContain('translate3d(0%, 50%, 0)')
    expect(cube.current[0]?.transform).toContain('rotateX(90deg)')
  })

  it('uses a black interval for effects configured to pass through black', () => {
    const plainCut = createPresentationTransitionKeyframes(transition({ effect: 'cut' }))
    const blackCut = createPresentationTransitionKeyframes(transition({ effect: 'cut', throughBlack: true }))
    const blackFade = createPresentationTransitionKeyframes(transition({ throughBlack: true }))
    const blackReveal = createPresentationTransitionKeyframes(transition({ effect: 'reveal', throughBlack: true }))

    expect(plainCut.immediate).toBe(true)
    expect(blackCut.immediate).toBe(false)
    expect(blackCut.previous[2]?.opacity).toBe(0)
    expect(blackCut.current[1]?.opacity).toBe(0)
    expect(blackFade.previous[1]?.offset).toBe(0.5)
    expect(blackFade.current[1]?.offset).toBe(0.5)
    expect(blackReveal.previous[1]?.offset).toBe(0.45)
    expect(blackReveal.current[1]?.offset).toBe(0.55)
  })
})

describe('PresentationTransitionPlayer', () => {
  it('plays both layers, cancels an obsolete run, and completes only the latest run once', async () => {
    let completed = 0
    const { host, root } = mountPlayer({ onComplete: () => { completed += 1 } })
    expect(animationCalls).toHaveLength(2)
    expect(host.querySelector<HTMLElement>('[data-testid="presentation-transition-previous"]')?.style.visibility).toBe('visible')

    await act(async () => {
      root.render(
        <PresentationTransitionPlayer
          previous={<div>Current slide</div>}
          current={<div>Next slide</div>}
          transition={transition({ effect: 'push', direction: 'right' })}
          runKey={2}
          onComplete={() => { completed += 1 }}
        />,
      )
    })

    expect(animationCalls).toHaveLength(4)
    expect(animationCalls[0]?.cancelCount).toBe(1)
    expect(animationCalls[1]?.cancelCount).toBe(1)
    animationCalls[0]?.finish()
    animationCalls[1]?.finish()
    await act(async () => Promise.resolve())
    expect(completed).toBe(0)

    animationCalls[2]?.finish()
    animationCalls[3]?.finish()
    await act(async () => Promise.resolve())
    expect(completed).toBe(1)
    expect(host.querySelector<HTMLElement>('[data-testid="presentation-transition-previous"]')?.style.visibility).toBe('hidden')

    await act(async () => root.unmount())
    expect(completed).toBe(1)
  })

  it('finishes immediately without animations for reduced motion', async () => {
    const originalMatchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addListener() {},
      removeListener() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia
    let completed = 0
    const { root } = mountPlayer({
      transition: transition({ effect: 'cube' }),
      onComplete: () => { completed += 1 },
    })

    await act(async () => Promise.resolve())
    expect(animationCalls).toHaveLength(0)
    expect(completed).toBe(1)

    window.matchMedia = originalMatchMedia
    await act(async () => root.unmount())
  })

  it('falls back to the current layer when starting a browser animation throws', async () => {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value() {
        throw new Error('animation unavailable')
      },
    })
    let completed = 0
    const { host, root } = mountPlayer({ onComplete: () => { completed += 1 } })

    await act(async () => Promise.resolve())
    expect(completed).toBe(1)
    expect(host.querySelector<HTMLElement>('[data-testid="presentation-transition-previous"]')?.style.visibility).toBe('hidden')
    expect(host.querySelector<HTMLElement>('[data-testid="presentation-transition-current"]')).not.toBeNull()

    await act(async () => root.unmount())
  })

  it('falls back to the current layer when Element.animate is unavailable', async () => {
    Reflect.deleteProperty(Element.prototype, 'animate')
    let completed = 0
    const { host, root } = mountPlayer({ onComplete: () => { completed += 1 } })

    await act(async () => Promise.resolve())
    expect(completed).toBe(1)
    expect(host.textContent).toContain('Current slide')
    expect(host.querySelector<HTMLElement>('[data-testid="presentation-transition-previous"]')?.style.visibility).toBe('hidden')

    await act(async () => root.unmount())
  })
})
