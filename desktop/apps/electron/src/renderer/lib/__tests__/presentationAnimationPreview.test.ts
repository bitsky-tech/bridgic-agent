import { describe, expect, it } from 'bun:test'
import type {
  PresentationElement,
  PresentationShapeElement,
  PresentationTextElement,
} from '@/atoms/presentation'
import {
  buildPresentationAnimationPlaybackSteps,
  buildPresentationAnimationTimeline,
  createPresentationAnimationParts,
  getPresentationAnimationHiddenElementIds,
} from '@/lib/presentationAnimationPreview'

function textElement(id: string, patch: Partial<PresentationTextElement> = {}): PresentationTextElement {
  return {
    id,
    type: 'text',
    x: 100,
    y: 120,
    width: 400,
    height: 90,
    rotation: 0,
    text: id,
    fontSize: 32,
    fontFamily: 'Aptos',
    fontWeight: 400,
    color: '#20202B',
    align: 'left',
    ...patch,
  }
}

function shapeElement(id: string, patch: Partial<PresentationShapeElement> = {}): PresentationShapeElement {
  return {
    id,
    type: 'rect',
    x: 100,
    y: 120,
    width: 400,
    height: 240,
    rotation: 0,
    fill: '#FFFFFF',
    borderColor: '#D7D8DE',
    borderWidth: 1,
    ...patch,
  }
}

function singleEntry(element: PresentationElement) {
  const entry = buildPresentationAnimationTimeline([element])[0]
  if (!entry) throw new Error('Expected an animation timeline entry')
  return entry
}

