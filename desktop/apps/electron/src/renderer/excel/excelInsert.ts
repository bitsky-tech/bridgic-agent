export type ExcelCellValue = string | number | boolean | null

export type ExcelChartType =
  | 'column'
  | 'bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'doughnut'
  | 'scatter'

export type ExcelPivotAggregate = 'sum' | 'count' | 'average' | 'min' | 'max'

export type ExcelInsertValidationCode =
  | 'chart-data-required'
  | 'hyperlink-invalid'
  | 'hyperlink-protocol-unsupported'
  | 'hyperlink-url-required'
  | 'pie-positive-data-required'
  | 'pivot-data-required'
  | 'pivot-field-invalid'
  | 'scatter-data-required'

export class ExcelInsertValidationError extends Error {
  constructor(readonly code: ExcelInsertValidationCode) {
    super(code)
    this.name = 'ExcelInsertValidationError'
  }
}

export interface ExcelInsertContext {
  address: string
  values: ExcelCellValue[][]
}

export interface ExcelHyperlinkOptions {
  url: string
  label: string
}

export interface ExcelPivotOptions {
  sourceAddress: string
  rowField: number
  columnField: number | null
  valueField: number
  aggregate: ExcelPivotAggregate
}

export type ExcelRibbonActionValue =
  | string
  | number
  | ExcelChartType
  | ExcelHyperlinkOptions
  | ExcelPivotOptions

export interface ExcelPivotResult {
  values: ExcelCellValue[][]
  numericStartColumn: number
}

const CHART_COLORS = ['#4F7CFF', '#22B8A7', '#F59E4B', '#A66CF4', '#EF6A76', '#39A0ED']

export function selectionFields(values: ExcelCellValue[][]): string[] {
  const width = values.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const used = new Map<string, number>()
  return Array.from({ length: width }, (_, index) => {
    const original = cellLabel(values[0]?.[index]) || `Column ${index + 1}`
    const count = used.get(original) ?? 0
    used.set(original, count + 1)
    return count === 0 ? original : `${original} ${count + 1}`
  })
}

export function defaultPivotValueField(values: ExcelCellValue[][]): number {
  const width = selectionFields(values).length
  for (let column = 0; column < width; column += 1) {
    if (values.slice(1).some((row) => finiteNumber(row[column]) !== null)) return column
  }
  return Math.min(1, Math.max(0, width - 1))
}

export function buildPivotTable(values: ExcelCellValue[][], options: ExcelPivotOptions): ExcelPivotResult {
  const fields = selectionFields(values)
  if (fields.length === 0 || values.length < 2) throw new ExcelInsertValidationError('pivot-data-required')
  for (const field of [options.rowField, options.valueField]) {
    if (!Number.isInteger(field) || field < 0 || field >= fields.length) {
      throw new ExcelInsertValidationError('pivot-field-invalid')
    }
  }
  if (options.columnField !== null
    && (!Number.isInteger(options.columnField) || options.columnField < 0 || options.columnField >= fields.length)) {
    throw new ExcelInsertValidationError('pivot-field-invalid')
  }

  const rows = values.slice(1).filter((row) => row.some((cell) => cell !== null && cell !== ''))
  const rowKeys = unique(rows.map((row) => cellLabel(row[options.rowField]) || '(blank)'))
  const columnKeys = options.columnField === null
    ? []
    : unique(rows.map((row) => cellLabel(row[options.columnField!]) || '(blank)'))
  const aggregateLabel = `${aggregateName(options.aggregate)} of ${fields[options.valueField]}`
  const valueFor = (rowKey: string, columnKey?: string) => aggregate(
    rows.filter((row) => {
      const rowMatches = (cellLabel(row[options.rowField]) || '(blank)') === rowKey
      const columnMatches = options.columnField === null
        || (cellLabel(row[options.columnField]) || '(blank)') === columnKey
      return rowMatches && columnMatches
    }).map((row) => row[options.valueField]),
    options.aggregate,
  )

  if (options.columnField === null) {
    const body = rowKeys.map((rowKey) => [rowKey, valueFor(rowKey)])
    return {
      values: [
        [fields[options.rowField]!, aggregateLabel],
        ...body,
        ['Grand Total', aggregate(rows.map((row) => row[options.valueField]), options.aggregate)],
      ],
      numericStartColumn: 1,
    }
  }

  const body = rowKeys.map((rowKey) => {
    const valuesForColumns = columnKeys.map((columnKey) => valueFor(rowKey, columnKey))
    return [
      rowKey,
      ...valuesForColumns,
      aggregate(rows
        .filter((row) => (cellLabel(row[options.rowField]) || '(blank)') === rowKey)
        .map((row) => row[options.valueField]), options.aggregate),
    ]
  })
  const totalRow = [
    'Grand Total',
    ...columnKeys.map((columnKey) => aggregate(rows
      .filter((row) => (cellLabel(row[options.columnField!]) || '(blank)') === columnKey)
      .map((row) => row[options.valueField]), options.aggregate)),
    aggregate(rows.map((row) => row[options.valueField]), options.aggregate),
  ]
  return {
    values: [
      [`${fields[options.rowField]} / ${fields[options.columnField]}`, ...columnKeys, 'Grand Total'],
      ...body,
      totalRow,
    ],
    numericStartColumn: 1,
  }
}

