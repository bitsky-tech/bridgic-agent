import { Fragment, useEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Play } from 'lucide-react'
import {
  PRESENTATION_HEIGHT,
  PRESENTATION_WIDTH,
  formatPresentationText,
  type PresentationChartElement,
  type PresentationChartSeries,
  type PresentationElement,
  type PresentationHyperlink,
  type PresentationShapeElement,
  type PresentationSlide,
  type PresentationTableElement,
} from '@/atoms/presentation'
import { cn } from '@/lib/cn'
import {
  isPresentationChartElement,
  isPresentationImageElement,
  isPresentationMediaElement,
  isPresentationShapeElement,
  isPresentationTableElement,
  isPresentationTextElement,
  supportsPresentationElementHyperlink,
} from '@/lib/presentationInsert'
import { getPresentationShapeDefinition, isPresentationLineShape } from '@/lib/presentationShapes'

interface PresentationSlidePreviewProps {
  slide: PresentationSlide
  slideNumber?: number
  width: number
  selected: boolean
  presentation?: boolean
  suppressMediaPlayback?: boolean
  onActivateHyperlink?: (hyperlink: PresentationHyperlink) => void
}

/** Shared static renderer used by thumbnails, transition previews and slide show playback. */
export function PresentationSlidePreview({
  slide,
  slideNumber,
  width,
  selected,
  presentation = false,
  suppressMediaPlayback = false,
  onActivateHyperlink,
}: PresentationSlidePreviewProps) {
  const scale = width / PRESENTATION_WIDTH
  const interactive = presentation && Boolean(onActivateHyperlink)
  return (
    <span
      className={cn(
        'relative block shrink-0 overflow-hidden bg-white',
        presentation ? 'rounded-sm shadow-[0_24px_72px_rgba(0,0,0,0.5)]' : 'rounded border shadow-sm',
        !presentation && (selected ? 'border-brand-purple ring-1 ring-brand-purple/25' : 'border-border-default'),
      )}
      style={{ width, height: width * (PRESENTATION_HEIGHT / PRESENTATION_WIDTH) }}
      aria-hidden={interactive ? undefined : 'true'}
      data-testid="presentation-slide-preview"
    >
      <span
        className="absolute left-0 top-0 block origin-top-left overflow-hidden"
        style={{
          width: PRESENTATION_WIDTH,
          height: PRESENTATION_HEIGHT,
          transform: `scale(${scale})`,
          backgroundColor: slide.background,
        }}
      >
        {slide.elements.map((element) => (
          <Fragment key={element.id}>
            <PresentationElementPreview element={element} interactive={interactive} suppressMediaPlayback={suppressMediaPlayback} />
            {interactive && element.hyperlink && supportsPresentationElementHyperlink(element) ? (
              <HyperlinkOverlay
                element={element}
                hyperlink={element.hyperlink}
                onActivate={onActivateHyperlink!}
              />
            ) : null}
          </Fragment>
        ))}
        <PresentationFooterPreview slide={slide} slideNumber={slideNumber} />
      </span>
    </span>
  )
}

function elementStyle(element: PresentationElement): CSSProperties {
  const rotationLocked = isPresentationMediaElement(element)
    || isPresentationTableElement(element)
    || isPresentationChartElement(element)
  return {
    left: element.x,
    top: element.y,
    width: element.width,
    height: element.height,
    transform: `rotate(${rotationLocked ? 0 : element.rotation}deg)`,
    transformOrigin: 'top left',
  }
}

function presentationMediaExtension(fileName: string): string {
  return /\.([^.]+)$/.exec(fileName.trim())?.[1]?.toUpperCase() ?? 'MEDIA'
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

function PresentationPlaybackVideo({ element }: { element: Extract<PresentationElement, { type: 'video' }> }) {
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
      style={elementStyle(element)}
    />
  )
}

