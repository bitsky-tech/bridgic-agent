import { presentationChartValueTicks, presentationChartHoleSize, presentationChartValue, presentationChartLineSegments, presentationLineLabelY, presentationPieLabels } from '@/lib/presentationCharts'
import { Fragment, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Pause, Play } from 'lucide-react'
import {
  PRESENTATION_PAGE_SIZES,
  layoutPresentationVerticalText,
  type PresentationChartElement,
  type PresentationChartSeries,
  type PresentationElement,
  type PresentationHyperlink,
  type PresentationPageSize,
  type PresentationShapeElement,
  type PresentationSlide,
  type PresentationTableElement,
  type PresentationTextElement,
  type PresentationTextStyle,
} from '@/atoms/presentation'
import { cn } from '@/lib/cn'
import type { PresentationAnimationDisplayState, PresentationAnimationScale, PresentationColorAnimation } from '@/lib/presentationAnimationPreview'
import {
  isPresentationChartElement,
  isPresentationImageElement,
  isPresentationMediaElement,
  isPresentationShapeElement,
  isPresentationTableElement,
  isPresentationTextElement,
  supportsPresentationElementHyperlink,
} from '@/lib/presentationInsert'
import { getPresentationShapePath, getPresentationShapeDefinition, isPresentationLineShape } from '@/lib/presentationShapes'
import {
  PRESENTATION_TEXT_LINE_METRICS,
  presentationRenderingFontFamily,
  presentationScriptMetrics,
  presentationTextFrame,
  presentationTextParagraphs,
  presentationParagraphSegments,
  presentationParagraphTextStyle,
  presentationTextStyleAt,
} from '@/lib/presentationText'

/** Trim CSS leading at frame edges without discarding the authored advance between lines. */
function PresentationParagraphPreview({ element, paragraph, paragraphIndex, inlineStyle }: {
  element: PresentationTextElement
  paragraph: ReturnType<typeof presentationTextParagraphs>[number]
  paragraphIndex: number
  inlineStyle: (offset: number, spacing?: number, resolvedStyle?: PresentationTextStyle) => CSSProperties
}) {
  const contentRef = useRef<HTMLSpanElement>(null)
  const { style } = paragraph
  const fixed = style.lineSpacing
  const ratio = style.lineHeight ?? 1.08
  const last = paragraph.end === element.text.length
  const paragraphTextStyle = presentationParagraphTextStyle(element, paragraph)
  const fontSize = paragraphTextStyle.fontSize ?? element.fontSize
  useLayoutEffect(() => {
    const content = contentRef.current
    if (!content) return
    const trim = () => {
      const probes = Array.from(content.querySelectorAll<HTMLElement>('[data-line-probe]'))
      if (probes.length !== 6 || !content.offsetHeight) return
      const measureNatural = (target: HTMLElement) => {
        const previous = target.getAttribute('style')
        target.style.fontSize = '0px'
        target.style.lineHeight = '0'
        target.style.setProperty('--ppt-run-line-height', String(PRESENTATION_TEXT_LINE_METRICS.height))
        const markers = Array.from(target.querySelectorAll<HTMLElement>('[data-line-probe]'))
        const heights = [markers[2]!.offsetTop - markers[0]!.offsetTop, markers[5]!.offsetTop - markers[3]!.offsetTop]
        if (previous === null) target.removeAttribute('style')
        else target.setAttribute('style', previous)
        return heights
      }
      const natural = fixed ? measureNatural(content) : undefined
      const [firstTop, firstBaseline, firstBottom, lastTop, lastBaseline, lastBottom] = probes.map(probe => probe.offsetTop)
      const firstNatural = natural?.[0] ?? (firstBottom! - firstTop!) / ratio
      const lastNatural = natural?.[1] ?? (lastBottom! - lastTop!) / ratio
      const ascent = 1 - PRESENTATION_TEXT_LINE_METRICS.descent
      const next = content.parentElement?.nextElementSibling?.firstElementChild as HTMLElement | null
      const tail = fixed && next
        ? fixed - measureNatural(next)[0]! * ascent
        : lastNatural * ((last ? 1 : ratio) - ascent)
      const marginTop = firstNatural * ascent - firstBaseline!
      const marginBottom = lastBaseline! + tail - content.offsetHeight
      content.style.marginTop = `${marginTop}px`
      content.style.marginBottom = `${marginBottom}px`
      // Flex item heights cannot be negative. Carry a backwards advance between paragraphs outside the item.
      content.parentElement!.style.marginBottom = `${Math.min(0, content.offsetHeight + marginTop + marginBottom)}px`
    }
    trim()
    let width = content.offsetWidth
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (content.offsetWidth === width) return
      width = content.offsetWidth
      trim()
    })
    observer?.observe(content)
    document.fonts?.addEventListener('loadingdone', trim)
    return () => { observer?.disconnect(); document.fonts?.removeEventListener('loadingdone', trim) }
  }, [element, paragraphIndex, fixed, ratio, last])
  const probes = () => ['top', 'baseline', 'bottom'].map(align => (
    <span key={align} aria-hidden="true" data-line-probe={align} style={{ display: 'inline-block', width: 0, height: 0, fontSize: 0, lineHeight: 0, verticalAlign: align }} />
  ))
  const lineHeight = ratio * PRESENTATION_TEXT_LINE_METRICS.height
  const leading = fixed ? fixed - fontSize : fontSize * (lineHeight - PRESENTATION_TEXT_LINE_METRICS.height)
  return (
    <span data-testid="presentation-text-paragraph" className="flex shrink-0 flex-col" style={{
      textAlign: style.align, fontSize: fixed ? fontSize : 0,
      lineHeight: fixed ? `${fixed}px` : 0,
      paddingTop: style.spaceBefore ?? 0, paddingBottom: style.spaceAfter ?? 0,
      paddingLeft: (style.indentLevel ?? 0) * 16,
    }}>
      <span ref={contentRef} className="relative block w-full shrink-0" style={{ '--ppt-run-line-height': fixed ? 0 : lineHeight, marginTop: -leading / 2, marginBottom: (last ? -1 : 1) * leading / 2 } as CSSProperties}>
        {probes()}
        {paragraph.text ? presentationParagraphSegments(element, paragraph, paragraphIndex).map((segment, index) => {
          const paint = inlineStyle(segment.start, fixed ?? 0)
          return (
            <span key={index} data-presentation-text-color={paint.color} data-presentation-color-opacity={segment.style.opacity} style={{ ...paint, lineHeight: 'var(--ppt-run-line-height)',
              ...(segment.start === segment.end && segment.style.fontFamily ? { fontFamily: presentationRenderingFontFamily(segment.style.fontFamily, segment.text) } : {}),
            }}>{segment.text}</span>
          )
        }) : <span data-presentation-text-color={inlineStyle(paragraph.start, fixed ?? 0, paragraphTextStyle).color} data-presentation-color-opacity={paragraphTextStyle.opacity} style={{ ...inlineStyle(paragraph.start, fixed ?? 0, paragraphTextStyle), lineHeight: 'var(--ppt-run-line-height)' }}>{'\u200b'}</span>}
        {probes()}
      </span>
    </span>
  )
}