export function buildChartSvg(values: ExcelCellValue[][], type: ExcelChartType): string {
  const data = chartData(values)
  if (data.series.length === 0) throw new ExcelInsertValidationError('chart-data-required')
  const width = 720
  const height = 420
  const title = escapeXml(data.title || 'Chart')
  const background = `<rect width="${width}" height="${height}" rx="16" fill="#FFFFFF"/>`
  const heading = `<text x="32" y="40" fill="#18212F" font-family="Arial,sans-serif" font-size="18" font-weight="700">${title}</text>`
  const legend = data.series.map((series, index) => {
    const x = 32 + index * 116
    return `<rect x="${x}" y="57" width="10" height="10" rx="2" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/><text x="${x + 15}" y="66" fill="#596579" font-family="Arial,sans-serif" font-size="11">${escapeXml(shortLabel(series.name, 13))}</text>`
  }).join('')
  let plot = ''
  if (type === 'pie' || type === 'doughnut') plot = piePlot(data, type === 'doughnut')
  else if (type === 'scatter') plot = scatterPlot(data)
  else plot = cartesianPlot(data, type)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${background}${heading}${legend}${plot}</svg>`
}

export function buildEmptyChartSvg(message: string): string {
  const safeMessage = escapeXml(message)
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="420" viewBox="0 0 720 420"><rect width="720" height="420" rx="16" fill="#FFFFFF"/><rect x="48" y="48" width="624" height="324" rx="12" fill="#F7F9FC" stroke="#DCE2EA" stroke-dasharray="6 6"/><text x="360" y="205" text-anchor="middle" fill="#7C8798" font-family="Arial,sans-serif" font-size="15">${safeMessage}</text><text x="360" y="232" text-anchor="middle" fill="#A1A9B5" font-family="Arial,sans-serif" font-size="11">Bridgic Excel</text></svg>`
}

