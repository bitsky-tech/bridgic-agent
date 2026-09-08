import {
  PRESENTATION_PAGE_SIZES,
  type PresentationElement,
  type PresentationPageSize,
} from '@/atoms/presentation'
import {
  isPresentationShapeElement,
  isPresentationTextElement,
} from '@/lib/presentationInsert'
import {
  getPresentationAnimationAffectedElements,
  getPresentationAnimationTargets,
  type PresentationElementBounds,
} from '@/lib/presentationGroups'
import {
  normalizePresentationAnimation,
  type NormalizedPresentationAnimation,
} from '@/lib/presentationAnimations'
import { patchPresentationText } from '@/lib/presentationText'

const LINEAR_EASING = 'linear'
const MOTION_EASING = 'cubic-bezier(0.16, 1, 0.3, 1)'
const EMPHASIS_EASING = 'cubic-bezier(0.4, 0, 0.2, 1)'
const EMPHASIS_SCALE = 1.5
const BLIND_COUNT = 8
const CHECKERBOARD_COLUMNS = 8
const CHECKERBOARD_ROWS = 6
const DISSOLVE_COLUMNS = 10
const DISSOLVE_ROWS = 6

export const PRESENTATION_ANIMATION_FINAL_HOLD_MS = 260

export interface PresentationAnimationTimelineEntry {
  animation: NormalizedPresentationAnimation
  bounds: PresentationElementBounds
  effectiveDurationMs: number
  element: PresentationElement
  elements: PresentationElement[]
  endsAt: number
  id: string
  startsAt: number
}

export interface PresentationAnimationPartSpec {
  element: PresentationElement
  elements: PresentationElement[]
  id: string
  keyframes: Keyframe[]
  options?: KeyframeAnimationOptions
  style?: {
    clipPath?: string
  }
}

export interface PresentationColorAnimation {
  property: 'fill' | 'color'
  color: string
  options: KeyframeAnimationOptions
  runKey: string | number
}

/** Animate each existing paint node instead of compositing duplicate translucent elements. */
export function getPresentationColorAnimations(timeline: readonly PresentationAnimationTimelineEntry[], runKey: string | number): ReadonlyMap<string, PresentationColorAnimation> {
  const animations = new Map<string, PresentationColorAnimation>()
  for (const entry of timeline) {
    const { animation } = entry
    if (animation.effect !== 'fillColor' && animation.effect !== 'textColor') continue
    const target = { ...entry, animationElement: entry.element }
    for (const element of getPresentationAnimationAffectedElements(target, animation.effect)) {
      animations.set(element.id, {
        property: animation.effect === 'fillColor' ? 'fill' : 'color',
        color: animation.color,
        options: animationOptions(entry),
        runKey,
      })
    }
  }
  return animations
}

export interface PresentationAnimationPlaybackStep {
  bounds: PresentationElementBounds
  elementIds: string[]
  id: string
  targetIds: string[]
  trigger: NormalizedPresentationAnimation['trigger'] | 'slideEnter'
  triggerElementId: string
}

export interface PresentationAnimationScale {
  x: number
  y: number
  factor: number
}

export interface PresentationAnimationDisplayState {
  element: PresentationElement
  scale?: PresentationAnimationScale
  textColor?: string
}

/** Keep emphasis results in the playback view without editing the authored slide. */
export function getPresentationAnimationDisplayStates(elements: readonly PresentationElement[], completedTargetIds: ReadonlySet<string>): ReadonlyMap<string, PresentationAnimationDisplayState> {
  const states = new Map<string, PresentationAnimationDisplayState>()
  for (const target of getPresentationAnimationTargets(elements)) {
    if (!completedTargetIds.has(target.id)) continue
    const animation = normalizePresentationAnimation(target.animationElement)
    if (animation.effect === 'zoom') {
      const scale = { x: target.bounds.x + target.bounds.width / 2, y: target.bounds.y + target.bounds.height / 2, factor: EMPHASIS_SCALE }
      for (const element of target.elements) states.set(element.id, { element, scale })
    } else if (animation.effect === 'fillColor' || animation.effect === 'textColor') {
      for (const element of getPresentationAnimationAffectedElements(target, animation.effect)) {
        states.set(element.id, {
          element: animationColorElement(animation, element),
          ...(animation.effect === 'textColor' ? { textColor: animation.color } : {}),
        })
      }
    }
  }
  return states
}

