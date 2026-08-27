import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PresentationElement, PresentationShapeElement, PresentationSlide } from '@/atoms/presentation'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { PresentationAnimationPlayer } = await import('../PresentationAnimationPlayer')

interface MockAnimationCall {
  cancelCount: number
  keyframes: Keyframe[]
  options: KeyframeAnimationOptions
}

let animationCalls: MockAnimationCall[] = []

function shape(overrides: Partial<PresentationShapeElement> = {}): PresentationShapeElement {
  return {
    id: 'shape-1',
    type: 'rect',
    x: 120,
    y: 160,
    width: 360,
    height: 220,
    rotation: 0,
    fill: '#FFFFFF',
    borderColor: '#D7D8DE',
    borderWidth: 1,
    animation: 'blinds',
    animationDuration: 800,
    ...overrides,
  }
}

function slide(elements: PresentationElement | PresentationElement[]): PresentationSlide {
  return {
    id: 'slide-1',
    name: 'Animation test',
    background: '#F8F7F4',
    elements: Array.isArray(elements) ? elements : [elements],
    transition: { effect: 'none', durationMs: 0 },
  }
}

beforeEach(() => {
  animationCalls = []
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value(_frames: Keyframe[], _options: KeyframeAnimationOptions) {
      const call: MockAnimationCall = { cancelCount: 0, keyframes: _frames, options: _options }
      animationCalls.push(call)
      return {
        cancel() {
          call.cancelCount += 1
        },
      } as Animation
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

function mountPlayer(elements: PresentationElement | PresentationElement[]): { host: HTMLElement; root: Root } {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<PresentationAnimationPlayer runKey={1} slide={slide(elements)} width={1280} />)
  })
  return { host, root }
}

describe('PresentationAnimationPlayer', () => {
  it('renders every card member inside one shared animation layer', async () => {
    const groupId = 'card-group'
    const elements: PresentationElement[] = [
      shape({ groupId, animation: 'fade' }),
      {
        id: 'card-number',
        groupId,
        type: 'text',
        x: 150,
        y: 190,
        width: 80,
        height: 40,
        rotation: 0,
        text: '01',
        fontSize: 20,
        fontFamily: 'Aptos',
        fontWeight: 700,
        color: '#6957D9',
        align: 'left',
      },
      {
        id: 'card-heading',
        groupId,
        type: 'text',
        x: 150,
        y: 250,
        width: 260,
        height: 60,
        rotation: 0,
        text: 'Frame the idea',
        fontSize: 28,
        fontFamily: 'Aptos Display',
        fontWeight: 700,
        color: '#20202B',
        align: 'left',
      },
    ]
    const { host, root } = mountPlayer(elements)

    expect(animationCalls).toHaveLength(1)
    expect(host.querySelectorAll('[data-animation-part]')).toHaveLength(1)
    expect(Array.from(host.querySelectorAll('[data-animation-element-id]')).map((node) => (
      node.getAttribute('data-animation-element-id')
    ))).toEqual(['shape-1', 'card-number', 'card-heading'])
    expect(host.textContent).toContain('01')
    expect(host.textContent).toContain('Frame the idea')

    await act(async () => root.unmount())
  })

  it('renders blinds as clipped layers and never scales the editable object', async () => {
    const { host, root } = mountPlayer(shape())

    expect(host.querySelector('[data-testid="presentation-animation-player"]')).not.toBeNull()
    expect(host.querySelectorAll('[data-animation-part]')).toHaveLength(8)
    expect(animationCalls).toHaveLength(8)
    for (const call of animationCalls) {
      expect(call.keyframes[0]?.clipPath).toBeDefined()
      expect(call.keyframes[1]?.clipPath).toBeDefined()
      expect(call.keyframes.some((frame) => frame.transform !== undefined)).toBe(false)
    }

    await act(async () => root.unmount())
    expect(animationCalls.every((call) => call.cancelCount === 1)).toBe(true)
  })

  it('cancels obsolete layers and starts only the replacement run', async () => {
    const { root } = mountPlayer(shape())
    const obsoleteCalls = [...animationCalls]

    await act(async () => {
      root.render(<PresentationAnimationPlayer runKey={2} slide={slide(shape({ animation: 'fade' }))} width={1280} />)
    })

    expect(obsoleteCalls.every((call) => call.cancelCount === 1)).toBe(true)
    expect(animationCalls).toHaveLength(9)
    expect(animationCalls.at(-1)?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])

    await act(async () => root.unmount())
  })

  it('uses a one-millisecond visibility animation for Appear', async () => {
    const { root } = mountPlayer(shape({ animation: 'appear', animationDuration: 3_000 }))
    expect(animationCalls).toHaveLength(1)
    expect(animationCalls[0]?.options.duration).toBe(1)
    await act(async () => root.unmount())
  })
})