export function svgDataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg)
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`
}

export function normalizeHyperlinkUrl(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new ExcelInsertValidationError('hyperlink-url-required')
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    throw new ExcelInsertValidationError('hyperlink-invalid')
  }
  if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) {
    throw new ExcelInsertValidationError('hyperlink-protocol-unsupported')
  }
  return parsed.toString()
}

export function excelInsertValidationMessage(cause: unknown, locale: 'en-US' | 'zh-CN'): string | null {
  if (!(cause instanceof ExcelInsertValidationError)) return null
  const messages: Record<ExcelInsertValidationCode, { en: string; zh: string }> = {
    'chart-data-required': {
      en: 'Select a range containing numeric data, then insert the chart again.',
      zh: '请先选中包含数值的数据区域，再插入图表。',
    },
    'hyperlink-invalid': {
      en: 'Enter a valid web or email address.',
      zh: '请输入有效的网页或邮件地址。',
    },
    'hyperlink-protocol-unsupported': {
      en: 'Links can use http, https, or mailto addresses.',
      zh: '链接仅支持 http、https 或 mailto 地址。',
    },
    'hyperlink-url-required': {
      en: 'Enter the address you want to link to.',
      zh: '请输入要链接到的网络地址。',
    },
    'pie-positive-data-required': {
      en: 'Pie charts need at least one numeric value greater than zero.',
      zh: '饼图需要至少一个大于 0 的数值，请调整所选数据。',
    },
    'pivot-data-required': {
      en: 'Select a range with a header row and at least one data row.',
      zh: '请先选择包含标题行和至少一行数据的数据区域。',
    },
    'pivot-field-invalid': {
      en: 'The pivot fields changed. Review the field selection and try again.',
      zh: '数据透视表字段已发生变化，请重新选择后再试。',
    },
    'scatter-data-required': {
      en: 'Scatter charts need numeric X and Y values in at least two columns.',
      zh: '散点图需要至少两列数值，分别作为 X 和 Y 数据。',
    },
  }
  const message = messages[cause.code]
  return locale === 'zh-CN' ? message.zh : message.en
}

interface ChartSeries {
  name: string
  values: Array<number | null>
}

interface ChartData {
  title: string
  categories: string[]
  series: ChartSeries[]
}

function chartData(values: ExcelCellValue[][]): ChartData {
  const rows = trimSelection(values)
  if (rows.length === 0) return { title: '', categories: [], series: [] }
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  const hasHeader = rows.length > 1 && rows[0]!.some((cell, index) => index > 0 && finiteNumber(cell) === null)
  const startRow = hasHeader ? 1 : 0
  const categories = rows.slice(startRow).map((row, index) => cellLabel(row[0]) || String(index + 1))
  const series: ChartSeries[] = []
  const firstNumericColumn = width > 1 ? 1 : 0
  for (let column = firstNumericColumn; column < width; column += 1) {
    const seriesValues = rows.slice(startRow).map((row) => finiteNumber(row[column]))
    if (!seriesValues.some((value) => value !== null)) continue
    series.push({
      name: hasHeader ? cellLabel(rows[0]?.[column]) || `Series ${column + 1}` : `Series ${column + 1 - firstNumericColumn}`,
      values: seriesValues,
    })
  }
  return {
    title: hasHeader ? cellLabel(rows[0]?.[0]) : '',
    categories,
    series,
  }
}

function cartesianPlot(data: ChartData, type: Exclude<ExcelChartType, 'pie' | 'doughnut' | 'scatter'>): string {
  const left = 58
  const top = 92
  const width = 620
  const height = 270
  const allValues = data.series.flatMap((series) => series.values).filter((value): value is number => value !== null)
  const minimum = Math.min(0, ...allValues)
  const maximum = Math.max(0, ...allValues)
  const span = maximum - minimum || 1
  const y = (value: number) => top + height - (value - minimum) / span * height
  const baseline = y(0)
  const grid = Array.from({ length: 5 }, (_, index) => {
    const lineY = top + index * height / 4
    const label = maximum - index * span / 4
    return `<line x1="${left}" x2="${left + width}" y1="${lineY}" y2="${lineY}" stroke="#E5E9F0"/><text x="${left - 8}" y="${lineY + 4}" text-anchor="end" fill="#7C8798" font-family="Arial,sans-serif" font-size="10">${formatNumber(label)}</text>`
  }).join('')
  const labels = data.categories.map((label, index) => {
    const x = left + (index + 0.5) * width / Math.max(1, data.categories.length)
    return `<text x="${x}" y="${top + height + 22}" text-anchor="middle" fill="#6D7889" font-family="Arial,sans-serif" font-size="10">${escapeXml(shortLabel(label, 10))}</text>`
  }).join('')

  if (type === 'bar') {
    const rowHeight = height / Math.max(1, data.categories.length)
    const barHeight = Math.max(4, rowHeight * 0.68 / data.series.length)
    const horizontalScale = (value: number) => left + (value - minimum) / span * width
    const zero = horizontalScale(0)
    const bars = data.series.map((series, seriesIndex) => series.values.map((value, categoryIndex) => {
      if (value === null) return ''
      const x = Math.min(zero, horizontalScale(value))
      const barWidth = Math.abs(horizontalScale(value) - zero)
      const barY = top + categoryIndex * rowHeight + rowHeight * 0.16 + seriesIndex * barHeight
      return `<rect x="${x}" y="${barY}" width="${barWidth}" height="${barHeight - 1}" rx="2" fill="${CHART_COLORS[seriesIndex % CHART_COLORS.length]}"/>`
    }).join('')).join('')
    const categoryLabels = data.categories.map((label, index) => `<text x="${left - 8}" y="${top + (index + 0.55) * rowHeight}" text-anchor="end" fill="#6D7889" font-family="Arial,sans-serif" font-size="10">${escapeXml(shortLabel(label, 9))}</text>`).join('')
    return `${grid}${categoryLabels}<line x1="${zero}" x2="${zero}" y1="${top}" y2="${top + height}" stroke="#9AA5B5"/>${bars}`
  }

  const step = width / Math.max(1, data.categories.length)
  const marks = data.series.map((series, seriesIndex) => {
    const color = CHART_COLORS[seriesIndex % CHART_COLORS.length]
    if (type === 'column') {
      const barWidth = Math.max(4, step * 0.68 / data.series.length)
      return series.values.map((value, categoryIndex) => {
        if (value === null) return ''
        const x = left + categoryIndex * step + step * 0.16 + seriesIndex * barWidth
        const barY = Math.min(baseline, y(value))
        return `<rect x="${x}" y="${barY}" width="${barWidth - 1}" height="${Math.abs(y(value) - baseline)}" rx="2" fill="${color}"/>`
      }).join('')
    }
    const points = series.values.map((value, index) => value === null
      ? null
      : `${left + (index + 0.5) * step},${y(value)}`).filter(Boolean) as string[]
    if (points.length === 0) return ''
    const area = type === 'area'
      ? `<polygon points="${left + 0.5 * step},${baseline} ${points.join(' ')} ${left + (data.categories.length - 0.5) * step},${baseline}" fill="${color}" opacity="0.18"/>`
      : ''
    const dots = points.map((point) => {
      const [x, pointY] = point.split(',')
      return `<circle cx="${x}" cy="${pointY}" r="3" fill="#FFFFFF" stroke="${color}" stroke-width="2"/>`
    }).join('')
    return `${area}<polyline points="${points.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>${dots}`
  }).join('')
  return `${grid}<line x1="${left}" x2="${left + width}" y1="${baseline}" y2="${baseline}" stroke="#9AA5B5"/>${labels}${marks}`
}

