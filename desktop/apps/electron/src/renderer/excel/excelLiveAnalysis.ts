import type { IRange } from '@univerjs/core'
import type { ExcelChartType, ExcelPivotOptions } from './excelInsert'

export const EXCEL_LIVE_ANALYSIS_CUSTOM_KEY = 'bridgicLiveAnalysis'

interface ExcelLiveBindingBase {
  id: string
  sourceAddress: string
  sourceSheetId: string
}

export interface ExcelLiveChartBinding extends ExcelLiveBindingBase {
  chartType: ExcelChartType
  drawingId: string
  kind: 'chart'
  targetSheetId: string
}

export interface ExcelLivePivotBinding extends ExcelLiveBindingBase {
  kind: 'pivot'
  options: ExcelPivotOptions
  renderedColumns: number
  renderedRows: number
  targetSheetId: string
}

export type ExcelLiveAnalysisBinding = ExcelLiveChartBinding | ExcelLivePivotBinding

export interface ExcelLiveAnalysisState {
  bindings: ExcelLiveAnalysisBinding[]
  version: 1
}

export interface ExcelLiveStructureChange {
  axis: 'column' | 'row'
  kind: 'insert' | 'remove'
  range: Pick<IRange, 'endColumn' | 'endRow' | 'startColumn' | 'startRow'>
  sheetId: string
}

export interface ExcelLiveStructureChangeResult {
  bindingIds: string[]
  state: ExcelLiveAnalysisState
}

export const EMPTY_LIVE_ANALYSIS: ExcelLiveAnalysisState = { bindings: [], version: 1 }

export function readLiveAnalysis(custom: unknown): ExcelLiveAnalysisState {
  if (!isRecord(custom)) return EMPTY_LIVE_ANALYSIS
  const value = custom[EXCEL_LIVE_ANALYSIS_CUSTOM_KEY]
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.bindings)) return EMPTY_LIVE_ANALYSIS
  return {
    version: 1,
    bindings: value.bindings.filter(isLiveBinding),
  }
}

export function withLiveAnalysis(custom: unknown, state: ExcelLiveAnalysisState): Record<string, unknown> {
  return {
    ...(isRecord(custom) ? custom : {}),
    [EXCEL_LIVE_ANALYSIS_CUSTOM_KEY]: state,
  }
}

export function upsertLiveBinding(state: ExcelLiveAnalysisState, binding: ExcelLiveAnalysisBinding): ExcelLiveAnalysisState {
  return {
    version: 1,
    bindings: [...state.bindings.filter((candidate) => candidate.id !== binding.id), binding],
  }
}

export function rangesIntersect(left: IRange, right: IRange): boolean {
  return left.startRow <= right.endRow
    && left.endRow >= right.startRow
    && left.startColumn <= right.endColumn
    && left.endColumn >= right.startColumn
}

/** Keeps custom chart/pivot sources aligned with row and column mutations. */
export function updateLiveAnalysisForStructureChange(
  state: ExcelLiveAnalysisState,
  change: ExcelLiveStructureChange,
): ExcelLiveStructureChangeResult {
  const bindingIds: string[] = []
  const bindings = state.bindings.map((binding) => {
    if (binding.sourceSheetId !== change.sheetId) return binding
    const source = parseAddress(binding.sourceAddress)
    if (!source) return binding
    const transformed = transformAddress(source, change)
    const sourceAddress = serializeAddress(transformed)
    if (sourceAddress === binding.sourceAddress) return binding
    bindingIds.push(binding.id)
    return binding.kind === 'pivot'
      ? { ...binding, sourceAddress, options: { ...binding.options, sourceAddress } }
      : { ...binding, sourceAddress }
  })
  return {
    bindingIds,
    state: bindingIds.length > 0 ? { version: 1, bindings } : state,
  }
}