function PresentationPlaybackAudio({ element }: { element: Extract<PresentationElement, { type: 'audio' }> }) {
  const mediaRef = useRef<HTMLAudioElement>(null)
  const sourceUrl = element.source.dataUrl
  useEffect(() => {
    const media = mediaRef.current
    startPresentationPlaybackMedia(media, element.autoplay)
    return () => {
      if (media?.getAttribute('src') === sourceUrl) stopPresentationPlaybackMedia(media)
    }
  }, [element.autoplay, sourceUrl])
  return (
    <audio
      ref={mediaRef}
      className="absolute block"
      controls
      autoPlay={element.autoplay}
      loop={element.loop}
      muted={element.muted}
      src={sourceUrl}
      style={elementStyle(element)}
    />
  )
}

function PresentationElementPreview({ element, interactive, suppressMediaPlayback }: {
  element: PresentationElement
  interactive: boolean
  suppressMediaPlayback: boolean
}) {
  if (isPresentationTextElement(element)) {
    return (
      <span
        className="absolute block whitespace-pre-wrap overflow-hidden"
        style={{
          ...elementStyle(element),
          color: element.color,
          fontFamily: element.fontFamily,
          fontSize: element.fontSize,
          fontWeight: element.fontWeight,
          fontStyle: element.italic ? 'italic' : 'normal',
          lineHeight: element.lineHeight ?? 1.08,
          textAlign: element.align,
          textDecoration: [
            element.underline || element.hyperlink ? 'underline' : '',
            element.strikethrough ? 'line-through' : '',
          ].filter(Boolean).join(' ') || undefined,
          textShadow: element.shadow ? '5px 6px 12px rgba(20, 20, 32, 0.28)' : undefined,
          backgroundColor: element.highlightColor,
          letterSpacing: `${(element.characterSpacing ?? 0) / 1000}em`,
          paddingLeft: (element.indentLevel ?? 0) * 16,
          ...(element.hyperlink ? { color: '#2563EB' } : {}),
        }}
      >
        {formatPresentationText(element)}
      </span>
    )
  }
  if (isPresentationShapeElement(element)) return <SlideShapePreview element={element} />
  if (isPresentationImageElement(element)) {
    return (
      <img
        alt={element.altText}
        className="absolute block"
        draggable={false}
        src={element.source.dataUrl}
        style={{
          ...elementStyle(element),
          objectFit: element.fit,
          filter: element.shadow ? 'drop-shadow(5px 6px 6px rgba(20, 20, 32, 0.22))' : undefined,
        }}
      />
    )
  }
  if (isPresentationMediaElement(element)) {
    if (element.type === 'video' && interactive && !suppressMediaPlayback) {
      return <PresentationPlaybackVideo element={element} />
    }
    if (element.type === 'audio' && interactive && !suppressMediaPlayback) {
      return <PresentationPlaybackAudio element={element} />
    }
    if (element.type === 'audio') return (
      <span
        className="absolute flex items-center gap-4 overflow-hidden rounded-xl border border-[#CFC5F5] bg-[linear-gradient(110deg,#FAF8FF_0%,#F0ECFF_58%,#E8E2FF_100%)] px-5 text-[#302A4A] shadow-sm"
        style={elementStyle(element)}
        data-testid="presentation-audio-placeholder"
      >
        <span className="absolute inset-y-0 left-0 w-1.5 bg-[#7965E8]" />
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-[#6D58DC] text-white shadow-sm">
          <Play className="size-4 translate-x-px" fill="currentColor" />
        </span>
        <span className="flex h-8 shrink-0 items-center gap-1" aria-hidden="true">
          {[9, 17, 25, 14, 21, 12, 18, 8].map((height, index) => (
            <span
              className={cn('w-1 rounded-full', index % 2 === 0 ? 'bg-[#7662E4]' : 'bg-[#B0A4F0]')}
              key={`${element.id}-wave-${index}`}
              style={{ height }}
            />
          ))}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[17px] font-semibold leading-5">{element.source.fileName}</span>
          <span className="mt-0.5 block text-[10px] font-semibold uppercase tracking-[0.12em] text-[#7D749F]">{presentationMediaExtension(element.source.fileName)}</span>
        </span>
      </span>
    )
    return (
      <span
        className="absolute overflow-hidden rounded-2xl border border-[#53658F] bg-[radial-gradient(circle_at_78%_16%,rgba(116,94,226,0.35),transparent_32%),linear-gradient(145deg,#29385F_0%,#17233E_52%,#0E1426_100%)] text-white shadow-md"
        style={elementStyle(element)}
        data-testid="presentation-video-placeholder"
      >
        <span className="absolute left-5 top-5 rounded-lg border border-white/20 bg-white/10 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[#E6EAFE]">
          {presentationMediaExtension(element.source.fileName)}
        </span>
        <span className="absolute left-1/2 top-[45%] flex size-16 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/95 text-[#5E49D0] shadow-[0_12px_30px_rgba(0,0,0,0.28)]">
          <Play className="size-7 translate-x-0.5" fill="currentColor" />
        </span>
        <span className="absolute inset-x-0 bottom-0 block bg-[linear-gradient(180deg,transparent,rgba(7,10,22,0.92))] px-6 pb-5 pt-12">
          <span className="block truncate text-[17px] font-semibold">{element.source.fileName}</span>
        </span>
      </span>
    )
  }
  if (isPresentationTableElement(element)) return <PresentationTablePreview element={element} />
  if (isPresentationChartElement(element)) return <PresentationChartPreview element={element} />
  return null
}

function SlideShapePreview({ element }: { element: PresentationShapeElement }) {
  const definition = getPresentationShapeDefinition(element.type)
  const strokeOnly = definition.strokeOnly || isPresentationLineShape(element.type)
  const shape = element.type === 'rect' || element.type === 'roundRect' ? (
    <rect
      x="0"
      y="0"
      width="100"
      height="100"
      rx={element.type === 'roundRect' ? 12 : Math.min(50, ((element.radius ?? 0) / element.width) * 100)}
      ry={element.type === 'roundRect' ? 12 : Math.min(50, ((element.radius ?? 0) / element.height) * 100)}
      fill={element.fill}
      stroke={element.borderColor}
      strokeWidth={element.borderWidth}
      vectorEffect="non-scaling-stroke"
    />
  ) : (
    <path
      d={definition.path}
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
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{
        ...elementStyle(element),
        filter: element.shadow ? 'drop-shadow(5px 6px 6px rgba(20, 20, 32, 0.22))' : undefined,
      }}
    >
      {shape}
    </svg>
  )
}