function piePlot(data: ChartData, doughnut: boolean): string {
  const series = data.series[0]!
  const slices = series.values.map((value, index) => ({
    label: data.categories[index] ?? String(index + 1),
    value: value === null ? 0 : Math.max(0, value),
  })).filter((slice) => slice.value > 0)
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  if (total === 0) throw new ExcelInsertValidationError('pie-positive-data-required')
  const centerX = 278
  const centerY = 235
  const radius = 120
  let angle = -Math.PI / 2
  const paths = slices.map((slice, index) => {
    const next = angle + slice.value / total * Math.PI * 2
    const large = next - angle > Math.PI ? 1 : 0
    const startX = centerX + Math.cos(angle) * radius
    const startY = centerY + Math.sin(angle) * radius
    const endX = centerX + Math.cos(next) * radius
    const endY = centerY + Math.sin(next) * radius
    const path = `<path d="M ${centerX} ${centerY} L ${startX} ${startY} A ${radius} ${radius} 0 ${large} 1 ${endX} ${endY} Z" fill="${CHART_COLORS[index % CHART_COLORS.length]}" stroke="#FFFFFF" stroke-width="2"/>`
    angle = next
    return path
  }).join('')
  const hole = doughnut ? `<circle cx="${centerX}" cy="${centerY}" r="62" fill="#FFFFFF"/>` : ''
  const labels = slices.map((slice, index) => `<rect x="455" y="${126 + index * 30}" width="11" height="11" rx="2" fill="${CHART_COLORS[index % CHART_COLORS.length]}"/><text x="474" y="${136 + index * 30}" fill="#596579" font-family="Arial,sans-serif" font-size="11">${escapeXml(shortLabel(slice.label, 18))} · ${formatNumber(slice.value / total * 100)}%</text>`).join('')
  return `${paths}${hole}${labels}`
}