function parseAddress(address: string): IRange | null {
  const match = /^\$?([A-Z]+)\$?(\d+)(?::\$?([A-Z]+)\$?(\d+))?$/i.exec(address.trim())
  if (!match) return null
  const startColumn = columnIndex(match[1]!)
  const startRow = Number(match[2]) - 1
  const endColumn = match[3] ? columnIndex(match[3]) : startColumn
  const endRow = match[4] ? Number(match[4]) - 1 : startRow
  if (![startColumn, startRow, endColumn, endRow].every((value) => Number.isInteger(value) && value >= 0)) return null
  return { startColumn, startRow, endColumn, endRow }
}

function transformAddress(source: IRange, change: ExcelLiveStructureChange): IRange {
  const sourceStart = change.axis === 'row' ? source.startRow : source.startColumn
  const sourceEnd = change.axis === 'row' ? source.endRow : source.endColumn
  const changeStart = change.axis === 'row' ? change.range.startRow : change.range.startColumn
  const changeEnd = change.axis === 'row' ? change.range.endRow : change.range.endColumn
  const [start, end] = transformInterval(sourceStart, sourceEnd, changeStart, changeEnd, change.kind)
  return change.axis === 'row'
    ? { ...source, startRow: start, endRow: end }
    : { ...source, startColumn: start, endColumn: end }
}

function transformInterval(start: number, end: number, changeStart: number, changeEnd: number, kind: ExcelLiveStructureChange['kind']): [number, number] {
  const count = changeEnd - changeStart + 1
  if (kind === 'insert') {
    if (changeStart <= start) return [start + count, end + count]
    if (changeStart <= end) return [start, end + count]
    return [start, end]
  }
  if (changeEnd < start) return [Math.max(0, start - count), Math.max(0, end - count)]
  if (changeStart > end) return [start, end]
  const nextStart = start >= changeStart ? changeStart : start
  const nextEnd = end > changeEnd ? end - count : changeStart - 1
  if (nextEnd >= nextStart) return [nextStart, nextEnd]
  // Prefer a surviving neighbor when the whole source interval was removed.
  // A deletion at the last sheet row/column would otherwise leave an out-of-bounds address.
  const collapsed = Math.max(0, changeStart - 1)
  return [collapsed, collapsed]
}

function columnIndex(label: string): number {
  let index = 0
  for (const character of label.toUpperCase()) index = index * 26 + character.charCodeAt(0) - 64
  return index - 1
}

function columnLabel(index: number): string {
  let value = index + 1
  let label = ''
  while (value > 0) {
    value -= 1
    label = String.fromCharCode(65 + value % 26) + label
    value = Math.floor(value / 26)
  }
  return label
}

function serializeAddress(range: IRange): string {
  const start = `${columnLabel(range.startColumn)}${range.startRow + 1}`
  const end = `${columnLabel(range.endColumn)}${range.endRow + 1}`
  return start === end ? start : `${start}:${end}`
}

function isLiveBinding(value: unknown): value is ExcelLiveAnalysisBinding {
  if (!isRecord(value)
    || typeof value.id !== 'string'
    || typeof value.sourceAddress !== 'string' || !parseAddress(value.sourceAddress)
    || typeof value.sourceSheetId !== 'string'
    || typeof value.targetSheetId !== 'string') return false
  if (value.kind === 'chart') {
    return typeof value.drawingId === 'string'
      && typeof value.chartType === 'string'
      && ['column', 'bar', 'line', 'area', 'pie', 'doughnut', 'scatter'].includes(value.chartType)
  }
  if (value.kind !== 'pivot'
    || !isRecord(value.options)
    || typeof value.renderedRows !== 'number'
    || typeof value.renderedColumns !== 'number') return false
  return typeof value.options.sourceAddress === 'string'
    && typeof value.options.rowField === 'number'
    && (value.options.columnField === null || typeof value.options.columnField === 'number')
    && typeof value.options.valueField === 'number'
    && ['sum', 'count', 'average', 'min', 'max'].includes(String(value.options.aggregate))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}
