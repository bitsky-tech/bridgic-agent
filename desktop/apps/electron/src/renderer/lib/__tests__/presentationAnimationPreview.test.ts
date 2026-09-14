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
  getPresentationAnimationDisplayStates,
  getPresentationColorAnimations,
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
  it.each(['fillColor', 'textColor', 'zoom'] as const)('retains grouped %s results without changing source geometry or rich text', effect => {
    const elements: PresentationElement[] = [
      shapeElement('card', { groupId: 'card-group', animation: effect, animationColor: '#2266CC' }),
      textElement('label', { groupId: 'card-group', x: 130, y: 180, width: 200, height: 60,
        textRuns: [{ start: 0, end: 5, style: { color: '#CC2222', fontSize: 21, fontWeight: 700 } }],
      }),
      shapeElement('other', { fill: '#999999' }),
    ]
    const original = JSON.stringify(elements)
    expect(getPresentationAnimationDisplayStates(elements, new Set()).size).toBe(0)
    const completed = new Set(['group:card-group'])
    const state = getPresentationAnimationDisplayStates(elements, completed)
    expect(state.has('other')).toBe(false)
    if (effect === 'fillColor') {
      expect(state.size).toBe(1)
      expect(state.get('card')!.element).toMatchObject({ fill: '#2266CC', borderColor: '#D7D8DE' })
    } else if (effect === 'textColor') {
      expect(state.size).toBe(1)
      expect(state.get('label')!.element).toMatchObject({ color: '#2266CC', textRuns: [{ start: 0, end: 5, style: { color: '#2266CC', fontSize: 21, fontWeight: 700 } }] })
    } else {
      expect(state.size).toBe(2)
      expect(state.get('card')!.scale).toEqual({ x: 300, y: 240, factor: 1.5 })
      expect(state.get('label')!.scale).toEqual(state.get('card')!.scale)
      expect(state.get('label')!.element).toBe(elements[1]!)
    }
    expect(getPresentationAnimationDisplayStates(elements, completed)).toEqual(state)
    expect(JSON.stringify(elements)).toBe(original)
  })

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

  it('schedules fill and text colors on their original targets, including delayed grouped effects', () => {
    const timeline = buildPresentationAnimationTimeline([
      shapeElement('fill', { groupId: 'card', animation: 'fillColor', animationColor: '#F2B91F', animationDuration: 800, animationDelay: 200 }),
      textElement('label', { groupId: 'card' }),
      textElement('text', { animation: 'textColor', animationColor: '#2678E8', animationStart: 'afterPrevious', animationDelay: 100 }),
    ])
    const animations = getPresentationColorAnimations(timeline, 7)
    expect([...animations.keys()]).toEqual(['fill', 'text'])
    expect(animations.get('fill')).toMatchObject({ property: 'fill', color: '#F2B91F', runKey: 7, options: { delay: 200, duration: 800, fill: 'both' } })
    expect(animations.get('text')).toMatchObject({ property: 'color', color: '#2678E8', options: { delay: 1100 } })
    expect(timeline.flatMap(entry => createPresentationAnimationParts(entry))).toEqual([])
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