interface PresentationSlidePreviewProps {
  animationStates?: ReadonlyMap<string, PresentationAnimationDisplayState>
  colorAnimations?: ReadonlyMap<string, PresentationColorAnimation>
  hiddenElementIds?: ReadonlySet<string>
  elementReplacements?: ReadonlyMap<string, ReactNode>
  slide: PresentationSlide
  slideNumber?: number
  width: number
  selected: boolean
  presentation?: boolean
  suppressMediaPlayback?: boolean
  onActivateHyperlink?: (hyperlink: PresentationHyperlink) => void
  pageSize?: PresentationPageSize
}

/** Shared static renderer used by thumbnails, transition previews and slide show playback. */
export function PresentationSlidePreview({
  animationStates,
  colorAnimations,
  hiddenElementIds,
  elementReplacements,
  slide,
  slideNumber,
  width,
  selected,
  presentation = false,
  suppressMediaPlayback = false,
  onActivateHyperlink,
  pageSize = PRESENTATION_PAGE_SIZES.wide,
}: PresentationSlidePreviewProps) {
  const previewRef = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const preview = previewRef.current
    if (!preview || !colorAnimations?.size) return
    const cleanups: Array<() => void> = []
    for (const element of preview.querySelectorAll<HTMLElement | SVGElement>('[data-presentation-color-element]')) {
      const animation = colorAnimations.get(element.getAttribute('data-presentation-color-element')!)
      if (!animation) continue
      const { property, color, options } = animation
      const selector = property === 'fill' ? '[fill]:not([fill="none"])' : '[data-presentation-text-color]'
      for (const node of element.querySelectorAll<HTMLElement | SVGElement>(selector)) {
        const opacity = node.getAttribute('data-presentation-color-opacity')
        const target = opacity === null ? color : `color-mix(in srgb, ${color} ${Number(opacity) * 100}%, transparent)`
        const original = node.style[property]
        const keyframes = [{ [property]: getComputedStyle(node)[property] }, { [property]: target }]
        try {
          const player = node.animate(keyframes, options)
          cleanups.push(() => player.cancel())
        } catch {
          // Keep a correct final frame when Web Animations is unavailable.
          node.style[property] = target
          cleanups.push(() => {
            node.style[property] = property === 'color'
              ? node.getAttribute('data-presentation-text-color') ?? original
              : original
          })
        }
      }
    }
    return () => cleanups.forEach(cleanup => cleanup())
  }, [colorAnimations])
  const scale = width / pageSize.width
  const interactive = presentation && Boolean(onActivateHyperlink)
  return (
    <span
      className={cn(
        'relative block shrink-0 overflow-hidden bg-white',
        presentation ? 'rounded-sm shadow-[0_24px_72px_rgba(0,0,0,0.5)]' : 'rounded border shadow-sm',
        !presentation && (selected ? 'border-brand-purple ring-1 ring-brand-purple/25' : 'border-border-default'),
      )}
      style={{ width, height: width * (pageSize.height / pageSize.width) }}
      aria-hidden={interactive ? undefined : 'true'}
      ref={previewRef}
      data-testid="presentation-slide-preview"
    >
      <span
        className="absolute left-0 top-0 block origin-top-left overflow-hidden"
        style={{
          width: pageSize.width,
          height: pageSize.height,
          transform: `scale(${scale})`,
          backgroundColor: slide.background,
        }}
      >
        {slide.elements.map((element) => {
          const replaced = elementReplacements?.has(element.id)
          const visible = !replaced && !hiddenElementIds?.has(element.id)
          return (
            <Fragment key={element.id}>
              {elementReplacements?.get(element.id)}
              {visible && (
                <PresentationElementPreview element={element} animationState={animationStates?.get(element.id)} interactive={interactive} suppressMediaPlayback={suppressMediaPlayback} />
              )}
              {visible && interactive && element.hyperlink && supportsPresentationElementHyperlink(element) ? (
                <HyperlinkOverlay
                  element={element}
                  hyperlink={element.hyperlink}
                  scale={animationStates?.get(element.id)?.scale}
                  onActivate={onActivateHyperlink!}
                />
              ) : null}
            </Fragment>
          )
        })}
        <PresentationFooterPreview slide={slide} slideNumber={slideNumber} />
      </span>
    </span>
  )
}

