import type {
  PresentationTransition,
  PresentationTransitionDirection,
  PresentationTransitionEffect,
} from '@/atoms/presentation'

export const DEFAULT_PRESENTATION_TRANSITION_DURATION_MS = 500
export const MIN_PRESENTATION_TRANSITION_DURATION_MS = 100
export const MAX_PRESENTATION_TRANSITION_DURATION_MS = 20_000

export interface PresentationTransitionDefinition {
  effect: PresentationTransitionEffect
  labelKey: string
  directions: readonly PresentationTransitionDirection[]
  defaultDirection?: PresentationTransitionDirection
  supportsThroughBlack?: boolean
}

const CARDINAL_DIRECTIONS = ['left', 'right', 'up', 'down'] as const
const HORIZONTAL_DIRECTIONS = ['left', 'right'] as const
const ZOOM_DIRECTIONS = ['in', 'out'] as const
const NONE_TRANSITION_DEFINITION: PresentationTransitionDefinition = {
  effect: 'none',
  labelKey: 'session.presentation.effectNone',
  directions: [],
}

export const presentationTransitionDefinitions: readonly PresentationTransitionDefinition[] = [
  NONE_TRANSITION_DEFINITION,
  { effect: 'cut', labelKey: 'session.presentation.effectCut', directions: [], supportsThroughBlack: true },
  { effect: 'fade', labelKey: 'session.presentation.effectFadeThrough', directions: [], supportsThroughBlack: true },
  { effect: 'push', labelKey: 'session.presentation.effectPush', directions: CARDINAL_DIRECTIONS, defaultDirection: 'left' },
  { effect: 'wipe', labelKey: 'session.presentation.effectWipe', directions: CARDINAL_DIRECTIONS, defaultDirection: 'left' },
  { effect: 'reveal', labelKey: 'session.presentation.effectReveal', directions: HORIZONTAL_DIRECTIONS, defaultDirection: 'left', supportsThroughBlack: true },
  { effect: 'cover', labelKey: 'session.presentation.effectCover', directions: CARDINAL_DIRECTIONS, defaultDirection: 'left' },
  { effect: 'zoom', labelKey: 'session.presentation.effectZoom', directions: ZOOM_DIRECTIONS, defaultDirection: 'in' },
  { effect: 'flip', labelKey: 'session.presentation.effectFlip', directions: HORIZONTAL_DIRECTIONS, defaultDirection: 'left' },
  { effect: 'cube', labelKey: 'session.presentation.effectCube', directions: CARDINAL_DIRECTIONS, defaultDirection: 'left' },
]

const presentationTransitionDefinitionMap = new Map<PresentationTransitionEffect, PresentationTransitionDefinition>(
  presentationTransitionDefinitions.map((definition) => [definition.effect, definition] as const),
)
const presentationTransitionEffects = new Set<PresentationTransitionEffect>(
  presentationTransitionDefinitions.map((definition) => definition.effect),
)

export type PresentationTransitionInput = Partial<PresentationTransition> | PresentationTransitionEffect | null | undefined

export function getPresentationTransitionDefinition(effect: PresentationTransitionEffect): PresentationTransitionDefinition {
  return presentationTransitionDefinitionMap.get(effect) ?? NONE_TRANSITION_DEFINITION
}

export function createDefaultPresentationTransition(): PresentationTransition {
  return {
    effect: 'none',
    durationMs: DEFAULT_PRESENTATION_TRANSITION_DURATION_MS,
  }
}

export function normalizePresentationTransition(value: PresentationTransitionInput): PresentationTransition {
  const candidate = typeof value === 'string' ? { effect: value } : value
  const effect = candidate?.effect && presentationTransitionEffects.has(candidate.effect)
    ? candidate.effect
    : 'none'
  const definition = getPresentationTransitionDefinition(effect)
  const requestedDuration = candidate?.durationMs
  const durationMs = typeof requestedDuration === 'number' && Number.isFinite(requestedDuration)
    ? Math.round(Math.min(MAX_PRESENTATION_TRANSITION_DURATION_MS, Math.max(MIN_PRESENTATION_TRANSITION_DURATION_MS, requestedDuration)))
    : DEFAULT_PRESENTATION_TRANSITION_DURATION_MS
  const direction = candidate?.direction && definition.directions.includes(candidate.direction)
    ? candidate.direction
    : definition.defaultDirection

  return {
    effect,
    durationMs,
    ...(direction ? { direction } : {}),
    ...(definition.supportsThroughBlack && candidate?.throughBlack === true ? { throughBlack: true } : {}),
  }
}

export function changePresentationTransitionEffect(value: PresentationTransitionInput, effect: PresentationTransitionEffect): PresentationTransition {
  const current = normalizePresentationTransition(value)
  const definition = getPresentationTransitionDefinition(effect)
  const direction = current.direction && definition.directions.includes(current.direction)
    ? current.direction
    : definition.defaultDirection

  return {
    effect,
    durationMs: current.durationMs,
    ...(direction ? { direction } : {}),
    ...(definition.supportsThroughBlack && current.throughBlack === true ? { throughBlack: true } : {}),
  }
}
