import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from 'react'
import type { PresentationTransition, PresentationTransitionDirection } from '@/atoms/presentation'

export type PresentationTransitionPlaybackDirection = 'forward' | 'backward'
export type PresentationTransitionPlayerMode = 'playback' | 'preview'

export interface PresentationTransitionPlayerProps {
  previous: ReactNode
  current: ReactNode
  transition: PresentationTransition
  runKey: string | number
  direction?: PresentationTransitionPlaybackDirection
  mode?: PresentationTransitionPlayerMode
  onComplete?: () => void
  className?: string
}

export interface PresentationTransitionAnimationSpec {
  previous: Keyframe[]
  current: Keyframe[]
  options: KeyframeAnimationOptions
  previousZIndex: number
  currentZIndex: number
  immediate: boolean
}

interface MovementVector {
  x: -1 | 0 | 1
  y: -1 | 0 | 1
}

const DEFAULT_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)'
const CUT_PREVIEW_DURATION_MS = 180
const CUT_PREVIEW_SWITCH_OFFSET = 0.7

function getMovementVector(direction: PresentationTransitionDirection | undefined, playbackDirection: PresentationTransitionPlaybackDirection): MovementVector {
  // Cardinal directions identify the edge the incoming slide starts from, matching
  // PowerPoint's "From left/right/top/bottom" effect options. The vector is the
  // outgoing slide's movement, so it points away from that incoming edge.
  let vector: MovementVector
  switch (direction) {
    case 'right':
      vector = { x: -1, y: 0 }
      break
    case 'up':
      vector = { x: 0, y: 1 }
      break
    case 'down':
      vector = { x: 0, y: -1 }
      break
    default:
      vector = { x: 1, y: 0 }
  }

  return playbackDirection === 'backward'
    ? { x: -vector.x as MovementVector['x'], y: -vector.y as MovementVector['y'] }
    : vector
}

function translate(vector: MovementVector, multiplier: number): string {
  return `translate3d(${vector.x * multiplier}%, ${vector.y * multiplier}%, 0)`
}

function getWipeStart(vector: MovementVector): string {
  if (vector.x < 0) return 'inset(0 0 0 100%)'
  if (vector.x > 0) return 'inset(0 100% 0 0)'
  if (vector.y < 0) return 'inset(100% 0 0 0)'
  return 'inset(0 0 100% 0)'
}

function getRotation(vector: MovementVector): { property: 'rotateX' | 'rotateY'; degrees: number } {
  if (vector.x !== 0) return { property: 'rotateY', degrees: vector.x * 90 }
  return { property: 'rotateX', degrees: vector.y * -90 }
}

function getTransformOrigin(vector: MovementVector, incoming: boolean): string {
  if (vector.x < 0) return incoming ? 'left center' : 'right center'
  if (vector.x > 0) return incoming ? 'right center' : 'left center'
  if (vector.y < 0) return incoming ? 'center top' : 'center bottom'
  return incoming ? 'center bottom' : 'center top'
}

/**
 * Build the Web Animations keyframes used by both editor preview and slideshow playback.
 * The navigation direction reverses spatial effects when the user moves to a previous slide.
 */
