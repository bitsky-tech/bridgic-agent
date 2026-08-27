import { describe, expect, it } from 'bun:test'
import type { PresentationShapeElement } from '@/atoms/presentation'
import {
  detachPresentationElementsOutsideGroups,
  getPresentationSelectionElements,
  removePresentationElements,
  resolvePresentationCanvasSelectionScope,
} from '@/lib/presentationGroups'

function shape(id: string, groupId?: string): PresentationShapeElement {
  return {
    id,
    type: 'rect',
    groupId,
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    fill: '#FFFFFF',
    borderColor: '#000000',
    borderWidth: 1,
  }
}

describe('presentation group selection', () => {
  it('selects a group first and drills into a member on the next click', () => {
    const member = shape('heading', 'card')

    expect(resolvePresentationCanvasSelectionScope(member, {
      groupId: null,
      isolatedId: null,
    })).toBe('group')
    expect(resolvePresentationCanvasSelectionScope(member, {
      groupId: 'card',
      isolatedId: null,
    })).toBe('element')
  })

  it('keeps an isolated member individually selectable until another member is clicked', () => {
    const heading = shape('heading', 'card')
    const body = shape('body', 'card')
    const context = { groupId: null, isolatedId: heading.id }

    expect(resolvePresentationCanvasSelectionScope(heading, context)).toBe('element')
    expect(resolvePresentationCanvasSelectionScope(body, context)).toBe('group')
    expect(getPresentationSelectionElements([heading, body], heading, heading.id)).toEqual([heading])
    expect(getPresentationSelectionElements([heading, body], heading, null)).toEqual([heading, body])
  })

  it('detaches a member moved outside the rest of its group', () => {
    const card = shape('card', 'card-group')
    const label = shape('label', 'card-group')
    const previousMoved = { ...label, id: 'number', x: 20, y: 20, width: 30, height: 20, animation: 'fade' as const }
    const moved = { ...label, id: 'number', x: 240, animation: 'fade' as const }
    const elements = detachPresentationElementsOutsideGroups(
      [card, previousMoved, label],
      [card, moved, label],
      new Set([moved.id]),
    )

    const detached = elements.find((element) => element.id === moved.id)
    expect(detached?.groupId).toBeUndefined()
    expect(detached?.animation).toBeUndefined()
    expect(elements.find((element) => element.id === card.id)).toMatchObject({
      groupId: 'card-group',
      animation: 'fade',
    })
    expect(elements.find((element) => element.id === label.id)?.groupId).toBe('card-group')
  })

  it('keeps a member grouped while it remains inside the group bounds', () => {
    const card = shape('card', 'card-group')
    const label = { ...shape('label', 'card-group'), x: 20, y: 20, width: 30, height: 20 }
    const movedLabel = { ...label, x: 25 }
    const elements = detachPresentationElementsOutsideGroups([card, label], [card, movedLabel], new Set([label.id]))

    expect(elements.every((element) => element.groupId === 'card-group')).toBe(true)
  })

  it('does not detach an intentionally non-overlapping group on its first edit', () => {
    const left = shape('left', 'row')
    const right = { ...shape('right', 'row'), x: 140 }
    const movedRight = { ...right, x: 150 }
    const elements = detachPresentationElementsOutsideGroups([left, right], [left, movedRight], new Set([right.id]))

    expect(elements.every((element) => element.groupId === 'row')).toBe(true)
  })

  it('removes one member without deleting its group and transfers group animation ownership', () => {
    const owner = { ...shape('owner', 'card'), animation: 'fade' as const }
    const body = shape('body', 'card')
    const background = shape('background', 'card')
    const elements = removePresentationElements([owner, body, background], new Set([owner.id]))

    expect(elements.map((element) => element.id)).toEqual(['body', 'background'])
    expect(elements[0]).toMatchObject({ groupId: 'card', animation: 'fade' })
    expect(elements[1]?.groupId).toBe('card')
  })
})
