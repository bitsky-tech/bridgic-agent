import type {
  PresentationAnimationEffect,
  PresentationElement,
} from '@/atoms/presentation'
import {
  clearPresentationAnimation,
  copyPresentationAnimationPatch,
  hasPresentationAnimation,
} from '@/lib/presentationAnimations'
import {
  isPresentationShapeElement,
  isPresentationTextElement,
} from '@/lib/presentationInsert'

export interface PresentationElementBounds {
  height: number
  width: number
  x: number
  y: number
}

export interface PresentationElementTarget {
  bounds: PresentationElementBounds
  elements: PresentationElement[]
  id: string
}

export interface PresentationAnimationTarget extends PresentationElementTarget {
  animationElement: PresentationElement
}

export interface PresentationCanvasSelectionContext {
  groupId: string | null
  isolatedId: string | null
}

export type PresentationCanvasSelectionScope = 'group' | 'element'

function normalizedGroupId(element: PresentationElement): string | undefined {
  const groupId = element.groupId?.trim()
  return groupId || undefined
}

/** Return the logical visual object represented by the selected element. */
export function getPresentationElementGroup(elements: readonly PresentationElement[], selected: PresentationElement): PresentationElement[] {
  const groupId = normalizedGroupId(selected)
  return groupId
    ? elements.filter((element) => normalizedGroupId(element) === groupId)
    : [selected]
}

/** Resolve whether a command targets the active group or the member drilled into for editing. */
export function getPresentationSelectionElements(elements: readonly PresentationElement[], selected: PresentationElement, isolatedElementId: string | null): PresentationElement[] {
  return isolatedElementId === selected.id ? [selected] : getPresentationElementGroup(elements, selected)
}

/** A second click inside an active group drills into that member and stays there while editing it. */
export function resolvePresentationCanvasSelectionScope(element: PresentationElement, context: PresentationCanvasSelectionContext): PresentationCanvasSelectionScope {
  return context.isolatedId === element.id
    || Boolean(element.groupId && normalizedGroupId(element) === context.groupId)
    ? 'element'
    : 'group'
}

function isElementCenterInsideBounds(element: PresentationElement, bounds: PresentationElementBounds): boolean {
  const centerX = element.x + (element.width / 2)
  const centerY = element.y + (element.height / 2)
  return centerX >= bounds.x && centerX <= bounds.x + bounds.width
    && centerY >= bounds.y && centerY <= bounds.y + bounds.height
}

/** Detach an individually moved member only when it crosses from inside to outside its group. */
export function detachPresentationElementsOutsideGroups(previousElements: readonly PresentationElement[], nextElements: readonly PresentationElement[], candidateIds: ReadonlySet<string>): PresentationElement[] {
  if (candidateIds.size === 0) return [...nextElements]
  const detachedIds = new Set<string>()
  for (const element of nextElements) {
    if (!candidateIds.has(element.id)) continue
    const groupId = normalizedGroupId(element)
    if (!groupId) continue
    const previousElement = previousElements.find((candidate) => candidate.id === element.id)
    if (!previousElement || normalizedGroupId(previousElement) !== groupId) continue
    const previousSiblings = previousElements.filter((candidate) => (
      candidate.id !== element.id && normalizedGroupId(candidate) === groupId
    ))
    const nextSiblings = nextElements.filter((candidate) => (
      candidate.id !== element.id && normalizedGroupId(candidate) === groupId
    ))
    if (previousSiblings.length === 0 || nextSiblings.length === 0) continue
    const wasInside = isElementCenterInsideBounds(previousElement, getPresentationElementBounds(previousSiblings))
    const isInside = isElementCenterInsideBounds(element, getPresentationElementBounds(nextSiblings))
    if (wasInside && !isInside) {
      detachedIds.add(element.id)
    }
  }
  if (detachedIds.size === 0) return [...nextElements]

  const transferAnimations = new Map<string, Partial<PresentationElement>>()
  const touchedGroupIds = new Set(
    nextElements.filter((element) => detachedIds.has(element.id)).flatMap((element) => {
      const groupId = normalizedGroupId(element)
      return groupId ? [groupId] : []
    }),
  )
  for (const groupId of touchedGroupIds) {
    const members = nextElements.filter((element) => normalizedGroupId(element) === groupId)
    const animationOwner = members.find(hasPresentationAnimation)
    const remaining = members.filter((element) => !detachedIds.has(element.id))
    if (animationOwner && detachedIds.has(animationOwner.id) && remaining[0]) {
      transferAnimations.set(remaining[0].id, copyPresentationAnimationPatch(animationOwner))
    }
  }

  return nextElements.map((element): PresentationElement => {
    const groupId = normalizedGroupId(element)
    if (!groupId || !touchedGroupIds.has(groupId)) return element
    const remainingCount = nextElements.filter((candidate) => (
      normalizedGroupId(candidate) === groupId && !detachedIds.has(candidate.id)
    )).length
    const detached = detachedIds.has(element.id)
    let next: PresentationElement = detached || remainingCount <= 1
      ? { ...element, groupId: undefined } as PresentationElement
      : element
    const transfer = transferAnimations.get(element.id)
    if (transfer) next = { ...clearPresentationAnimation(next), ...transfer } as PresentationElement
    else if (detached && hasPresentationAnimation(element) && remainingCount > 0) {
      next = clearPresentationAnimation(next)
    }
    return next
  })
}