function PresentationTablePreview({ element }: { element: PresentationTableElement }) {
  const columns = Math.max(1, ...element.cells.map((row) => row.length))
  return (
    <table
      className="absolute table-fixed border-collapse overflow-hidden"
      style={{ ...elementStyle(element), color: element.textColor, fontSize: element.fontSize }}
      data-testid="presentation-table-preview"
    >
      <tbody>
        {element.cells.map((row, rowIndex) => (
          <tr key={rowIndex} style={{ height: `${100 / Math.max(1, element.cells.length)}%` }}>
            {Array.from({ length: columns }, (_, columnIndex) => (
              <td
                key={columnIndex}
                className="overflow-hidden px-3 py-1 align-middle"
                style={{
                  width: `${100 / columns}%`,
                  border: `1px solid ${element.borderColor}`,
                  backgroundColor: element.headerRow && rowIndex === 0 ? element.headerFill : element.bodyFill,
                  color: element.headerRow && rowIndex === 0 ? '#FFFFFF' : element.textColor,
                  fontWeight: element.headerRow && rowIndex === 0 ? 600 : 400,
                }}
              >
                {row[columnIndex] ?? ''}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function PresentationChartPreview({ element }: { element: PresentationChartElement }) {
  const layoutWidth = Math.max(180, element.width)
  const layoutHeight = Math.max(120, element.height)
  const titleHeight = element.title ? 38 : 12
  const legendHeight = element.showLegend ? 34 : 8
  const plot = {
    x: element.chartType === 'bar' ? 100 : 54,
    y: titleHeight,
    width: layoutWidth - (element.chartType === 'bar' ? 120 : 76),
    height: layoutHeight - titleHeight - legendHeight - 28,
  }
  let chartMarks: ReactNode
  if (element.chartType === 'pie' || element.chartType === 'doughnut') chartMarks = <PieChartMarks element={element} plot={plot} />
  else if (element.chartType === 'bar') chartMarks = <BarChartMarks element={element} plot={plot} />
  else chartMarks = <CartesianChartMarks element={element} plot={plot} />
  return (
    <svg
      className="absolute block overflow-hidden rounded-md bg-white"
      viewBox={`0 0 ${layoutWidth} ${layoutHeight}`}
      preserveAspectRatio="none"
      style={elementStyle(element)}
      data-testid="presentation-chart-preview"
    >
      <rect x="0" y="0" width={layoutWidth} height={layoutHeight} fill="#FFFFFF" stroke="#E3E4EA" />
      {element.title ? <text x={layoutWidth / 2} y="25" textAnchor="middle" fontFamily="Aptos, sans-serif" fontSize="18" fontWeight="600" fill="#20202B">{element.title}</text> : null}
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
  const values = series.flatMap((item) => item.values.map((value) => Number.isFinite(value) ? value : 0))
  const min = Math.min(0, ...values)
  const max = Math.max(0, ...values)
  if (min === max) return { min: 0, max: 1, span: 1 }
  return { min, max, span: max - min }
}

export function getPresentationChartValueRatio(value: number, range: PresentationChartRange): number {
  const finiteValue = Number.isFinite(value) ? value : 0
  return (finiteValue - range.min) / range.span
}

function CartesianChartMarks({ element, plot }: { element: PresentationChartElement; plot: ChartPlot }) {
  const categoryCount = Math.max(1, element.categories.length)
  const seriesCount = Math.max(1, element.series.length)
  const range = getPresentationChartRange(element.series)
  const valueY = (value: number) => plot.y + ((1 - getPresentationChartValueRatio(value, range)) * plot.height)
  const zeroY = valueY(0)
  const marks: ReactNode[] = []
  for (let index = 0; index <= 4; index += 1) {
    const y = plot.y + ((plot.height / 4) * index)
    marks.push(<line key={`grid-${index}`} x1={plot.x} x2={plot.x + plot.width} y1={y} y2={y} stroke="#E9EAF0" strokeWidth="1" />)
  }
  marks.push(<line key="zero-axis" data-testid="presentation-chart-zero-axis" x1={plot.x} x2={plot.x + plot.width} y1={zeroY} y2={zeroY} stroke="#AEB0BA" strokeWidth="1.5" />)
  if (element.chartType === 'line') {
    element.series.forEach((series, seriesIndex) => {
      const points = element.categories.map((_, categoryIndex) => {
        const x = plot.x + ((categoryIndex + 0.5) / categoryCount) * plot.width
        const value = series.values[categoryIndex] ?? 0
        const y = valueY(value)
        return `${x},${y}`
      }).join(' ')
      marks.push(<polyline key={`line-${seriesIndex}`} points={points} fill="none" stroke={element.colors[seriesIndex % element.colors.length] ?? '#6957D9'} strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />)
      element.categories.forEach((_, categoryIndex) => {
        const value = series.values[categoryIndex] ?? 0
        marks.push(<circle key={`point-${seriesIndex}-${categoryIndex}`} cx={plot.x + ((categoryIndex + 0.5) / categoryCount) * plot.width} cy={valueY(value)} r="4" fill={element.colors[seriesIndex % element.colors.length] ?? '#6957D9'} />)
      })
    })
  } else {
    const groupWidth = plot.width / categoryCount
    const gap = Math.min(8, groupWidth * 0.08)
    const barWidth = Math.max(2, (groupWidth - (gap * 2)) / seriesCount)
    element.categories.forEach((_, categoryIndex) => {
      element.series.forEach((series, seriesIndex) => {
        const value = series.values[categoryIndex] ?? 0
        const valuePosition = valueY(value)
        const height = Math.abs(valuePosition - zeroY)
        marks.push(
          <rect
            key={`column-${categoryIndex}-${seriesIndex}`}
            data-testid="presentation-chart-column"
            x={plot.x + (categoryIndex * groupWidth) + gap + (seriesIndex * barWidth)}
            y={Math.min(valuePosition, zeroY)}
            width={Math.max(1, barWidth - 2)}
            height={height}
            rx="2"
            fill={element.colors[seriesIndex % element.colors.length] ?? '#6957D9'}
          />,
        )
      })
    })
  }
  element.categories.forEach((category, index) => {
    marks.push(<text key={`label-${index}`} x={plot.x + ((index + 0.5) / categoryCount) * plot.width} y={plot.y + plot.height + 20} textAnchor="middle" fontFamily="Aptos, sans-serif" fontSize="12" fill="#666571">{category}</text>)
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
      <line data-testid="presentation-chart-zero-axis" x1={zeroX} x2={zeroX} y1={plot.y} y2={plot.y + plot.height} stroke="#AEB0BA" strokeWidth="1.5" />
      {element.categories.map((category, categoryIndex) => (
        <g key={categoryIndex}>
          <text x={plot.x - 10} y={plot.y + (categoryIndex * groupHeight) + (groupHeight / 2) + 4} textAnchor="end" fontFamily="Aptos, sans-serif" fontSize="12" fill="#666571">{category}</text>
          {element.series.map((series, seriesIndex) => {
            const value = series.values[categoryIndex] ?? 0
            const valuePosition = valueX(value)
            return (
              <rect
                key={seriesIndex}
                data-testid="presentation-chart-bar"
                x={Math.min(valuePosition, zeroX)}
                y={plot.y + (categoryIndex * groupHeight) + 4 + (seriesIndex * barHeight)}
                width={Math.abs(valuePosition - zeroX)}
                height={Math.max(1, barHeight - 2)}
                rx="2"
                fill={element.colors[seriesIndex % element.colors.length] ?? '#6957D9'}
              />
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

function pieSlicePath(cx: number, cy: number, radius: number, start: number, end: number, innerRadius = 0): string {
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

function PieChartMarks({ element, plot }: { element: PresentationChartElement; plot: ChartPlot }) {
  const values = element.series[0]?.values.map((value) => Math.max(0, value)) ?? []
  const total = Math.max(1, values.reduce((sum, value) => sum + value, 0))
  const radius = Math.max(8, Math.min(plot.width, plot.height) * 0.43)
  const cx = plot.x + (plot.width / 2)
  const cy = plot.y + (plot.height / 2)
  const positiveValues = values.filter((value) => value > 0)
  if (positiveValues.length === 0) return null
  if (positiveValues.length === 1) {
    const positiveIndex = values.findIndex((value) => value > 0)
    return (
      <>
        <circle cx={cx} cy={cy} r={radius} fill={element.colors[positiveIndex % Math.max(1, element.colors.length)] ?? '#6957D9'} />
        {element.chartType === 'doughnut' ? <circle cx={cx} cy={cy} r={radius * 0.56} fill="#FFFFFF" /> : null}
      </>
    )
  }
  return (
    <>
      {values.map((value, index) => {
        const start = (values.slice(0, index).reduce((sum, item) => sum + item, 0) / total) * 360
        const end = start + ((value / total) * 360)
        return (
          <path
            key={index}
            d={pieSlicePath(cx, cy, radius, start, end, element.chartType === 'doughnut' ? radius * 0.56 : 0)}
            fill={element.colors[index % Math.max(1, element.colors.length)] ?? '#6957D9'}
            stroke="#FFFFFF"
            strokeWidth="2"
          />
        )
      })}
    </>
  )
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
          <text x="16" y="9" fontFamily="Aptos, sans-serif" fontSize="11" fill="#666571">{label}</text>
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

function HyperlinkOverlay({ element, hyperlink, onActivate }: {
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
      style={elementStyle(element)}
    />
  )
}
