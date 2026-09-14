import type {
  PresentationAnimationEffect,
  PresentationAnimationStart,
  PresentationAnimationTrigger,
  PresentationElement,
} from '@/atoms/presentation'

export const DEFAULT_PRESENTATION_ANIMATION_DURATION_MS = 520
export const DEFAULT_PRESENTATION_ANIMATION_DELAY_MS = 0
export const DEFAULT_PRESENTATION_ANIMATION_COLOR = '#8B7CFF'

export interface NormalizedPresentationAnimation {
  color: string
  delayMs: number
  durationMs: number
  effect: PresentationAnimationEffect
  start: PresentationAnimationStart
  trigger: PresentationAnimationTrigger
}

export const presentationAnimationLabelKeys: Record<PresentationAnimationEffect, string> = {
  none: 'session.presentation.noAnimation',
  appear: 'session.presentation.effectAppear',
  fade: 'session.presentation.effectFade',
  blinds: 'session.presentation.effectBlinds',
  checkerboard: 'session.presentation.effectCheckerboard',
  dissolve: 'session.presentation.effectDissolveIn',
  flyIn: 'session.presentation.effectFlyIn',
  floatIn: 'session.presentation.effectFloatIn',
  split: 'session.presentation.effectSplit',
  wipeIn: 'session.presentation.effectWipe',
  zoomIn: 'session.presentation.effectZoomIn',
  zoom: 'session.presentation.growShrink',
  fillColor: 'session.presentation.fillColor',
  textColor: 'session.presentation.textColor',
  disappear: 'session.presentation.disappear',
  blindsOut: 'session.presentation.effectBlinds',
}

export function normalizePresentationAnimation(element: Pick<PresentationElement, 'animation' | 'animationColor' | 'animationDelay' | 'animationDuration' | 'animationStart' | 'animationTrigger'>): NormalizedPresentationAnimation {
  return {
    effect: element.animation ?? 'none',
    durationMs: Number.isFinite(element.animationDuration) && (element.animationDuration ?? 0) >= 180
      ? Math.round(element.animationDuration!)
      : DEFAULT_PRESENTATION_ANIMATION_DURATION_MS,
    delayMs: Number.isFinite(element.animationDelay) && (element.animationDelay ?? 0) >= 0
      ? Math.round(element.animationDelay!)
      : DEFAULT_PRESENTATION_ANIMATION_DELAY_MS,
    start: element.animationStart ?? 'onClick',
    trigger: element.animationTrigger ?? 'slideClick',
    color: typeof element.animationColor === 'string' && element.animationColor.trim()
      ? element.animationColor
      : DEFAULT_PRESENTATION_ANIMATION_COLOR,
  }
}

export function hasPresentationAnimation(element: PresentationElement | null | undefined): boolean {
  return Boolean(element && normalizePresentationAnimation(element).effect !== 'none')
}

export function copyPresentationAnimationPatch(element: PresentationElement): Partial<PresentationElement> {
  const animation = normalizePresentationAnimation(element)
  return {
    animation: animation.effect,
    animationDuration: animation.durationMs,
    animationDelay: animation.delayMs,
    animationStart: animation.start,
    animationTrigger: animation.trigger,
    animationColor: animation.color,
  }
}

export function clearPresentationAnimation(element: PresentationElement): PresentationElement {
  const {
    animation: _animation,
    animationColor: _animationColor,
    animationDelay: _animationDelay,
    animationDuration: _animationDuration,
    animationStart: _animationStart,
    animationTrigger: _animationTrigger,
    ...rest
  } = element
  return rest as PresentationElement
}