function elementStyle(element: PresentationElement, scale?: PresentationAnimationScale): CSSProperties {
  const rotationLocked = isPresentationMediaElement(element)
    || isPresentationTableElement(element)
    || isPresentationChartElement(element)
  const emphasis = scale ? `translate(${(element.x - scale.x) * (scale.factor - 1)}px, ${(element.y - scale.y) * (scale.factor - 1)}px) scale(${scale.factor}) ` : ''
  return {
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: `${emphasis}rotate(${rotationLocked ? 0 : element.rotation}deg)${element.flipHorizontal || element.flipVertical
      ? ` translate(${element.flipHorizontal ? element.width : 0}px, ${element.flipVertical ? element.height : 0}px) scale(${element.flipHorizontal ? -1 : 1}, ${element.flipVertical ? -1 : 1})`
      : ''}`,
    transformOrigin: 'top left',
    opacity: element.opacity ?? 1,
  }
}

function stopPresentationPlaybackMedia(media: HTMLMediaElement | null): void {
  media?.pause()
}

function startPresentationPlaybackMedia(media: HTMLMediaElement | null, autoplay: boolean): void {
  if (!media || !autoplay) return
  try {
    void media.play().catch(() => undefined)
  } catch {
    // Browser autoplay policy may reject playback without a user gesture.
  }
}

function PresentationPlaybackVideo({ element, scale }: { scale?: PresentationAnimationScale; element: Extract<PresentationElement, { type: 'video' }> }) {
  const mediaRef = useRef<HTMLVideoElement>(null)
  const sourceUrl = element.source.dataUrl
  useEffect(() => {
    const media = mediaRef.current
    startPresentationPlaybackMedia(media, element.autoplay)
    return () => {
      if (media?.getAttribute('src') === sourceUrl) stopPresentationPlaybackMedia(media)
    }
  }, [element.autoplay, sourceUrl])
  return (
    <video
      ref={mediaRef}
      className="absolute block bg-[#10172A]"
      controls
      autoPlay={element.autoplay}
      loop={element.loop}
      muted={element.muted}
      playsInline
      src={sourceUrl}
      style={elementStyle(element, scale)}
    />
  )
}

function PresentationPlaybackAudio({ element, scale }: { scale?: PresentationAnimationScale; element: Extract<PresentationElement, { type: 'audio' }> }) {
  const mediaRef = useRef<HTMLAudioElement>(null)
  const playAttemptRef = useRef(0)
  const [playing, setPlaying] = useState(false)
  const sourceUrl = element.source.dataUrl
  useEffect(() => {
    const media = mediaRef.current
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    media?.addEventListener('play', onPlay)
    media?.addEventListener('pause', onPause)
    media?.addEventListener('ended', onPause)
    if (media && element.autoplay) {
      const attempt = ++playAttemptRef.current
      try {
        void media.play().catch(() => {
          if (attempt === playAttemptRef.current) setPlaying(false)
        })
      } catch {
        if (attempt === playAttemptRef.current) setPlaying(false)
      }
    }
    return () => {
      playAttemptRef.current += 1
      media?.removeEventListener('play', onPlay)
      media?.removeEventListener('pause', onPause)
      media?.removeEventListener('ended', onPause)
      if (media?.getAttribute('src') === sourceUrl) stopPresentationPlaybackMedia(media)
    }
  }, [element.autoplay, sourceUrl])
  const togglePlayback = () => {
    const media = mediaRef.current
    if (!media) return
    if (!media.paused) {
      playAttemptRef.current += 1
      media.pause()
      return
    }
    const attempt = ++playAttemptRef.current
    setPlaying(true)
    try {
      void media.play().then(() => {
        if (attempt === playAttemptRef.current && media.paused) setPlaying(false)
      }).catch(() => {
        if (attempt === playAttemptRef.current) setPlaying(false)
      })
    } catch {
      if (attempt === playAttemptRef.current) setPlaying(false)
    }
  }
  return (
    <span
      className="absolute flex items-center justify-center overflow-hidden rounded-full border border-[#BEB4F1] bg-[#F4F1FF] shadow-sm"
      style={elementStyle(element, scale)}
    >
      <audio
        ref={mediaRef}
        className="hidden"
        autoPlay={element.autoplay}
        loop={element.loop}
        muted={element.muted}
        src={sourceUrl}
      />
      <button
        type="button"
        className="flex size-[75%] items-center justify-center rounded-full bg-[#705BE5] text-white shadow-sm"
        aria-label={element.source.fileName}
        aria-pressed={playing}
        onClick={togglePlayback}
      >
        {playing
          ? <Pause className="size-[42%]" fill="currentColor" />
          : <Play className="size-[42%] translate-x-[5%]" fill="currentColor" />}
      </button>
    </span>
  )
}

