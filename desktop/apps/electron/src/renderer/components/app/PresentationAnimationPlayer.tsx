import { useEffect, useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from 'react'
import {
  PRESENTATION_PAGE_SIZES,
  type PresentationElement,
  type PresentationHyperlink,
  type PresentationPageSize,
  type PresentationSlide,
} from '@/atoms/presentation'
import {
  buildPresentationAnimationTimeline,
  createPresentationAnimationParts,
  getPresentationAnimationDisplayStates,
  getPresentationColorAnimations,
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
  completedTargetIds?: ReadonlySet<string>
  className?: string
  elementIds?: readonly string[]
  onComplete?: () => void
  onActivateHyperlink?: (hyperlink: PresentationHyperlink) => void
  suppressMediaPlayback?: boolean
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

function PresentationAnimationPart({ elements, pageSize, part, runKey }: { elements: readonly PresentationElement[]; pageSize: PresentationPageSize; part: PresentationAnimationPartSpec; runKey: string | number }) {
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
      {elements.map((element) => (
        <span key={element.id} data-animation-element-id={element.id}>
          <PresentationElementPreview element={element} interactive={false} suppressMediaPlayback />
        </span>
      ))}
    </span>
  )
}

/** PowerPoint-style element animation preview rendered independently from the editable Fabric canvas. */
export function PresentationAnimationPlayer({ baseHiddenElementIds, completedTargetIds, className, elementIds, onComplete, onActivateHyperlink, suppressMediaPlayback = true, pageSize = PRESENTATION_PAGE_SIZES.wide, runKey, slide, slideNumber, width }: PresentationAnimationPlayerProps) {
  const animationStates = useMemo(() => completedTargetIds ? getPresentationAnimationDisplayStates(slide.elements, completedTargetIds) : undefined, [completedTargetIds, slide.elements])
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
  const colorAnimations = useMemo(() => getPresentationColorAnimations(timeline, runKey), [runKey, timeline])
  const elementReplacements = useMemo(() => {
    const partsByElementId = new Map<string, PresentationAnimationPartSpec[]>()
    for (const entry of timeline) {
      const parts = createPresentationAnimationParts(entry, pageSize).map(part => ({ ...part, id: `${entry.id}-${part.id}` }))
      if (!parts.length) continue
      for (const element of entry.elements) partsByElementId.set(element.id, parts)
    }
    const replacements = new Map<string, ReactNode>()
    // Share a layer for adjacent group members, while keeping interleaved objects in their authored order.
    for (let index = 0; index < slide.elements.length; index++) {
      const element = slide.elements[index]!
      const parts = partsByElementId.get(element.id)
      if (!parts) continue
      let end = index + 1
      while (end < slide.elements.length && partsByElementId.get(slide.elements[end]!.id) === parts) end++
      const members = slide.elements.slice(index, end)
      for (const member of members) replacements.set(member.id, null)
      replacements.set(element.id, parts.map(part => (
        <PresentationAnimationPart key={part.id} elements={members} pageSize={pageSize} part={part} runKey={runKey} />
      )))
      index = end - 1
    }
    return replacements
  }, [pageSize, runKey, slide.elements, timeline])
  const onCompleteRef = useRef(onComplete)
  const totalDuration = timeline.reduce((maximum, entry) => Math.max(maximum, entry.endsAt), 0)

  useLayoutEffect(() => {
    onCompleteRef.current = onComplete
  })

  useEffect(() => {
    if (timeline.length === 0) {
      let cancelled = false
      queueMicrotask(() => { if (!cancelled) onCompleteRef.current?.() })
      return () => { cancelled = true }
    }
    const timer = window.setTimeout(() => onCompleteRef.current?.(), totalDuration + PRESENTATION_ANIMATION_FINAL_HOLD_MS)
    return () => window.clearTimeout(timer)
  }, [runKey, timeline.length, totalDuration])

  return (
    <span
      className={cn('relative block overflow-hidden', className)}
      data-testid={timeline.length ? 'presentation-animation-player' : undefined}
      style={{ width, height: width * (pageSize.height / pageSize.width) }}
    >
      <PresentationSlidePreview
        animationStates={animationStates}
        colorAnimations={colorAnimations}
        hiddenElementIds={baseHiddenElementIds}
        elementReplacements={elementReplacements}
        presentation
        selected={false}
        slide={slide}
        slideNumber={slideNumber}
        suppressMediaPlayback={suppressMediaPlayback}
        onActivateHyperlink={onActivateHyperlink}
        width={width}
        pageSize={pageSize}
      />
    </span>
  )
}
