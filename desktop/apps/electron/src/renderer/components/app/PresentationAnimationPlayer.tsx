import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties } from 'react'
import {
  PRESENTATION_PAGE_SIZES,
  type PresentationPageSize,
  type PresentationSlide,
} from '@/atoms/presentation'
import {
  buildPresentationAnimationTimeline,
  createPresentationAnimationParts,
  PRESENTATION_ANIMATION_FINAL_HOLD_MS,
  type PresentationAnimationPartSpec,
} from '@/lib/presentationAnimationPreview'
import { cn } from '@/lib/cn'
import {
  PresentationElementPreview,
  PresentationSlidePreview,
} from './PresentationSlidePreview'

export interface PresentationAnimationPlayerProps {
  baseHiddenElementIds?: ReadonlySet<string>
  className?: string
  elementIds?: readonly string[]
  onComplete?: () => void
  runKey: string | number
  pageSize?: PresentationPageSize
  slide: PresentationSlide
  slideNumber?: number
  width: number
}

const partLayerStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  pointerEvents: 'none',
  willChange: 'transform, opacity, clip-path',
}

function applyFinalKeyframe(node: HTMLSpanElement, keyframes: Keyframe[]): void {
  const final = keyframes.at(-1)
  if (!final) return
  if (final.opacity !== undefined) node.style.opacity = String(final.opacity)
  if (final.transform !== undefined) node.style.transform = String(final.transform)
  if (final.transformOrigin !== undefined) node.style.transformOrigin = String(final.transformOrigin)
  if (final.clipPath !== undefined) node.style.clipPath = String(final.clipPath)
}

function PresentationAnimationPart({ pageSize, part, runKey }: { pageSize: PresentationPageSize; part: PresentationAnimationPartSpec; runKey: string | number }) {
  const layerRef = useRef<HTMLSpanElement>(null)

  useLayoutEffect(() => {
    const layer = layerRef.current
    if (!layer || part.keyframes.length === 0) return
    if (typeof layer.animate !== 'function') {
      applyFinalKeyframe(layer, part.keyframes)
      return
    }
    let animation: Animation | undefined
    try {
      animation = layer.animate(part.keyframes, part.options)
    } catch {
      applyFinalKeyframe(layer, part.keyframes)
    }
    return () => animation?.cancel()
  }, [part, runKey])

  return (
    <span
      ref={layerRef}
      aria-hidden="true"
      data-animation-part={part.id}
      style={{ ...partLayerStyle, width: pageSize.width, height: pageSize.height, ...part.style }}
    >
      {part.elements.map((element) => (
        <span key={element.id} data-animation-element-id={element.id}>
          <PresentationElementPreview element={element} interactive={false} suppressMediaPlayback />
        </span>
      ))}
    </span>
  )
}

/** PowerPoint-style element animation preview rendered independently from the editable Fabric canvas. */
export function PresentationAnimationPlayer({ baseHiddenElementIds, className, elementIds, onComplete, pageSize = PRESENTATION_PAGE_SIZES.wide, runKey, slide, slideNumber, width }: PresentationAnimationPlayerProps) {
  const requestedIds = useMemo(() => elementIds ? new Set(elementIds) : null, [elementIds])
  const elements = useMemo(() => {
    if (!requestedIds) return slide.elements
    const requestedGroupIds = new Set(slide.elements.flatMap((element) => (
      requestedIds.has(element.id) && element.groupId ? [element.groupId] : []
    )))
    return slide.elements.filter((element) => (
      requestedIds.has(element.id)
      || Boolean(element.groupId && requestedGroupIds.has(element.groupId))
    ))
  }, [requestedIds, slide.elements])
  const timeline = useMemo(() => buildPresentationAnimationTimeline(elements), [elements])
  const parts = useMemo(() => timeline.flatMap((entry) => (
    createPresentationAnimationParts(entry, pageSize).map((part) => ({ ...part, id: `${entry.id}-${part.id}` }))
  )), [pageSize, timeline])
  const hiddenElementIds = useMemo(() => new Set([
    ...(baseHiddenElementIds ?? []),
    ...timeline.flatMap((entry) => entry.elements.map((element) => element.id)),
  ]), [baseHiddenElementIds, timeline])
  const onCompleteRef = useRef(onComplete)
  const totalDuration = timeline.reduce((maximum, entry) => Math.max(maximum, entry.endsAt), 0)
  const scale = width / pageSize.width

  useLayoutEffect(() => {
    onCompleteRef.current = onComplete
  })

  useEffect(() => {
    if (timeline.length === 0) {
      queueMicrotask(() => onCompleteRef.current?.())
      return
    }
    const timer = window.setTimeout(() => onCompleteRef.current?.(), totalDuration + PRESENTATION_ANIMATION_FINAL_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [runKey, timeline.length, totalDuration])

  return (
    <span
      className={cn('relative block overflow-hidden', className)}
      data-testid="presentation-animation-player"
      style={{ width, height: width * (pageSize.height / pageSize.width) }}
    >
      <PresentationSlidePreview
        hiddenElementIds={hiddenElementIds}
        presentation
        selected={false}
        slide={slide}
        slideNumber={slideNumber}
        suppressMediaPlayback
        width={width}
        pageSize={pageSize}
      />
      <span
        className="absolute left-0 top-0 block origin-top-left overflow-hidden"
        style={{ width: pageSize.width, height: pageSize.height, transform: `scale(${scale})` }}
      >
        {parts.map((part) => <PresentationAnimationPart key={part.id} pageSize={pageSize} part={part} runKey={runKey} />)}
      </span>
    </span>
  )
}