export function PresentationElementPreview({ element: sourceElement, animationState, interactive, suppressMediaPlayback }: {
  animationState?: PresentationAnimationDisplayState
  element: PresentationElement
  interactive: boolean
  suppressMediaPlayback: boolean
}) {
  const element = animationState?.element ?? sourceElement
  const scale = animationState?.scale
  if (isPresentationTextElement(element)) {
    const verticalLayout = element.textDirection === 'eastAsianVertical' || element.textDirection === 'stacked'
      ? layoutPresentationVerticalText(element)
      : null
    const frame = presentationTextFrame(element)
    const inlineStyle = (offset: number, lineSpacing = element.lineSpacing, resolvedStyle?: PresentationTextStyle): CSSProperties => {
      const style = resolvedStyle ?? presentationTextStyleAt(element, offset)
      const metrics = presentationScriptMetrics(style)
      const color = animationState?.textColor ?? (element.hyperlink ? '#2563EB' : style.color ?? element.color)
      return {
        fontSize: metrics.fontSize,
        lineHeight: lineSpacing ? 0 : undefined,
        fontFamily: presentationRenderingFontFamily(style.fontFamily ?? element.fontFamily, element.text),
        fontWeight: style.fontWeight,
        fontStyle: style.italic ? 'italic' : 'normal',
        color: style.opacity === undefined ? color : `color-mix(in srgb, ${color} ${style.opacity * 100}%, transparent)`,
        textDecoration: [style.underline || element.hyperlink ? 'underline' : '', style.strikethrough ? 'line-through' : ''].filter(Boolean).join(' ') || 'none',
        backgroundColor: style.highlightColor,
        letterSpacing: `${(style.characterSpacing ?? 0) / 1000}em`,
        position: 'relative', top: metrics.deltaY,
      }
    }
    return (
      <span
        className="absolute block"
        style={{
          ...elementStyle(element, scale),
          whiteSpace: element.wordWrap === false ? 'pre' : 'pre-wrap',
          color: element.color,
          fontFamily: presentationRenderingFontFamily(element.fontFamily, element.text),
          fontSize: element.fontSize,
          fontWeight: element.fontWeight,
          lineHeight: element.lineSpacing ? `${element.lineSpacing}px` : element.lineHeight ?? 1.08,
          textAlign: element.align,
          textShadow: element.shadow ? '5px 6px 12px rgba(20, 20, 32, 0.28)' : undefined,
          letterSpacing: `${(element.characterSpacing ?? 0) / 1000}em`,
        }}
        data-testid="presentation-text-preview"
        data-presentation-color-element={element.id}
      >
        <span
          className="absolute block"
          data-testid="presentation-text-content"
          style={{
            left: frame.x, top: frame.y, width: frame.width, height: frame.height,
            transform: `rotate(${frame.rotation}deg)`, transformOrigin: 'top left',
            // Horizontal wrapping controls line breaks; glyph ink may extend beyond the frame, as in Fabric.
            overflow: 'visible',
            display: verticalLayout ? 'block' : 'flex',
            alignItems: verticalLayout ? undefined : presentationVerticalAlignment(element.verticalAlign),
            paddingLeft: verticalLayout ? (element.indentLevel ?? 0) * 16 : 0,
          }}
        >
          {verticalLayout ? verticalLayout.columns.flatMap((column, columnIndex) => {
            const availableHeight = Math.max(0, frame.height - verticalLayout.columnHeights[columnIndex]!)
            let alignmentOffset = 0
            if (element.verticalAlign === 'bottom') alignmentOffset = availableHeight
            else if (element.verticalAlign === 'middle') alignmentOffset = availableHeight / 2
            return Array.from(column).map((glyph, rowIndex) => {
              const style = inlineStyle(verticalLayout.sourceOffsets[columnIndex]![rowIndex]!, element.lineSpacing, verticalLayout.glyphStyles[columnIndex]![rowIndex]!)
              return (
                <span
                  className="absolute block"
                  key={`${columnIndex}-${rowIndex}`}
                  data-presentation-text-color={style.color}
                  data-presentation-color-opacity={verticalLayout.glyphStyles[columnIndex]![rowIndex]!.opacity}
                  style={{
                    ...style, position: 'absolute',
                    left: verticalLayout.columnOffsets[columnIndex],
                    top: alignmentOffset + verticalLayout.rowOffsets[columnIndex]![rowIndex]! + Number(style.top),
                    lineHeight: 1, width: style.fontSize,
                  }}
                >{glyph}</span>
              )
            })
          }) : (
            <span className="flex w-full shrink-0 flex-col">
              {presentationTextParagraphs(element).map((paragraph, paragraphIndex) => (
                <PresentationParagraphPreview key={paragraphIndex} element={element} paragraph={paragraph} paragraphIndex={paragraphIndex} inlineStyle={inlineStyle} />
              ))}
            </span>
          )}
        </span>
      </span>
    )
  }
  if (isPresentationShapeElement(element)) return <SlideShapePreview element={element} scale={scale} />
  if (isPresentationImageElement(element)) {
    const crop = element.crop
    if (crop) {
      const visibleWidth = Math.max(0.001, 1 - crop.left - crop.right)
      const visibleHeight = Math.max(0.001, 1 - crop.top - crop.bottom)
      return (
        <span
          className="absolute block overflow-hidden"
          style={{ ...elementStyle(element, scale), borderRadius: element.clipShape === 'ellipse' ? '50%' : undefined }}
        >
          <img
            alt={element.altText}
            className="absolute block max-w-none"
            draggable={false}
            src={element.source.dataUrl}
            style={{
              left: `${-(crop.left / visibleWidth) * 100}%`,
              top: `${-(crop.top / visibleHeight) * 100}%`,
              width: `${100 / visibleWidth}%`,
              height: `${100 / visibleHeight}%`,
              filter: element.shadow ? 'drop-shadow(5px 6px 6px rgba(20, 20, 32, 0.22))' : undefined,
            }}
          />
        </span>
      )
    }
    return (
      <img
        alt={element.altText}
        className="absolute block"
        draggable={false}
        src={element.source.dataUrl}
        style={{
          ...elementStyle(element, scale),
          objectFit: element.fit,
          borderRadius: element.clipShape === 'ellipse' ? '50%' : undefined,
          filter: element.shadow ? 'drop-shadow(5px 6px 6px rgba(20, 20, 32, 0.22))' : undefined,
        }}
      />
    )
  }
  if (isPresentationMediaElement(element)) {
    if (element.type === 'video' && interactive && !suppressMediaPlayback) {
      return <PresentationPlaybackVideo element={element} scale={scale} />
    }
    if (element.type === 'audio' && interactive && !suppressMediaPlayback) {
      return <PresentationPlaybackAudio element={element} scale={scale} />
    }
    if (element.type === 'audio') return (
      <span
        className="absolute flex items-center justify-center overflow-hidden rounded-full border border-[#BEB4F1] bg-[#F4F1FF] shadow-sm"
        style={elementStyle(element, scale)}
        data-testid="presentation-audio-placeholder"
      >
        <span className="flex size-[75%] items-center justify-center rounded-full bg-[#705BE5] text-white shadow-sm">
          <Play className="size-[42%] translate-x-[5%]" fill="currentColor" />
        </span>
      </span>
    )
    return (
      <span
        className="absolute overflow-hidden rounded-[10px] border border-[#3D4663] bg-[#151A2D] text-white shadow-md"
        style={elementStyle(element, scale)}
        data-testid="presentation-video-placeholder"
      >
        <span className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(111,91,231,0.18),transparent_36%)]" />
        <span className="absolute left-1/2 top-1/2 flex size-14 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/35 bg-black/45 text-white shadow-[0_8px_24px_rgba(0,0,0,0.28)]">
          <Play className="size-6 translate-x-0.5" fill="currentColor" />
        </span>
        <span className="absolute inset-x-0 bottom-0 block bg-[linear-gradient(180deg,transparent,rgba(5,8,18,0.82))] px-4 pb-3 pt-9">
          <span className="block truncate text-[14px] font-medium">{element.source.fileName}</span>
        </span>
      </span>
    )
  }
  if (isPresentationTableElement(element)) return <PresentationTablePreview element={element} scale={scale} />
  if (isPresentationChartElement(element)) return <PresentationChartPreview element={element} scale={scale} />
  return null
}