const entranceAnimationEffects = new Set<NormalizedPresentationAnimation['effect']>([
  'appear',
  'fade',
  'blinds',
  'checkerboard',
  'dissolve',
  'flyIn',
  'floatIn',
  'split',
  'wipeIn',
  'zoomIn',
])

const exitAnimationEffects = new Set<NormalizedPresentationAnimation['effect']>(['disappear', 'blindsOut'])

/** Group click/after/with timing into the steps a slide show advances through. */
export function buildPresentationAnimationPlaybackSteps(elements: readonly PresentationElement[]): PresentationAnimationPlaybackStep[] {
  const steps: PresentationAnimationPlaybackStep[] = []
  let current: PresentationAnimationPlaybackStep | undefined
  for (const target of getPresentationAnimationTargets(elements)) {
    const animation = normalizePresentationAnimation(target.animationElement)
    const startsStep = animation.trigger === 'elementClick' || animation.start === 'onClick' || !current
    if (startsStep) {
      current = {
        bounds: target.bounds,
        elementIds: [target.animationElement.id],
        id: `step:${target.id}`,
        targetIds: [target.id],
        trigger: !current && animation.trigger === 'slideClick' && animation.start !== 'onClick'
          ? 'slideEnter'
          : animation.trigger,
        triggerElementId: target.animationElement.id,
      }
      steps.push(current)
      continue
    }
    if (!current) continue
    current.elementIds.push(target.animationElement.id)
    current.targetIds.push(target.id)
  }
  return steps
}

/** Resolve which elements are absent before entrance effects or after exit effects. */
export function getPresentationAnimationHiddenElementIds(elements: readonly PresentationElement[], completedTargetIds: ReadonlySet<string>): Set<string> {
  const hidden = new Set<string>()
  for (const target of getPresentationAnimationTargets(elements)) {
    const animation = normalizePresentationAnimation(target.animationElement)
    const completed = completedTargetIds.has(target.id)
    const shouldHide = entranceAnimationEffects.has(animation.effect) ? !completed : exitAnimationEffects.has(animation.effect) && completed
    if (shouldHide) target.elements.forEach((element) => hidden.add(element.id))
  }
  return hidden
}

function effectiveAnimationDuration(animation: NormalizedPresentationAnimation): number {
  return animation.effect === 'appear' || animation.effect === 'disappear'
    ? 1
    : animation.durationMs
}

/** Build a stable preview timeline without conflating animation order with drawing mutations. */
export function buildPresentationAnimationTimeline(elements: readonly PresentationElement[]): PresentationAnimationTimelineEntry[] {
  let hasStep = false
  let stepStartsAt = 0
  let timelineEnd = 0
  const entries: PresentationAnimationTimelineEntry[] = []

  for (const target of getPresentationAnimationTargets(elements)) {
    const element = target.animationElement
    const animation = normalizePresentationAnimation(element)
    if (animation.effect === 'none') continue
    if (!hasStep || animation.start !== 'withPrevious') {
      stepStartsAt = timelineEnd
      hasStep = true
    }
    const effectiveDurationMs = effectiveAnimationDuration(animation)
    const startsAt = stepStartsAt + animation.delayMs
    const endsAt = startsAt + effectiveDurationMs
    entries.push({
      animation,
      bounds: target.bounds,
      effectiveDurationMs,
      element,
      elements: target.elements,
      endsAt,
      id: target.id,
      startsAt,
    })
    timelineEnd = Math.max(timelineEnd, endsAt)
  }

  return entries
}