function scatterPlot(data: ChartData): string {
  const left = 62
  const top = 92
  const width = 610
  const height = 270
  const xValues = data.series[0]!.values
  const ySeries = data.series.length > 1 ? data.series.slice(1) : data.series
  const validX = xValues.filter((value): value is number => value !== null)
  const validY = ySeries.flatMap((series) => series.values).filter((value): value is number => value !== null)
  if (validX.length === 0 || validY.length === 0) throw new ExcelInsertValidationError('scatter-data-required')
  const xMin = Math.min(...validX)
  const xMax = Math.max(...validX)
  const yMin = Math.min(...validY)
  const yMax = Math.max(...validY)
  const xSpan = xMax - xMin || 1
  const ySpan = yMax - yMin || 1
  const grid = Array.from({ length: 5 }, (_, index) => {
    const x = left + index * width / 4
    const y = top + index * height / 4
    return `<line x1="${x}" x2="${x}" y1="${top}" y2="${top + height}" stroke="#E5E9F0"/><line x1="${left}" x2="${left + width}" y1="${y}" y2="${y}" stroke="#E5E9F0"/>`
  }).join('')
  const dots = ySeries.map((series, seriesIndex) => series.values.map((value, index) => {
    const xValue = xValues[index]
    if (value === null || xValue === null || xValue === undefined) return ''
    const x = left + (xValue - xMin) / xSpan * width
    const y = top + height - (value - yMin) / ySpan * height
    return `<circle cx="${x}" cy="${y}" r="5" fill="${CHART_COLORS[seriesIndex % CHART_COLORS.length]}" opacity="0.82"/>`
  }).join('')).join('')
  return `${grid}<line x1="${left}" x2="${left + width}" y1="${top + height}" y2="${top + height}" stroke="#9AA5B5"/><line x1="${left}" x2="${left}" y1="${top}" y2="${top + height}" stroke="#9AA5B5"/>${dots}`
}

function aggregate(values: Array<ExcelCellValue | undefined>, operation: ExcelPivotAggregate): number {
  if (operation === 'count') return values.filter((value) => value !== null && value !== '' && value !== undefined).length
  const numbers = values.map(finiteNumber).filter((value): value is number => value !== null)
  if (numbers.length === 0) return 0
  if (operation === 'sum') return numbers.reduce((sum, value) => sum + value, 0)
  if (operation === 'average') return numbers.reduce((sum, value) => sum + value, 0) / numbers.length
  if (operation === 'min') return Math.min(...numbers)
  return Math.max(...numbers)
}

function aggregateName(operation: ExcelPivotAggregate): string {
  return { sum: 'Sum', count: 'Count', average: 'Average', min: 'Min', max: 'Max' }[operation]
}

function finiteNumber(value: ExcelCellValue | undefined): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value !== 'string' || value.trim() === '') return null
  const number = Number(value.replaceAll(',', ''))
  return Number.isFinite(number) ? number : null
}

function cellLabel(value: ExcelCellValue | undefined): string {
  if (value === null || value === undefined) return ''
  return String(value).trim()
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function trimSelection(values: ExcelCellValue[][]): ExcelCellValue[][] {
  const rows = values.map((row) => [...row])
  while (rows.length > 0 && rows.at(-1)?.every((cell) => cell === null || cell === '')) rows.pop()
  let width = rows.reduce((maximum, row) => Math.max(maximum, row.length), 0)
  while (width > 0 && rows.every((row) => row[width - 1] === null || row[width - 1] === '' || row[width - 1] === undefined)) width -= 1
  return rows.map((row) => row.slice(0, width))
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  })[character]!)
}

function shortLabel(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(Math.abs(value) < 10 ? 1 : 0)
}