function presentationVerticalAlignment(alignment: PresentationTextElement['verticalAlign']): CSSProperties['alignItems'] {
  if (alignment === 'bottom') return 'flex-end'
  if (alignment === 'middle') return 'center'
  return 'flex-start'
}

function SlideShapePreview({ element, scale }: { scale?: PresentationAnimationScale; element: PresentationShapeElement }) {
  const definition = getPresentationShapeDefinition(element.type)
  const strokeOnly = definition.strokeOnly || isPresentationLineShape(element.type)
  let shape: React.ReactNode
  if (element.type === 'rect' || element.type === 'roundRect') shape = (
    <rect
      x="0"
      y="0"
      width="100"
      height="100"
      rx={Math.min(50, ((element.type === 'roundRect' ? Math.min(element.width, element.height) * 0.12 : element.radius ?? 0) / element.width) * 100)}
      ry={Math.min(50, ((element.type === 'roundRect' ? Math.min(element.width, element.height) * 0.12 : element.radius ?? 0) / element.height) * 100)}
      fill={element.fill}
      stroke={element.borderColor}
      strokeWidth={element.borderWidth}
      vectorEffect="non-scaling-stroke"
    />
  )
  else if (element.type === 'ellipse') shape = (
    <ellipse cx="50" cy="50" rx="50" ry="50" fill={element.fill} stroke={element.borderColor}
      strokeWidth={element.borderWidth} vectorEffect="non-scaling-stroke" />
  )
  else shape = (
    <path
      d={getPresentationShapePath(element)}
      fill={strokeOnly ? 'none' : element.fill}
      fillRule="evenodd"
      stroke={element.borderColor}
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={strokeOnly ? Math.max(3, element.borderWidth) : element.borderWidth}
      vectorEffect="non-scaling-stroke"
    />
  )
  return (
    <svg
      className="absolute block overflow-visible"
      data-presentation-color-element={element.id}
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{
        ...elementStyle(element, scale),
        filter: element.shadow ? 'drop-shadow(5px 6px 6px rgba(20, 20, 32, 0.22))' : undefined,
      }}
    >
      {shape}
    </svg>
  )
}