describe('presentation animation preview', () => {
  it('collapses a grouped card into one animation target with union geometry', () => {
    const elements: PresentationElement[] = [
      shapeElement('card', {
        groupId: 'card-group',
        animation: 'zoom',
        x: 100,
        y: 120,
        width: 400,
        height: 240,
      }),
      textElement('number', { groupId: 'card-group', x: 80, y: 100, width: 80, height: 40 }),
      textElement('heading', { groupId: 'card-group', x: 130, y: 180, width: 420, height: 80 }),
      textElement('body', { groupId: 'card-group', x: 130, y: 280, width: 300, height: 120 }),
    ]

    const timeline = buildPresentationAnimationTimeline(elements)
    expect(timeline).toHaveLength(1)
    expect(timeline[0]?.elements.map((element) => element.id)).toEqual(['card', 'number', 'heading', 'body'])
    expect(timeline[0]?.bounds).toEqual({ x: 80, y: 100, width: 470, height: 300 })

    const parts = createPresentationAnimationParts(timeline[0]!)
    expect(parts).toHaveLength(1)
    expect(parts[0]?.elements.map((element) => element.id)).toEqual(['card', 'number', 'heading', 'body'])
    expect(parts[0]?.keyframes[0]).toMatchObject({ transformOrigin: '315px 250px' })
  })

  it('keeps with-previous effects on the latest step without losing source order', () => {
    const timeline = buildPresentationAnimationTimeline([
      textElement('a', { animation: 'fade', animationDuration: 400, animationDelay: 100, animationStart: 'onClick' }),
      textElement('b', { animation: 'fade', animationDuration: 200, animationStart: 'withPrevious' }),
      textElement('c', { animation: 'disappear', animationDelay: 50, animationStart: 'afterPrevious' }),
      textElement('d', { animation: 'fade', animationDuration: 180, animationDelay: 20, animationStart: 'withPrevious' }),
    ])

    expect(timeline.map(({ element, startsAt, endsAt }) => ({ id: element.id, startsAt, endsAt }))).toEqual([
      { id: 'a', startsAt: 100, endsAt: 500 },
      { id: 'b', startsAt: 0, endsAt: 200 },
      { id: 'c', startsAt: 550, endsAt: 551 },
      { id: 'd', startsAt: 520, endsAt: 700 },
    ])
  })

  it('builds slide-click and element-click playback steps with stable visibility state', () => {
    const elements: PresentationElement[] = [
      textElement('a', { animation: 'fade', animationStart: 'onClick' }),
      textElement('b', { animation: 'flyIn', animationStart: 'withPrevious' }),
      textElement('c', { animation: 'disappear', animationStart: 'afterPrevious' }),
      textElement('d', { animation: 'blinds', animationStart: 'onClick', animationTrigger: 'elementClick' }),
    ]
    const steps = buildPresentationAnimationPlaybackSteps(elements)

    expect(steps.map((step) => ({ ids: step.elementIds, trigger: step.trigger }))).toEqual([
      { ids: ['a', 'b', 'c'], trigger: 'slideClick' },
      { ids: ['d'], trigger: 'elementClick' },
    ])
    expect([...getPresentationAnimationHiddenElementIds(elements, new Set())]).toEqual(['a', 'b', 'd'])
    expect([...getPresentationAnimationHiddenElementIds(elements, new Set(['element:a', 'element:b', 'element:c']))]).toEqual(['c', 'd'])
  })

  it('treats appear and disappear as instant visibility changes', () => {
    const timeline = buildPresentationAnimationTimeline([
      textElement('appear', { animation: 'appear', animationDuration: 3_000 }),
      textElement('disappear', { animation: 'disappear', animationDuration: 3_000, animationStart: 'afterPrevious' }),
    ])

    expect(timeline[0]?.effectiveDurationMs).toBe(1)
    expect(timeline[1]?.startsAt).toBe(1)
    expect(timeline[1]?.endsAt).toBe(2)
  })

  it('uses clip fragments for blinds, checkerboard, dissolve, and blinds-out without deforming geometry', () => {
    for (const effect of ['blinds', 'checkerboard', 'dissolve', 'blindsOut'] as const) {
      const parts = createPresentationAnimationParts(singleEntry(shapeElement(effect, { animation: effect })))
      expect(parts.length).toBeGreaterThan(1)
      for (const part of parts) {
        const frames = part.keyframes as Array<Record<string, unknown>>
        expect(frames.some((frame) => 'scaleX' in frame || 'scaleY' in frame || 'left' in frame || 'top' in frame)).toBe(false)
        expect(Boolean(part.style?.clipPath) || frames.some((frame) => 'clipPath' in frame)).toBe(true)
      }
    }
  })

  it('flies in from fully below the slide instead of nudging inside the canvas', () => {
    const parts = createPresentationAnimationParts(singleEntry(shapeElement('fly', { animation: 'flyIn', y: 100 })))
    const firstFrame = parts[0]?.keyframes[0] as Record<string, unknown>
    const lastFrame = parts[0]?.keyframes.at(-1) as Record<string, unknown>

    expect(firstFrame.transform).toBe('translate3d(0, 644px, 0)')
    expect(lastFrame.transform).toBe('translate3d(0, 0, 0)')
  })

  it('grows around the element center without changing its layout coordinates', () => {
    const parts = createPresentationAnimationParts(singleEntry(shapeElement('zoom', {
      animation: 'zoom',
      x: 100,
      y: 120,
      width: 400,
      height: 240,
    })))
    const frames = parts[0]?.keyframes as Array<Record<string, unknown>>

    expect(frames[0]).toMatchObject({ transform: 'scale(1)', transformOrigin: '300px 240px' })
    expect(frames[1]).toMatchObject({ transform: 'scale(1.5)', transformOrigin: '300px 240px' })
    expect(frames.some((frame) => 'left' in frame || 'top' in frame)).toBe(false)
  })

  it('cross-fades to the requested fill and text colors', () => {
    const fillParts = createPresentationAnimationParts(singleEntry(shapeElement('fill', {
      animation: 'fillColor',
      animationColor: '#F2B91F',
    })))
    const textParts = createPresentationAnimationParts(singleEntry(textElement('text', {
      animation: 'textColor',
      animationColor: '#2678E8',
    })))

    expect(fillParts).toHaveLength(2)
    expect((fillParts[1]?.element as PresentationShapeElement).fill).toBe('#F2B91F')
    expect((textParts[1]?.element as PresentationTextElement).color).toBe('#2678E8')
    expect(fillParts[1]?.keyframes).toEqual([{ opacity: 0 }, { opacity: 1 }])
  })

  it('keeps dissolve ordering deterministic for stable visual previews', () => {
    const entry = singleEntry(shapeElement('stable-dissolve', { animation: 'dissolve' }))
    const first = createPresentationAnimationParts(entry)
    const second = createPresentationAnimationParts(entry)
    expect(first).toEqual(second)
  })

  it('renders float, split, wipe, and entrance zoom with distinct geometry', () => {
    const parts = ['floatIn', 'split', 'wipeIn', 'zoomIn'].map((animation) => (
      createPresentationAnimationParts(singleEntry(shapeElement(animation, { animation: animation as never })))
    ))

    expect(parts[0]?.[0]?.keyframes[0]).toMatchObject({ opacity: 0, transform: 'translate3d(0, 48px, 0)' })
    expect(parts[1]).toHaveLength(2)
    expect(parts[2]?.[0]?.keyframes[0]?.clipPath).toBeDefined()
    expect(parts[3]?.[0]?.keyframes[0]).toMatchObject({ opacity: 0, transform: 'scale(0.2)' })
  })
})
