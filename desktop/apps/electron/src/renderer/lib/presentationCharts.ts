import type { PresentationChartElement, PresentationChartSeries } from '@/atoms/presentation'

/** Use the plotted range without changing the position of existing data marks. */
export function presentationChartValueTicks(range: { min: number; max: number }, axisLength: number, horizontal = false) {
  const intervals = Math.max(1, Math.min(4, Math.floor(axisLength / (horizontal ? 80 : 36))))
  const ticks = Array.from({ length: intervals + 1 }, (_, index) => {
    const ratio = index / intervals
    const value = range.min * (1 - ratio) + range.max * ratio
    const rounded = Number(value.toPrecision(4))
    const label = rounded !== 0 && (Math.abs(rounded) >= 100_000 || Math.abs(rounded) < 0.001)
      ? rounded.toExponential().replace('e+', 'e')
      : String(rounded)
    return { ratio, label }
  })
  let fontSize = 11
  if (horizontal) {
    // Endpoint labels point inward; include their full width when reserving the gap.
    for (let index = 0; index < intervals; index++) {
      const left = ticks[index]!.label.length * (index === 0 ? 1 : 0.5)
      const right = ticks[index + 1]!.label.length * (index + 1 === intervals ? 1 : 0.5)
      fontSize = Math.min(fontSize, (axisLength / intervals - 6) / ((left + right) * 0.7))
    }
  }
  return ticks.map(tick => ({ ...tick, fontSize }))
}

export function presentationChartHoleSize(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(10, Math.min(90, Math.round(value))) : 56
}

export function presentationChartBlankDisplay(value?: string): 'gap' | 'zero' | 'span' {
  return value === 'zero' || value === 'span' ? value : 'gap'
}

export function presentationChartValue(value: number | null | undefined, displayBlanksAs?: string): number | null {
  if (value == null) return presentationChartBlankDisplay(displayBlanksAs) === 'zero' ? 0 : null
  return Number.isFinite(value) ? value : 0
}

export interface PresentationChartPoint {
  index: number
  value: number
  x: number
  y: number
}

/** Keep missing category slots while distinguishing gaps from connected spans. */
export function presentationChartLineSegments(element: PresentationChartElement, series: PresentationChartSeries, plot: { x: number; width: number }, valueY: (value: number) => number): PresentationChartPoint[][] {
  const segments: PresentationChartPoint[][] = []
  let current: PresentationChartPoint[] = []
  element.categories.forEach((_, index) => {
    const value = presentationChartValue(series.values[index], element.displayBlanksAs)
    if (value === null) {
      if (presentationChartBlankDisplay(element.displayBlanksAs) === 'gap' && current.length) {
        segments.push(current)
        current = []
      }
      return
    }
    current.push({ index, value, x: plot.x + (index + 0.5) / element.categories.length * plot.width, y: valueY(value) })
  })
  if (current.length) segments.push(current)
  return segments
}

export function presentationLineLabelY(y: number, plotTop: number): number {
  return y - 12 < plotTop ? y + 14 : y - 12
}

function presentationPieLabelPoint(cx: number, cy: number, radius: number, start: number, end: number, holeSize = 0) {
  const labelRadius = radius * (holeSize > 0 ? (1 + holeSize / 100) / 2 : 0.65)
  const angle = ((start + end) / 2 - 90) * Math.PI / 180
  return { x: cx + Math.cos(angle) * labelRadius, y: cy + Math.sin(angle) * labelRadius }
}

interface PieLabel {
  index: number
  text: string
  x: number
  y: number
  fontSize: number
  anchor: 'start' | 'middle' | 'end'
  leader?: Array<{ x: number; y: number }>
}

/** Both renderers use the same collision handling and preserve every non-empty value. */
export function presentationPieLabels(element: PresentationChartElement, slices: Array<{ index: number; start: number; end: number }>, plot: { x: number; y: number; width: number; height: number }): PieLabel[] {
  if (!element.showValue) return []
  const radius = Math.max(8, Math.min(plot.width, plot.height) * 0.43)
  const cx = plot.x + plot.width / 2
  const cy = plot.y + plot.height / 2
  const holeSize = element.chartType === 'doughnut' ? presentationChartHoleSize(element.holeSize) : 0
  const labels: PieLabel[] = slices.map(slice => ({
    index: slice.index, text: String(element.series[0]?.values[slice.index]), fontSize: 12, anchor: 'middle',
    ...presentationPieLabelPoint(cx, cy, radius, slice.start, slice.end, holeSize),
  }))
  // Numeric labels are at most this wide in the renderer's 12px font, including signs and exponents.
  const width = (label: PieLabel) => label.text.length * 8
  const collision = labels.some((label, i) => labels.slice(i + 1).some(other => (
    Math.abs(label.x - other.x) < (width(label) + width(other)) / 2 + 4 && Math.abs(label.y - other.y) < 18
  )))
  if (!collision) return labels

  for (const side of [-1, 1]) {
    const column = labels.filter(label => (label.x < cx ? -1 : 1) === side)
    if (!column.length) continue
    const top = plot.y + 8
    const bottom = Math.max(top, plot.y + plot.height - 8)
    const spacing = column.length > 1 ? Math.min(18, (bottom - top) / (column.length - 1)) : 18
    for (const label of column) {
      const slice = slices.find(slice => slice.index === label.index)!
      const edge = presentationPieLabelPoint(cx, cy, radius, slice.start, slice.end, 100)
      label.x = cx + side * (radius + 20)
      label.y = Math.max(top, Math.min(bottom, edge.y))
      label.anchor = side < 0 ? 'end' : 'start'
      const availableWidth = side < 0 ? label.x - 4 : Math.max(180, element.width) - 4 - label.x
      label.fontSize = Math.min(12, spacing / 1.5, Math.max(1, availableWidth) / (label.text.length * 2 / 3))
      label.leader = [edge, { x: cx + side * (radius + 10), y: edge.y }, { x: label.x - side * 4, y: edge.y }]
    }
    column.sort((a, b) => a.y - b.y || a.index - b.index)
    for (let i = 1; i < column.length; i++) column[i]!.y = Math.max(column[i]!.y, column[i - 1]!.y + spacing)
    column[column.length - 1]!.y = Math.min(bottom, column[column.length - 1]!.y)
    for (let i = column.length - 2; i >= 0; i--) column[i]!.y = Math.min(column[i]!.y, column[i + 1]!.y - spacing)
    for (const label of column) {
      label.leader![1]!.y = label.y
      label.leader![2]!.y = label.y
    }
  }
  return labels
}