function PresentationTablePreview({ element, scale }: { scale?: PresentationAnimationScale; element: PresentationTableElement }) {
  const columns = Math.max(1, ...element.cells.map((row) => row.length))
  const cellHeight = element.height / Math.max(1, element.cells.length)
  return (
    <table
      className="absolute table-fixed border-collapse overflow-hidden"
      style={{ ...elementStyle(element, scale), color: element.textColor, fontSize: element.fontSize }}
      data-testid="presentation-table-preview"
    >
      <tbody>
        {element.cells.map((row, rowIndex) => (
          <tr key={rowIndex} style={{ height: `${100 / Math.max(1, element.cells.length)}%` }}>
            {Array.from({ length: columns }, (_, columnIndex) => (
              <td
                key={columnIndex}
                className="overflow-hidden p-0 align-middle"
                style={{
                  width: `${100 / columns}%`,
                  border: `1px solid ${element.borderColor}`,
                  backgroundColor: element.headerRow && rowIndex === 0 ? element.headerFill : element.bodyFill,
                  color: element.headerRow && rowIndex === 0 ? element.headerTextColor ?? '#FFFFFF' : element.textColor,
                  fontWeight: element.headerRow && rowIndex === 0 ? 600 : 400,
                }}
              >
                <div style={{ height: Math.max(0, cellHeight - 1), padding: '4px 10px', boxSizing: 'border-box',
                  display: 'flex', flexDirection: 'column', justifyContent: 'safe center', overflow: 'hidden' }}>
                  <div style={{ flexShrink: 0, whiteSpace: 'pre-wrap', lineHeight: PRESENTATION_TEXT_LINE_METRICS.height * 1.16,
                    fontFamily: presentationRenderingFontFamily('Aptos', row[columnIndex] ?? '') }}>
                    {row[columnIndex] ?? ''}
                  </div>
                </div>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function getPresentationChartLayout(element: PresentationChartElement) {
  const layoutWidth = Math.max(180, element.width)
  const layoutHeight = Math.max(120, element.height)
  const titleHeight = element.title ? 38 : 12
  const legendHeight = element.showLegend ? 34 : 8
  const plotHeight = layoutHeight - titleHeight - legendHeight - 28
  const cartesian = element.chartType === 'column' || element.chartType === 'line'
  const valueLabelWidth = cartesian ? Math.max(...presentationChartValueTicks(getPresentationChartRange(element.series), plotHeight)
    .map(tick => tick.label.length * 8 + 12)) : 0
  const left = element.chartType === 'bar' ? 100 : Math.max(54, valueLabelWidth)
  const plot = {
    x: left,
    y: titleHeight,
    width: layoutWidth - left - (element.chartType === 'bar' ? 20 : 22),
    height: plotHeight,
  }
  return { layoutWidth, layoutHeight, plot }
}

function PresentationChartPreview({ element, scale }: { scale?: PresentationAnimationScale; element: PresentationChartElement }) {
  const { layoutWidth, layoutHeight, plot } = getPresentationChartLayout(element)
  const chartAreaFill = element.chartAreaFill ?? '#FFFFFF'
  const plotAreaFill = element.plotAreaFill ?? 'transparent'
  let chartMarks: ReactNode
  if (element.chartType === 'pie' || element.chartType === 'doughnut') chartMarks = <PieChartMarks element={element} plot={plot} />
  else if (element.chartType === 'bar') chartMarks = <BarChartMarks element={element} plot={plot} />
  else chartMarks = <CartesianChartMarks element={element} plot={plot} />
  return (
    <svg
      className="absolute block overflow-hidden rounded-md"
      viewBox={`0 0 ${layoutWidth} ${layoutHeight}`}
      preserveAspectRatio="none"
      style={elementStyle(element, scale)}
      data-testid="presentation-chart-preview"
    >
      <rect x="0" y="0" width={layoutWidth} height={layoutHeight} fill={chartAreaFill} stroke={chartAreaFill === 'transparent' ? 'transparent' : '#E3E4EA'} />
      <rect x={plot.x} y={plot.y} width={plot.width} height={plot.height} fill={plotAreaFill} />
      {element.title ? <text x={layoutWidth / 2} y="25" textAnchor="middle" fontFamily="Aptos, sans-serif" fontSize="18" fontWeight="600" fill={element.categoryAxisLabelColor ?? '#20202B'}>{element.title}</text> : null}
      {chartMarks}
      {element.showLegend ? <ChartLegend element={element} width={layoutWidth} y={layoutHeight - 18} /> : null}
    </svg>
  )
}

interface ChartPlot {
  x: number
  y: number
  width: number
  height: number
}

export interface PresentationChartRange {
  min: number
  max: number
  span: number
}

/** Cartesian charts always include zero; pie-family charts normalize separately. */
export function getPresentationChartRange(series: readonly PresentationChartSeries[]): PresentationChartRange {
  const values = series.flatMap((item) => item.values.map((value) => typeof value === 'number' && Number.isFinite(value) ? value : 0))
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  if (min === max) return { min: 0, max: 1, span: 1 }
  return { min, max, span: max - min }
}

export function getPresentationChartValueRatio(value: number, range: PresentationChartRange): number {
  const finiteValue = typeof value === 'number' && Number.isFinite(value) ? value : 0
  return (finiteValue - range.min) / range.span
}

function CartesianChartMarks({ element, plot }: { element: PresentationChartElement; plot: ChartPlot }) {
  const categoryCount = Math.max(1, element.categories.length)
  const seriesCount = Math.max(1, element.series.length)
  const range = getPresentationChartRange(element.series)
  const valueY = (value: number) => plot.y + ((1 - getPresentationChartValueRatio(value, range)) * plot.height)
  const zeroY = valueY(0)
  const marks: ReactNode[] = []
  for (const tick of presentationChartValueTicks(range, plot.height)) {
    const y = plot.y + plot.height * (1 - tick.ratio)
    marks.push(<line key={`grid-${tick.ratio}`} x1={plot.x} x2={plot.x + plot.width} y1={y} y2={y} stroke={element.gridLineColor ?? '#E9EAF0'} strokeWidth="1" />)
    marks.push(<text key={`tick-${tick.ratio}`} data-testid="presentation-chart-value-tick" x={plot.x - 10} y={y} dominantBaseline="central" textAnchor="end" fontFamily="Aptos, sans-serif" fontSize={tick.fontSize} fill={element.valueAxisLabelColor ?? '#666571'}>{tick.label}</text>)
  }
  marks.push(<line key="zero-axis" data-testid="presentation-chart-zero-axis" x1={plot.x} x2={plot.x + plot.width} y1={zeroY} y2={zeroY} stroke="#AEB0BA" strokeWidth="1.5" />)
  if (element.chartType === 'line') {
    element.series.forEach((series, seriesIndex) => {
      const color = element.colors[seriesIndex % element.colors.length] ?? '#6957D9'
      const segments = presentationChartLineSegments(element, series, plot, valueY)
      segments.forEach((points, segmentIndex) => {
        if (points.length > 1) marks.push(<polyline key={`line-${seriesIndex}-${segmentIndex}`} points={points.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={color} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />)
        points.forEach(point => {
          marks.push(<circle key={`point-${seriesIndex}-${point.index}`} cx={point.x} cy={point.y} r="4" fill={color} />)
          if (element.showValue) marks.push(<text key={`value-${seriesIndex}-${point.index}`} x={point.x} y={presentationLineLabelY(point.y, plot.y)} dominantBaseline="central" textAnchor="middle" fontFamily="Aptos, sans-serif" fontSize="12" fill={element.dataLabelColor ?? '#20202B'}>{point.value}</text>)
        })
      })
    })
  } else {
    const groupWidth = plot.width / categoryCount
    const gap = Math.min(8, groupWidth * 0.08)
    const barWidth = Math.max(2, (groupWidth - (gap * 2)) / seriesCount)
    element.categories.forEach((_, categoryIndex) => {
      element.series.forEach((series, seriesIndex) => {
        const value = presentationChartValue(series.values[categoryIndex], element.displayBlanksAs)
        if (value === null) return
        const valuePosition = valueY(value)
        const height = Math.abs(valuePosition - zeroY)
        marks.push(
          <g key={`column-${categoryIndex}-${seriesIndex}`}>
            <rect
              data-testid="presentation-chart-column"
              x={plot.x + (categoryIndex * groupWidth) + gap + (seriesIndex * barWidth)}
              y={Math.min(valuePosition, zeroY)}
              width={Math.max(1, barWidth - 2)}
              height={height}
              rx="2"
              fill={element.colors[seriesIndex % element.colors.length] ?? '#6957D9'}
            />
            {element.showValue ? (
              <text
                x={plot.x + (categoryIndex * groupWidth) + gap + (seriesIndex * barWidth) + (barWidth / 2)}
                y={value >= 0 ? valuePosition - 5 : valuePosition + 13}
                textAnchor="middle"
                fontFamily="Aptos, sans-serif"
                fontSize="10"
                fill={element.dataLabelColor ?? '#20202B'}
              >{value}</text>
            ) : null}
          </g>,
        )
      })
    })
  }
  element.categories.forEach((category, index) => {
    marks.push(<text key={`label-${index}`} x={plot.x + ((index + 0.5) / categoryCount) * plot.width} y={plot.y + plot.height + 20} textAnchor="middle" fontFamily="Aptos, sans-serif" fontSize="12" fill={element.categoryAxisLabelColor ?? '#666571'}>{category}</text>)
  })
  return <>{marks}</>
}

function BarChartMarks({ element, plot }: { element: PresentationChartElement; plot: ChartPlot }) {
  const categoryCount = Math.max(1, element.categories.length)
  const seriesCount = Math.max(1, element.series.length)
  const range = getPresentationChartRange(element.series)
  const valueX = (value: number) => plot.x + (getPresentationChartValueRatio(value, range) * plot.width)
  const zeroX = valueX(0)
  const groupHeight = plot.height / categoryCount
  const barHeight = Math.max(2, (groupHeight - 8) / seriesCount)
  return (
    <>
      {presentationChartValueTicks(range, plot.width, true).map(tick => {
        const x = plot.x + plot.width * tick.ratio
        const anchor = tick.ratio === 0 ? 'start' : 'middle'
        return <g key={tick.ratio}>
          <line x1={x} x2={x} y1={plot.y} y2={plot.y + plot.height} stroke={element.gridLineColor ?? '#E9EAF0'} strokeWidth="1" />
          <text data-testid="presentation-chart-value-tick" x={x} y={plot.y + plot.height + 14} dominantBaseline="central" textAnchor={tick.ratio === 1 ? 'end' : anchor} fontFamily="Aptos, sans-serif" fontSize={tick.fontSize} fill={element.valueAxisLabelColor ?? '#666571'}>{tick.label}</text>
        </g>
      })}
      <line data-testid="presentation-chart-zero-axis" x1={zeroX} x2={zeroX} y1={plot.y} y2={plot.y + plot.height} stroke="#AEB0BA" strokeWidth="1.5" />
      {element.categories.map((category, categoryIndex) => (
        <g key={categoryIndex}>
          <text x={plot.x - 10} y={plot.y + (categoryIndex * groupHeight) + (groupHeight / 2) + 4} textAnchor="end" fontFamily="Aptos, sans-serif" fontSize="12" fill={element.categoryAxisLabelColor ?? '#666571'}>{category}</text>
          {element.series.map((series, seriesIndex) => {
            const value = presentationChartValue(series.values[categoryIndex], element.displayBlanksAs)
            if (value === null) return null
            const valuePosition = valueX(value)
            return (
              <g key={seriesIndex}>
                <rect
                  data-testid="presentation-chart-bar"
                  x={Math.min(valuePosition, zeroX)}
                  y={plot.y + (categoryIndex * groupHeight) + 4 + (seriesIndex * barHeight)}
                  width={Math.abs(valuePosition - zeroX)}
                  height={Math.max(1, barHeight - 2)}
                  rx="2"
                  fill={element.colors[seriesIndex % element.colors.length] ?? '#6957D9'}
                />
                {element.showValue ? (
                  <text
                    x={value >= 0 ? valuePosition + 4 : valuePosition - 4}
                    y={plot.y + (categoryIndex * groupHeight) + 4 + (seriesIndex * barHeight) + Math.max(10, barHeight - 5)}
                    textAnchor={value >= 0 ? 'start' : 'end'}
                    fontFamily="Aptos, sans-serif"
                    fontSize="10"
                    fill={element.dataLabelColor ?? '#20202B'}
                  >{value}</text>
                ) : null}
              </g>
            )
          })}
        </g>
      ))}
    </>
  )
}

function polarPoint(cx: number, cy: number, radius: number, angle: number): { x: number; y: number } {
  const radians = (angle - 90) * (Math.PI / 180)
  return { x: cx + (radius * Math.cos(radians)), y: cy + (radius * Math.sin(radians)) }
}

export function presentationPieSlicePath(cx: number, cy: number, radius: number, start: number, end: number, innerRadius = 0): string {
  if (end - start >= 360 - 1e-8) {
    const circle = (r: number) => `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx} ${cy + r} A ${r} ${r} 0 1 1 ${cx} ${cy - r} Z`
    return circle(radius) + (innerRadius > 0 ? ` ${circle(innerRadius)}` : '')
  }
  const startPoint = polarPoint(cx, cy, radius, end)
  const endPoint = polarPoint(cx, cy, radius, start)
  const largeArc = end - start > 180 ? 1 : 0
  if (innerRadius <= 0) {
    return `M ${cx} ${cy} L ${startPoint.x} ${startPoint.y} A ${radius} ${radius} 0 ${largeArc} 0 ${endPoint.x} ${endPoint.y} Z`
  }
  const innerStart = polarPoint(cx, cy, innerRadius, end)
  const innerEnd = polarPoint(cx, cy, innerRadius, start)
  return `M ${startPoint.x} ${startPoint.y} A ${radius} ${radius} 0 ${largeArc} 0 ${endPoint.x} ${endPoint.y} L ${innerEnd.x} ${innerEnd.y} A ${innerRadius} ${innerRadius} 0 ${largeArc} 1 ${innerStart.x} ${innerStart.y} Z`
}

export function getPresentationPieSlices(values: readonly (number | null)[]) {
  const maximum = values.reduce<number>((largest, value) => typeof value === 'number' && Number.isFinite(value) ? Math.max(largest, value) : largest, 0)
  if (maximum === 0) return []
  // Scaling first avoids overflow and preserves ratios for very small positive totals.
  const scaled = values.map(value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) / maximum : 0)
  const total = scaled.reduce((sum, value) => sum + value, 0)
  let angle = 0
  return scaled.flatMap((value, index) => {
    if (value === 0) return []
    const start = angle
    angle += value / total * 360
    return [{ index, start, end: angle }]
  })
}

function PieChartMarks({ element, plot }: { element: PresentationChartElement; plot: ChartPlot }) {
  const slices = getPresentationPieSlices(element.series[0]?.values ?? [])
  const radius = Math.max(8, Math.min(plot.width, plot.height) * 0.43)
  const cx = plot.x + plot.width / 2
  const cy = plot.y + plot.height / 2
  const holeSize = element.chartType === 'doughnut' ? presentationChartHoleSize(element.holeSize) : 0
  const labels = presentationPieLabels(element, slices, plot)
  return <>{slices.map(({ index, start, end }) => (
      <path
        key={index}
        d={presentationPieSlicePath(cx, cy, radius, start, end, radius * holeSize / 100)}
        fill={element.colors[index % Math.max(1, element.colors.length)] ?? '#6957D9'}
        fillRule="evenodd" stroke={slices.length > 1 ? '#FFFFFF' : 'none'} strokeWidth="2" />
  ))}{labels.map(label => <g key={label.index}>
    {label.leader ? <polyline points={label.leader.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={element.categoryAxisLabelColor ?? '#666571'} strokeWidth="1" /> : null}
    <text x={label.x} y={label.y} dominantBaseline="central" textAnchor={label.anchor} fontFamily="Aptos, sans-serif" fontSize={label.fontSize} fill={element.dataLabelColor ?? '#20202B'}>{label.text}</text>
  </g>)}</>
}

function ChartLegend({ element, width, y }: { element: PresentationChartElement; width: number; y: number }) {
  const labels = element.chartType === 'pie' || element.chartType === 'doughnut'
    ? element.categories
    : element.series.map((series) => series.name)
  const itemWidth = Math.min(150, width / Math.max(1, labels.length))
  const start = (width - (itemWidth * labels.length)) / 2
  return (
    <g>
      {labels.map((label, index) => (
        <g key={index} transform={`translate(${start + (index * itemWidth)}, ${y})`}>
          <rect width="10" height="10" rx="2" fill={element.colors[index % element.colors.length] ?? '#6957D9'} />
          <text x="16" y="9" fontFamily="Aptos, sans-serif" fontSize="11" fill={element.categoryAxisLabelColor ?? '#666571'}>{label}</text>
        </g>
      ))}
    </g>
  )
}

function PresentationFooterPreview({ slide, slideNumber }: { slide: PresentationSlide; slideNumber?: number }) {
  const footer = slide.footer
  if (!footer || (!footer.text && !footer.showDate && !footer.showSlideNumber)) return null
  const date = new Intl.DateTimeFormat().format(new Date())
  return (
    <>
      {footer.text ? <span className="absolute bottom-4 left-8 text-xs text-[#666571]">{footer.text}</span> : null}
      {footer.showDate ? <span className="absolute bottom-4 left-1/2 -translate-x-1/2 text-xs text-[#666571]">{date}</span> : null}
      {footer.showSlideNumber && slideNumber ? <span className="absolute bottom-4 right-8 text-xs text-[#666571]">{slideNumber}</span> : null}
    </>
  )
}

function HyperlinkOverlay({ element, hyperlink, onActivate, scale }: {
  scale?: PresentationAnimationScale
  element: PresentationElement
  hyperlink: PresentationHyperlink
  onActivate: (hyperlink: PresentationHyperlink) => void
}) {
  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    onActivate(hyperlink)
  }
  const label = hyperlink.tooltip || (hyperlink.type === 'url' ? hyperlink.url : 'Go to slide')
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="absolute cursor-pointer bg-transparent focus:outline focus:outline-2 focus:outline-brand-purple"
      style={elementStyle(element, scale)}
    />
  )
}