/** Remove selected members while preserving the remaining group's animation owner and invariants. */
export function removePresentationElements(elements: readonly PresentationElement[], removedIds: ReadonlySet<string>): PresentationElement[] {
  if (removedIds.size === 0) return [...elements]
  const remainingElements = elements.filter((element) => !removedIds.has(element.id))
  const touchedGroupIds = new Set(
    elements.filter((element) => removedIds.has(element.id)).flatMap((element) => {
      const groupId = normalizedGroupId(element)
      return groupId ? [groupId] : []
    }),
  )
  const animationTransfers = new Map<string, Partial<PresentationElement>>()
  for (const groupId of touchedGroupIds) {
    const members = elements.filter((element) => normalizedGroupId(element) === groupId)
    const animationOwner = members.find(hasPresentationAnimation)
    const remaining = remainingElements.filter((element) => normalizedGroupId(element) === groupId)
    if (animationOwner && removedIds.has(animationOwner.id) && remaining[0]) {
      animationTransfers.set(remaining[0].id, copyPresentationAnimationPatch(animationOwner))
    }
  }
  return remainingElements.map((element): PresentationElement => {
    const groupId = normalizedGroupId(element)
    if (!groupId || !touchedGroupIds.has(groupId)) return element
    const remainingCount = remainingElements.filter((candidate) => normalizedGroupId(candidate) === groupId).length
    let next: PresentationElement = remainingCount <= 1
      ? { ...element, groupId: undefined } as PresentationElement
      : element
    const animationTransfer = animationTransfers.get(element.id)
    if (animationTransfer) {
      next = { ...clearPresentationAnimation(next), ...animationTransfer } as PresentationElement
    }
    return next
  })
}

/** The first member owns group-level animation metadata unless another member already owns it. */
export function getPresentationAnimationOwner(elements: readonly PresentationElement[], selected: PresentationElement): PresentationElement {
  const members = getPresentationElementGroup(elements, selected)
  return members.find(hasPresentationAnimation) ?? members[0] ?? selected
}

export function getPresentationElementBounds(elements: readonly PresentationElement[]): PresentationElementBounds {
  if (elements.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  const left = Math.min(...elements.map((element) => element.x))
  const top = Math.min(...elements.map((element) => element.y))
  const right = Math.max(...elements.map((element) => element.x + element.width))
  const bottom = Math.max(...elements.map((element) => element.y + element.height))
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** Collapse grouped members into ordered visual targets. */
export function getPresentationElementTargets(elements: readonly PresentationElement[]): PresentationElementTarget[] {
  const seen = new Set<string>()
  const targets: PresentationElementTarget[] = []
  for (const element of elements) {
    const groupId = normalizedGroupId(element)
    const id = groupId ? `group:${groupId}` : `element:${element.id}`
    if (seen.has(id)) continue
    seen.add(id)
    const members = groupId
      ? elements.filter((candidate) => normalizedGroupId(candidate) === groupId)
      : [element]
    targets.push({
      id,
      elements: members,
      bounds: getPresentationElementBounds(members),
    })
  }
  return targets
}

/** Collapse grouped members into one ordered animation target. */
export function getPresentationAnimationTargets(elements: readonly PresentationElement[]): PresentationAnimationTarget[] {
  return getPresentationElementTargets(elements).flatMap((target) => {
    const animationElement = target.elements.find(hasPresentationAnimation)
    return animationElement ? [{ ...target, animationElement }] : []
  })
}

/** Limit color emphasis to element types that PowerPoint can recolor meaningfully. */
export function getPresentationAnimationAffectedElements(target: PresentationAnimationTarget, effect: PresentationAnimationEffect): PresentationElement[] {
  if (effect === 'fillColor') return target.elements.filter(isPresentationShapeElement)
  if (effect === 'textColor') return target.elements.filter(isPresentationTextElement)
  return target.elements
}

export function isPresentationAnimationPatch(patch: Partial<PresentationElement>): boolean {
  return [
    'animation',
    'animationColor',
    'animationDelay',
    'animationDuration',
    'animationStart',
    'animationTrigger',
  ].some((key) => Object.prototype.hasOwnProperty.call(patch, key))
}