export function createPresentationTransitionKeyframes(transition: PresentationTransition, playbackDirection: PresentationTransitionPlaybackDirection = 'forward', mode: PresentationTransitionPlayerMode = 'playback'): PresentationTransitionAnimationSpec {
  const duration = Number.isFinite(transition.durationMs) ? Math.max(0, transition.durationMs) : 0
  const base = {
    previous: [] as Keyframe[],
    current: [] as Keyframe[],
    options: { duration, easing: DEFAULT_EASING, fill: 'both' } satisfies KeyframeAnimationOptions,
    previousZIndex: 1,
    currentZIndex: 2,
    immediate: duration === 0,
  }

  if (transition.effect === 'none') {
    return { ...base, immediate: true }
  }

  if (transition.effect === 'cut') {
    if (!transition.throughBlack) {
      if (mode !== 'preview') return { ...base, immediate: true }
      return {
        ...base,
        previous: [
          { opacity: 1, offset: 0 },
          { opacity: 1, offset: CUT_PREVIEW_SWITCH_OFFSET },
          { opacity: 0, offset: CUT_PREVIEW_SWITCH_OFFSET },
          { opacity: 0, offset: 1 },
        ],
        current: [
          { opacity: 0, offset: 0 },
          { opacity: 0, offset: CUT_PREVIEW_SWITCH_OFFSET },
          { opacity: 1, offset: CUT_PREVIEW_SWITCH_OFFSET },
          { opacity: 1, offset: 1 },
        ],
        options: { ...base.options, duration: CUT_PREVIEW_DURATION_MS, easing: 'linear' },
        immediate: false,
      }
    }
    return {
      ...base,
      previous: [
        { opacity: 1, offset: 0 },
        { opacity: 1, offset: 0.44 },
        { opacity: 0, offset: 0.45 },
        { opacity: 0, offset: 1 },
      ],
      current: [
        { opacity: 0, offset: 0 },
        { opacity: 0, offset: 0.55 },
        { opacity: 1, offset: 0.56 },
        { opacity: 1, offset: 1 },
      ],
      options: { ...base.options, easing: 'linear' },
    }
  }

  if (transition.effect === 'fade') {
    return {
      ...base,
      previous: transition.throughBlack
        ? [{ opacity: 1, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 0, offset: 1 }]
        : [{ opacity: 1 }, { opacity: 0 }],
      current: transition.throughBlack
        ? [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 1 }]
        : [{ opacity: 0 }, { opacity: 1 }],
      options: { ...base.options, easing: 'linear' },
    }
  }

  if (transition.effect === 'zoom') {
    const zoomsIn = (transition.direction !== 'out') !== (playbackDirection === 'backward')
    return {
      ...base,
      previous: zoomsIn
        ? [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(1.12)' }]
        : [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(0.82)' }],
      current: zoomsIn
        ? [{ opacity: 0.15, transform: 'scale(0.72)' }, { opacity: 1, transform: 'scale(1)' }]
        : [{ opacity: 0.15, transform: 'scale(1.18)' }, { opacity: 1, transform: 'scale(1)' }],
    }
  }

  const vector = getMovementVector(transition.direction, playbackDirection)
  const incomingStart = { x: -vector.x as MovementVector['x'], y: -vector.y as MovementVector['y'] }

  if (transition.effect === 'push') {
    return {
      ...base,
      previous: [{ transform: 'translate3d(0, 0, 0)' }, { transform: translate(vector, 100) }],
      current: [{ transform: translate(incomingStart, 100) }, { transform: 'translate3d(0, 0, 0)' }],
    }
  }

  if (transition.effect === 'wipe') {
    return {
      ...base,
      current: [{ clipPath: getWipeStart(vector) }, { clipPath: 'inset(0 0 0 0)' }],
    }
  }

  if (transition.effect === 'cover') {
    return {
      ...base,
      current: [{ transform: translate(incomingStart, 100) }, { transform: 'translate3d(0, 0, 0)' }],
    }
  }

  if (transition.effect === 'reveal') {
    if (transition.throughBlack) {
      return {
        ...base,
        previous: [
          { transform: 'translate3d(0, 0, 0)', offset: 0 },
          { transform: translate(vector, 100), offset: 0.45 },
          { transform: translate(vector, 100), offset: 1 },
        ],
        current: [
          { opacity: 0, offset: 0 },
          { opacity: 0, offset: 0.55 },
          { opacity: 1, offset: 0.56 },
          { opacity: 1, offset: 1 },
        ],
        previousZIndex: 3,
      }
    }
    return {
      ...base,
      previous: [{ transform: 'translate3d(0, 0, 0)' }, { transform: translate(vector, 100) }],
      previousZIndex: 3,
    }
  }

  const rotation = getRotation(vector)
  const previousRotation = `${rotation.property}(${rotation.degrees}deg)`
  const currentRotation = `${rotation.property}(${-rotation.degrees}deg)`

  if (transition.effect === 'flip') {
    return {
      ...base,
      previous: [
        { opacity: 1, transform: 'perspective(1200px) rotateX(0deg) rotateY(0deg)', backfaceVisibility: 'hidden' },
        { opacity: 0, transform: `perspective(1200px) ${previousRotation}`, backfaceVisibility: 'hidden' },
      ],
      current: [
        { opacity: 0, transform: `perspective(1200px) ${currentRotation}`, backfaceVisibility: 'hidden' },
        { opacity: 1, transform: 'perspective(1200px) rotateX(0deg) rotateY(0deg)', backfaceVisibility: 'hidden' },
      ],
    }
  }

  return {
    ...base,
    previous: [
      {
        transform: 'perspective(1200px) translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg)',
        transformOrigin: getTransformOrigin(vector, false),
        backfaceVisibility: 'hidden',
      },
      {
        transform: `perspective(1200px) ${translate(vector, 50)} ${previousRotation}`,
        transformOrigin: getTransformOrigin(vector, false),
        backfaceVisibility: 'hidden',
      },
    ],
    current: [
      {
        transform: `perspective(1200px) ${translate(incomingStart, 50)} ${currentRotation}`,
        transformOrigin: getTransformOrigin(vector, true),
        backfaceVisibility: 'hidden',
      },
      {
        transform: 'perspective(1200px) translate3d(0, 0, 0) rotateX(0deg) rotateY(0deg)',
        transformOrigin: getTransformOrigin(vector, true),
        backfaceVisibility: 'hidden',
      },
    ],
  }
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

const layerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  overflow: 'hidden',
  willChange: 'transform, opacity, clip-path',
}

export function PresentationTransitionPlayer({ previous, current, transition, runKey, direction = 'forward', mode = 'playback', onComplete, className }: PresentationTransitionPlayerProps) {
  const previousRef = useRef<HTMLDivElement>(null)
  const currentRef = useRef<HTMLDivElement>(null)
  const animationsRef = useRef<Animation[]>([])
  const playbackRef = useRef({ transition, direction, mode })
  const onCompleteRef = useRef(onComplete)
  const generationRef = useRef(0)

  useLayoutEffect(() => {
    playbackRef.current = { transition, direction, mode }
    onCompleteRef.current = onComplete
  })

  useLayoutEffect(() => {
    const generation = ++generationRef.current
    const previousLayer = previousRef.current
    const currentLayer = currentRef.current
    let active = true
    let completed = false
    let fallbackTimer: number | undefined

    for (const animation of animationsRef.current) animation.cancel()
    animationsRef.current = []
    if (previousLayer) {
      previousLayer.style.visibility = 'hidden'
      previousLayer.style.zIndex = '1'
    }
    if (currentLayer) currentLayer.style.zIndex = '2'

    const complete = () => {
      if (!active || completed || generation !== generationRef.current) return
      completed = true
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
      if (previousLayer) previousLayer.style.visibility = 'hidden'
      onCompleteRef.current?.()
    }

    const spec = createPresentationTransitionKeyframes(playbackRef.current.transition, playbackRef.current.direction, playbackRef.current.mode)
    const canAnimate = currentLayer && typeof currentLayer.animate === 'function'
    if (spec.immediate || prefersReducedMotion() || !canAnimate) {
      queueMicrotask(complete)
      return () => {
        active = false
      }
    }

    if (previousLayer) {
      previousLayer.style.visibility = 'visible'
      previousLayer.style.zIndex = String(spec.previousZIndex)
    }
    currentLayer.style.zIndex = String(spec.currentZIndex)

    const animations: Animation[] = []
    let animationStartFailed = false
    try {
      if (previousLayer && spec.previous.length > 0) animations.push(previousLayer.animate(spec.previous, spec.options))
      if (spec.current.length > 0) animations.push(currentLayer.animate(spec.current, spec.options))
    } catch {
      for (const animation of animations) animation.cancel()
      animations.length = 0
      animationStartFailed = true
    }
    animationsRef.current = animations

    if (animationStartFailed || animations.length === 0) {
      queueMicrotask(complete)
    } else {
      fallbackTimer = window.setTimeout(complete, spec.options.duration as number + 100)
      void Promise.all(animations.map(async (animation) => {
        try {
          await animation.finished
        } catch {
          // Cancellation is expected when a newer run starts or the player unmounts.
        }
      })).then(complete)
    }

    return () => {
      active = false
      if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer)
      for (const animation of animations) animation.cancel()
      if (animationsRef.current === animations) animationsRef.current = []
      if (previousLayer) {
        previousLayer.style.visibility = 'hidden'
        previousLayer.style.zIndex = '1'
      }
      currentLayer.style.zIndex = '2'
    }
  }, [runKey])

  return (
    <div
      className={className}
      data-testid="presentation-transition-player"
      style={{
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        isolation: 'isolate',
        backgroundColor: transition.throughBlack ? '#000000' : undefined,
      }}
    >
      <div
        ref={previousRef}
        aria-hidden="true"
        data-testid="presentation-transition-previous"
        style={{ ...layerStyle, zIndex: 1, visibility: 'hidden', pointerEvents: 'none' }}
      >
        {previous}
      </div>
      <div ref={currentRef} data-testid="presentation-transition-current" style={{ ...layerStyle, zIndex: 2 }}>
        {current}
      </div>
    </div>
  )
}
