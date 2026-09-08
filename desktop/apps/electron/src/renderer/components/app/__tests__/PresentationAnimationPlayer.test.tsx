import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { PresentationElement, PresentationShapeElement, PresentationSlide, PresentationTextElement } from '@/atoms/presentation'
import type { Root } from 'react-dom/client'

GlobalRegistrator.register()
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const { act } = await import('react')
const { createRoot } = await import('react-dom/client')
const { PresentationAnimationPlayer } = await import('../PresentationAnimationPlayer')
const { getPresentationAnimationHiddenElementIds } = await import('@/lib/presentationAnimationPreview')

interface MockAnimationCall {
  node: HTMLElement | SVGElement
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
      const call: MockAnimationCall = { node: this, cancelCount: 0, keyframes: _frames, options: _options }
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
  it.each(['appear', 'fade', 'blinds', 'checkerboard', 'dissolve', 'flyIn', 'floatIn', 'split', 'wipeIn', 'zoomIn', 'zoom', 'disappear', 'blindsOut'] as const)('preserves authored stacking during %s and completion for individual, adjacent and interleaved group members', async animation => {
    for (const grouping of ['individual', 'adjacent', 'interleaved']) {
      const groupId = grouping === 'individual' ? undefined : 'card-group'
      const card = shape({ id: 'card', animation, groupId, animationDelay: 50 })
      const label: PresentationTextElement = {
        id: 'label', groupId, type: 'text', text: 'Visible label', x: 140, y: 200, width: 250, height: 60, rotation: 0,
        fontSize: 32, fontFamily: 'Arial', fontWeight: 700, color: '#FFFFFF', align: 'left',
        ...(groupId ? {} : { hyperlink: { type: 'url' as const, url: 'https://example.com', tooltip: 'Foreground link' } }),
      }
      const background = shape({ id: 'background', animation: 'none' })
      const middle = shape({ id: 'middle', animation: 'none' })
      const foreground = shape({ id: 'foreground', animation: 'none' })
      const elements = grouping === 'interleaved' ? [background, card, middle, label, foreground] : [background, card, label, foreground]
      const model = slide(elements)
      const original = JSON.stringify(model)
      const host = document.createElement('div')
      document.body.appendChild(host)
      const root = createRoot(host)
      const completed = new Set([groupId ? `group:${groupId}` : 'element:card'])
      let activated = 0
      const render = (playing: boolean, held: boolean) => act(async () => root.render(
        <PresentationAnimationPlayer slide={model} width={640} runKey={1} elementIds={playing ? ['card'] : []}
          baseHiddenElementIds={getPresentationAnimationHiddenElementIds(elements, held ? completed : new Set())}
          completedTargetIds={held ? completed : undefined} onActivateHyperlink={() => activated++} />,
      ))
      await render(false, false)
      const paint = (id: string) => host.querySelector(`[data-presentation-color-element="${id}"]`)!
      const backgroundNode = paint('background')
      const foregroundNode = paint('foreground')
      const middleNode = grouping === 'interleaved' ? paint('middle') : null
      const link = host.querySelector<HTMLButtonElement>('button[aria-label="Foreground link"]')
      await render(true, false)
      const parts = [...host.querySelectorAll<HTMLElement>('[data-animation-part]')]
      expect(parts.length).toBeGreaterThan(0)
      for (const part of parts) {
        // These must share a stacking parent; document order alone cannot detect a top-level overlay.
        expect(part.parentElement).toBe(foregroundNode.parentElement)
        expect(backgroundNode.compareDocumentPosition(part) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        expect(part.compareDocumentPosition(foregroundNode) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        if (grouping === 'individual') {
          expect(part.compareDocumentPosition(paint('label')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
        } else if (middleNode) {
          const precedesMiddle = Boolean(part.querySelector('[data-animation-element-id="card"]'))
          expect(Boolean(part.compareDocumentPosition(middleNode) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(precedesMiddle)
          const counterpart = parts.find(candidate => candidate !== part && candidate.dataset.animationPart === part.dataset.animationPart)!
          const call = animationCalls.find(call => call.node === part)!
          const otherCall = animationCalls.find(call => call.node === counterpart)!
          expect(call.keyframes).toEqual(otherCall.keyframes)
          expect(call.options).toEqual(otherCall.options)
          expect(part.style.clipPath).toBe(counterpart.style.clipPath)
        }
      }
      if (link) {
        expect(host.querySelector('button[aria-label="Foreground link"]')).toBe(link)
        await act(async () => link.click())
        expect(activated).toBe(1)
      }
      await render(false, true)
      expect(host.querySelectorAll('[data-animation-part]')).toHaveLength(0)
      expect(paint('background')).toBe(backgroundNode)
      expect(paint('foreground')).toBe(foregroundNode)
      if (middleNode) expect(paint('middle')).toBe(middleNode)
      const hidden = getPresentationAnimationHiddenElementIds(elements, completed)
      expect([...host.querySelectorAll('[data-presentation-color-element]')].map(node => node.getAttribute('data-presentation-color-element')))
        .toEqual(elements.filter(element => !hidden.has(element.id)).map(element => element.id))
      expect(JSON.stringify(model)).toBe(original)
      await act(async () => root.unmount())
      host.remove()
    }
  })

  it('recolors one translucent card in place while keeping grouped and ungrouped foreground content above it', async () => {
    const elements: PresentationElement[] = [
      shape({ id: 'card', groupId: 'group', animation: 'fillColor', animationColor: '#2266CC', fill: '#CC2222', opacity: 0.5 }),
      { id: 'label', groupId: 'group', type: 'text', text: 'Label', x: 140, y: 200, width: 250, height: 60, rotation: 0, fontSize: 32, fontFamily: 'Arial', fontWeight: 700, color: '#FFFFFF', align: 'left' },
      shape({ id: 'foreground', animation: 'none', fill: '#00FF00', x: 200, width: 50 }),
    ]
    const original = JSON.stringify(elements)
    const { host, root } = mountPlayer(elements)
    const preview = host.querySelector('[data-testid="presentation-slide-preview"]')!
    expect([...preview.querySelectorAll('[data-presentation-color-element]')].map(node => node.getAttribute('data-presentation-color-element'))).toEqual(['card', 'label', 'foreground'])
    expect(host.querySelectorAll('[data-animation-part]')).toHaveLength(0)
    const card = preview.querySelector<SVGElement>('[data-presentation-color-element="card"]')!
    expect(card.style.opacity).toBe('0.5')
    expect(host.querySelectorAll('[data-presentation-color-element="card"]')).toHaveLength(1)
    expect(animationCalls).toHaveLength(1)
    expect(animationCalls[0]!.node).toBe(card.querySelector('rect')!)
    expect(animationCalls[0]!.keyframes.at(-1)).toEqual({ fill: '#2266CC' })
    expect(card.querySelector('rect')!.getAttribute('stroke')).toBe('#D7D8DE')
    expect(JSON.stringify(elements)).toBe(original)
    await act(async () => root.unmount())
    expect(animationCalls[0]!.cancelCount).toBe(1)
  })

  it.each(['horizontal', 'eastAsianVertical', 'stacked'] as const)('retains independent rich-run alpha in %s text color animation', async textDirection => {
    const text: PresentationTextElement = {
      id: 'text', type: 'text', text: '中文A', x: 140, y: 160, width: 300, height: 180, rotation: 0,
      fontSize: 32, fontFamily: 'Arial', fontWeight: 700, color: '#CC2222', align: 'left', textDirection,
      animation: 'textColor', animationColor: '#2266CC', opacity: 0.5,
      textRuns: [{ start: 0, end: 1, style: { opacity: 0, color: '#FF8800' } }, { start: 1, end: 3, style: { opacity: 0.35 } }],
      hyperlink: { type: 'url', url: 'https://example.com' },
    }
    const original = JSON.stringify(text)
    const { host, root } = mountPlayer(text)
    const frame = host.querySelector<HTMLElement>('[data-testid="presentation-text-preview"]')!
    const runs = [...frame.querySelectorAll<HTMLElement>('[data-presentation-text-color]')]
    expect(host.querySelectorAll('[data-testid="presentation-text-preview"]')).toHaveLength(1)
    expect(frame.style.opacity).toBe('0.5')
    expect(animationCalls.map(call => call.node)).toEqual(runs)
    for (const [index, call] of animationCalls.entries()) {
      const opacity = Number(runs[index]!.getAttribute('data-presentation-color-opacity'))
      expect(call.keyframes.at(-1)).toEqual({ color: `color-mix(in srgb, #2266CC ${opacity * 100}%, transparent)` })
      expect(Object.keys(call.keyframes[0]!)).toEqual(['color'])
    }
    expect(animationCalls.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(text)).toBe(original)
    await act(async () => root.unmount())
  })

  it.each(['fillColor', 'textColor'] as const)('cancels %s animations before replay without replacing the paint node', async animation => {
    const element: PresentationElement = animation === 'fillColor' ? shape({ animation }) : {
      id: 'text', type: 'text', text: 'Label', x: 140, y: 200, width: 250, height: 60, rotation: 0,
      fontSize: 32, fontFamily: 'Arial', fontWeight: 700, color: '#CC2222', align: 'left', animation,
    }
    const model = slide(element)
    const { host, root } = mountPlayer(element)
    const first = animationCalls[0]!
    await act(async () => root.render(<PresentationAnimationPlayer slide={model} width={1280} runKey={2} />))
    expect(first.cancelCount).toBe(1)
    expect(animationCalls).toHaveLength(2)
    expect(animationCalls[1]!.node).toBe(first.node)
    expect(host.querySelectorAll('[data-presentation-color-element]')).toHaveLength(1)
    await act(async () => root.unmount())
    expect(animationCalls[1]!.cancelCount).toBe(1)
  })

  for (const animation of ['fillColor', 'textColor'] as const) it.each(['missing', 'throws'] as const)(`keeps ${animation} fallback correct through completion and reset when animate %s`, async behavior => {
    if (behavior === 'missing') Reflect.deleteProperty(Element.prototype, 'animate')
    else Object.defineProperty(Element.prototype, 'animate', { configurable: true, value() { throw new Error('Unsupported animation') } })
    const element: PresentationElement = animation === 'fillColor' ? shape({ animation, animationColor: '#2266CC', fill: '#CC2222' }) : {
      id: 'text', type: 'text', text: 'Label', x: 140, y: 200, width: 250, height: 60, rotation: 0,
      fontSize: 32, fontFamily: 'Arial', fontWeight: 700, color: '#CC2222', align: 'left', animation, animationColor: '#2266CC',
    }
    const model = slide(element)
    const { host, root } = mountPlayer(element)
    const property = animation === 'fillColor' ? 'fill' : 'color'
    const node = host.querySelector<HTMLElement | SVGElement>(property === 'fill' ? 'svg rect' : '[data-presentation-text-color]')!
    const displayed = () => (node.style[property] || node.getAttribute(property)!).toUpperCase()
    expect(displayed()).toBe('#2266CC')
    await act(async () => root.render(<PresentationAnimationPlayer slide={model} width={1280} runKey={1} elementIds={[]} completedTargetIds={new Set([`element:${element.id}`])} />))
    expect(displayed()).toBe('#2266CC')
    await act(async () => root.render(<PresentationAnimationPlayer slide={model} width={1280} runKey={2} elementIds={[]} />))
    expect(displayed()).toBe('#CC2222')
    await act(async () => root.unmount())
  })

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