function animationOptions(entry: PresentationAnimationTimelineEntry, overrides: Partial<KeyframeAnimationOptions> = {}): KeyframeAnimationOptions {
  return {
    delay: entry.startsAt,
    duration: entry.effectiveDurationMs,
    easing: LINEAR_EASING,
    fill: 'both',
    ...overrides,
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function cssNumber(value: number): string {
  return Number(value.toFixed(3)).toString()
}

function clipInset(left: number, top: number, width: number, height: number, pageSize: PresentationPageSize): string {
  const safeLeft = clamp(left, 0, pageSize.width)
  const safeTop = clamp(top, 0, pageSize.height)
  const safeRight = clamp(left + width, 0, pageSize.width)
  const safeBottom = clamp(top + height, 0, pageSize.height)
  return `inset(${cssNumber(safeTop)}px ${cssNumber(pageSize.width - safeRight)}px ${cssNumber(pageSize.height - safeBottom)}px ${cssNumber(safeLeft)}px)`
}

function cellParts(entry: PresentationAnimationTimelineEntry, columns: number, rows: number, order: number[], idPrefix: string, pageSize: PresentationPageSize): PresentationAnimationPartSpec[] {
  const count = columns * rows
  const cellDuration = Math.max(1, entry.effectiveDurationMs * 0.28)
  const delayRange = Math.max(0, entry.effectiveDurationMs - cellDuration)
  const bounds = entry.bounds
  return Array.from({ length: count }, (_, index) => {
    const column = index % columns
    const row = Math.floor(index / columns)
    const cellWidth = bounds.width / columns
    const cellHeight = bounds.height / rows
    const rank = order[index] ?? index
    const ratio = count <= 1 ? 0 : rank / (count - 1)
    return {
      id: `${idPrefix}-${row}-${column}`,
      element: entry.element,
      elements: entry.elements,
      keyframes: [{ opacity: 0 }, { opacity: 1 }],
      options: animationOptions(entry, {
        delay: entry.startsAt + (delayRange * ratio),
        duration: cellDuration,
      }),
      style: {
        clipPath: clipInset(
          bounds.x + (column * cellWidth),
          bounds.y + (row * cellHeight),
          cellWidth + 0.5,
          cellHeight + 0.5,
          pageSize,
        ),
      },
    }
  })
}

function checkerboardOrder(): number[] {
  const indices = Array.from({ length: CHECKERBOARD_COLUMNS * CHECKERBOARD_ROWS }, (_, index) => index)
  indices.sort((a, b) => {
    const aColumn = a % CHECKERBOARD_COLUMNS
    const bColumn = b % CHECKERBOARD_COLUMNS
    const aRow = Math.floor(a / CHECKERBOARD_COLUMNS)
    const bRow = Math.floor(b / CHECKERBOARD_COLUMNS)
    const aScore = (aColumn * 2) + ((aColumn + aRow) % 2)
    const bScore = (bColumn * 2) + ((bColumn + bRow) % 2)
    return aScore - bScore || aRow - bRow
  })
  const rankByIndex = Array(indices.length).fill(0) as number[]
  indices.forEach((index, rank) => {
    rankByIndex[index] = rank
  })
  return rankByIndex
}

function seededCellScore(seed: string, index: number): number {
  let hash = 2166136261
  const value = `${seed}:${index}`
  for (let cursor = 0; cursor < value.length; cursor += 1) {
    hash ^= value.charCodeAt(cursor)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function dissolveOrder(elementId: string): number[] {
  const count = DISSOLVE_COLUMNS * DISSOLVE_ROWS
  const indices = Array.from({ length: count }, (_, index) => index)
  indices.sort((a, b) => seededCellScore(elementId, a) - seededCellScore(elementId, b))
  const rankByIndex = Array(count).fill(0) as number[]
  indices.forEach((index, rank) => {
    rankByIndex[index] = rank
  })
  return rankByIndex
}

function animationColorElement(animation: NormalizedPresentationAnimation, element: PresentationElement): PresentationElement {
  if (animation.effect === 'fillColor' && isPresentationShapeElement(element)) {
    return { ...element, fill: animation.color }
  }
  if (animation.effect === 'textColor' && isPresentationTextElement(element)) {
    return patchPresentationText(element, { color: animation.color })
  }
  return element
}

/** Convert one timeline entry into independent DOM animation layers. */
export function createPresentationAnimationParts(entry: PresentationAnimationTimelineEntry, pageSize: PresentationPageSize = PRESENTATION_PAGE_SIZES.wide): PresentationAnimationPartSpec[] {
  const { animation, bounds, element, elements } = entry
  switch (animation.effect) {
    case 'appear':
      return [{
        id: 'appear',
        element,
        elements,
        keyframes: [{ opacity: 0 }, { opacity: 1 }],
        options: animationOptions(entry),
      }]
    case 'fade':
      return [{
        id: 'fade',
        element,
        elements,
        keyframes: [{ opacity: 0 }, { opacity: 1 }],
        options: animationOptions(entry),
      }]
    case 'blinds': {
      const bandHeight = bounds.height / BLIND_COUNT
      return Array.from({ length: BLIND_COUNT }, (_, index) => ({
        id: `blind-${index}`,
        element,
        elements,
        keyframes: [
          { clipPath: clipInset(bounds.x, bounds.y + (index * bandHeight), 0, bandHeight + 0.5, pageSize) },
          { clipPath: clipInset(bounds.x, bounds.y + (index * bandHeight), bounds.width, bandHeight + 0.5, pageSize) },
        ],
        options: animationOptions(entry),
      }))
    }
    case 'checkerboard':
      return cellParts(entry, CHECKERBOARD_COLUMNS, CHECKERBOARD_ROWS, checkerboardOrder(), 'checker', pageSize)
    case 'dissolve':
      return cellParts(entry, DISSOLVE_COLUMNS, DISSOLVE_ROWS, dissolveOrder(entry.id), 'dissolve', pageSize)
    case 'flyIn': {
      const distance = Math.max(24, pageSize.height - bounds.y + 24)
      return [{
        id: 'fly-in',
        element,
        elements,
        keyframes: [
          { transform: `translate3d(0, ${cssNumber(distance)}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        options: animationOptions(entry, { easing: MOTION_EASING }),
      }]
    }
    case 'floatIn':
      return [{
        id: 'float-in',
        element,
        elements,
        keyframes: [
          { opacity: 0, transform: 'translate3d(0, 48px, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
        ],
        options: animationOptions(entry, { easing: MOTION_EASING }),
      }]
    case 'split': {
      const halfWidth = bounds.width / 2
      return [
        {
          id: 'split-left',
          element,
          elements,
          keyframes: [
            { clipPath: clipInset(bounds.x + halfWidth, bounds.y, 0, bounds.height, pageSize) },
            { clipPath: clipInset(bounds.x, bounds.y, halfWidth + 0.5, bounds.height, pageSize) },
          ],
          options: animationOptions(entry, { easing: MOTION_EASING }),
        },
        {
          id: 'split-right',
          element,
          elements,
          keyframes: [
            { clipPath: clipInset(bounds.x + halfWidth, bounds.y, 0, bounds.height, pageSize) },
            { clipPath: clipInset(bounds.x + halfWidth, bounds.y, halfWidth + 0.5, bounds.height, pageSize) },
          ],
          options: animationOptions(entry, { easing: MOTION_EASING }),
        },
      ]
    }
    case 'wipeIn':
      return [{
        id: 'wipe-in',
        element,
        elements,
        keyframes: [
          { clipPath: clipInset(bounds.x, bounds.y, 0, bounds.height, pageSize) },
          { clipPath: clipInset(bounds.x, bounds.y, bounds.width, bounds.height, pageSize) },
        ],
        options: animationOptions(entry, { easing: MOTION_EASING }),
      }]
    case 'zoomIn': {
      const centerX = bounds.x + (bounds.width / 2)
      const centerY = bounds.y + (bounds.height / 2)
      const transformOrigin = `${cssNumber(centerX)}px ${cssNumber(centerY)}px`
      return [{
        id: 'zoom-in',
        element,
        elements,
        keyframes: [
          { opacity: 0, transform: 'scale(0.2)', transformOrigin },
          { opacity: 1, transform: 'scale(1)', transformOrigin },
        ],
        options: animationOptions(entry, { easing: MOTION_EASING }),
      }]
    }
    case 'zoom': {
      const centerX = bounds.x + (bounds.width / 2)
      const centerY = bounds.y + (bounds.height / 2)
      const transformOrigin = `${cssNumber(centerX)}px ${cssNumber(centerY)}px`
      return [{
        id: 'grow-shrink',
        element,
        elements,
        keyframes: [
          { transform: 'scale(1)', transformOrigin },
          { transform: `scale(${EMPHASIS_SCALE})`, transformOrigin },
        ],
        options: animationOptions(entry, { easing: EMPHASIS_EASING }),
      }]
    }
    case 'disappear':
      return [{
        id: 'disappear',
        element,
        elements,
        keyframes: [{ opacity: 1 }, { opacity: 0 }],
        options: animationOptions(entry),
      }]
    case 'blindsOut': {
      const bandHeight = bounds.height / BLIND_COUNT
      return Array.from({ length: BLIND_COUNT }, (_, index) => ({
        id: `blind-out-${index}`,
        element,
        elements,
        keyframes: [
          { clipPath: clipInset(bounds.x, bounds.y + (index * bandHeight), bounds.width, bandHeight + 0.5, pageSize) },
          { clipPath: clipInset(bounds.x + bounds.width, bounds.y + (index * bandHeight), 0, bandHeight + 0.5, pageSize) },
        ],
        options: animationOptions(entry),
      }))
    }
    default:
      return []
  }
}
